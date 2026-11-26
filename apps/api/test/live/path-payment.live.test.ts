import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { matchPayment, type AssetRef, type NormalizedPayment, type PaymentLink } from "@checkout/core";
import { HorizonWatcher } from "@checkout/stellar";
import type { Container } from "../../src/services/container";
import { linkRoutes } from "../../src/routes/links";
import { publicRoutes } from "../../src/routes/public";
import {
  buildPathPayment,
  calculateSendMax,
  fundWithFriendbot,
  HORIZON_TESTNET_URL,
  seedMarket,
} from "./path-payment-builder";

/**
 * Live testnet end-to-end path payment probe (issue 5.51).
 *
 * This is the gate for turning `PATH_PAYMENTS_ENABLED` on in production: a
 * buyer pays a USDC link with XLM through the SDEX, and the claim is only
 * allowed once this job passes. That only means something if the probe fails
 * when the real flow breaks, so every stage drives the API and asserts the
 * API's answer. Nothing here falls back to Horizon, and nothing classifies
 * Horizon's errors itself: a stage that cannot be asserted against the API is
 * skipped, with the issue that lands its dependency named, the way the refund
 * probe skips on a missing route.
 *
 * Stages:
 *  1. seed-market — throwaway issuer, funded market maker, SDEX sell offer at a
 *     fixed 2 XLM per USDC, so the probe never depends on public liquidity and
 *     survives testnet resets.
 *  2. participants — the seller can receive USDC; the buyer holds XLM only.
 *  3. boot-api — the real container boots from the env (path payments on, a
 *     throwaway SQLite database), the real routes are mounted, and a 10 USDC
 *     link exists.
 *  4. pay-options — `GET /links/:id/pay-options` offers XLM for the 10 USDC,
 *     at the seeded price. Needs #548 (`GET /links/:id/pay-options`).
 *  5. price-moved — `POST /links/:id/submit` refuses a `sendMax` far above the
 *     price the API just quoted and says `reason: price_moved`. Needs #549
 *     (relaying a validated `path_payment_strict_receive`).
 *  6. path-payment-and-watcher — `POST /links/:id/submit` relays the quoted
 *     path payment, the watcher matches it, and the link is paid 10 USDC.
 *     Also needs #549.
 *  7. paid-with — `GET /r/:reference` reports `paidWith` XLM, the way the
 *     buyer's receipt shows it. Needs #550 (record what the buyer paid with)
 *     and the source-side normalization from #548.
 *
 * Gated behind `RUN_LIVE_PATH_TESTS=1`: without it the whole file is skipped,
 * never failed, so ordinary test runs stay offline.
 */

const LIVE_PATH = process.env.RUN_LIVE_PATH_TESTS === "1";

/** The link the buyer pays: 10 USDC. */
const LINK_AMOUNT = "10";
/** The seeded SDEX offer's price: 1 USDC = 2 XLM. */
const PRICE = "2";
/** Per-stage timeout; testnet ledger inclusion and Friendbot are both slow. */
const TIMEOUT = 120_000;
/** The signed transaction stays inside the quote's lifetime plus its grace. */
const TX_LIFETIME_MS = 20_000;
/** How long the watcher is given to see the payment on the ledger. */
const MATCH_TIMEOUT_MS = 45_000;

/** One way to pay the link, as `GET /links/:id/pay-options` returns it. */
interface PayOption {
  sourceAsset: AssetRef;
  sourceAmount: string;
  sendMax: string;
  path: AssetRef[];
  quotedAt: number;
  expiresAt: number;
}

/** The body of `GET /links/:id/pay-options` (issue 4.64 / #548). */
interface PayOptions {
  linkAsset: AssetRef;
  amount: string;
  options: PayOption[];
}

/** The fields of the public receipt this probe asserts. */
interface PublicReceipt {
  reference: string;
  status: string;
  amount: string;
  asset: AssetRef;
  paidAmount?: string | null;
  /** Absent until #550 lands; `null` when every payment on the link was plain. */
  paidWith?: Array<{ asset: AssetRef; amount: string }> | null;
}

/**
 * Boot the production container against a throwaway database, with the env the
 * probe needs. `src/env.ts` is read at import, so the module graph is reset and
 * re-imported after the env is set; this is how `anchors-boot.test.ts` boots it.
 */
async function bootContainer(overrides: Record<string, string>): Promise<Container> {
  Object.assign(process.env, overrides);
  vi.resetModules();
  const { createContainer } = await import("../../src/services/container");
  return createContainer();
}

/**
 * Mark a stage skipped and stop it. `t.skip()` throws to do that, but its type
 * says void, so this wrapper (returning never) is what lets the checker narrow
 * after it.
 */
function skip(t: { skip: (message?: string) => void }, message: string): never {
  t.skip(message);
  throw new Error(`unreachable after t.skip(): ${message}`);
}

describe.skipIf(!LIVE_PATH)("Path payment live testnet (live)", () => {
  const horizon = new Horizon.Server(HORIZON_TESTNET_URL);

  let issuer: Keypair;
  let marketMaker: Keypair;
  let usdcAsset: Asset;

  let sellerKey: Keypair;
  let buyerKey: Keypair;

  let container: Container;
  let app: Hono;
  let databaseDir = "";
  const originalEnv = { ...process.env };

  let link: PaymentLink;
  let quote: PayOption;

  /** The stages, in order. The first one not reached is where the probe broke. */
  const STAGES = [
    "seed-market",
    "participants",
    "boot-api",
    "pay-options",
    "price-moved",
    "path-payment-and-watcher",
    "paid-with",
  ] as const;
  type Stage = (typeof STAGES)[number];
  let lastCompleted: Stage | null = null;

  /** A stage whose predecessor did not complete is skipped, so the first red test names where it broke. */
  const after = (previous: Stage, skipNow: () => void): void => {
    if (lastCompleted !== previous) skipNow();
  };
  const done = (stage: Stage): void => {
    lastCompleted = stage;
  };

  const api = async (path: string, init?: RequestInit): Promise<Response> =>
    await app.request(path, init);

  /** Assert a status, including the body in the failure message. */
  async function expectStatus(res: Response, status: number): Promise<void> {
    if (res.status !== status) {
      throw new Error(`expected HTTP ${status}, got ${res.status}: ${await res.text()}`);
    }
  }

  /** A JSON POST as the checkout sends it. */
  const postJson = (path: string, body: unknown): Promise<Response> =>
    api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /**
   * The pre-#549 refusal. Submit only accepted a single plain payment, so it
   * answered 400 with this message for a path payment. Recognising it is how a
   * stage says "the relay is not on dev yet" instead of asserting against it.
   */
  const isPathPaymentsNotRelayedYet = (status: number, body: { error?: string }): boolean =>
    status === 400 && /single payment operation/i.test(body.error ?? "");

  afterAll(async () => {
    await container?.stop();
    process.env = originalEnv;
    if (databaseDir) rmSync(databaseDir, { recursive: true, force: true });
  });

  it(
    "stage 1/7 seed-market: throwaway issuer, funded market maker and an SDEX sell offer",
    async () => {
      const seeded = await seedMarket(horizon, PRICE, "1000", "500");
      issuer = seeded.issuer;
      marketMaker = seeded.marketMaker;
      usdcAsset = seeded.usdcAsset;

      expect(usdcAsset.getCode()).toBe("USDC");
      expect(usdcAsset.getIssuer()).toBe(issuer.publicKey());
      expect(marketMaker.publicKey()).toBeTruthy();
      done("seed-market");
    },
    TIMEOUT,
  );

  it(
    "stage 2/7 participants: seller holds a USDC trustline and the buyer holds XLM only",
    async (t) => {
      after("seed-market", () => t.skip());
      sellerKey = Keypair.random();
      buyerKey = Keypair.random();
      await Promise.all([
        fundWithFriendbot(sellerKey.publicKey()),
        fundWithFriendbot(buyerKey.publicKey()),
      ]);

      const sellerAccount = await horizon.loadAccount(sellerKey.publicKey());
      const trust = new TransactionBuilder(sellerAccount, {
        fee: "10000",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.changeTrust({ asset: usdcAsset }))
        .setTimeout(60)
        .build();
      trust.sign(sellerKey);
      await horizon.submitTransaction(trust);

      // The buyer pays with XLM, so it must not already hold the USDC it is
      // buying: the payment has to go through the market, not out of a balance.
      const buyerAccount = await horizon.loadAccount(buyerKey.publicKey());
      expect(
        buyerAccount.balances.find(
          (balance) =>
            "asset_code" in balance &&
            balance.asset_code === "USDC" &&
            balance.asset_issuer === issuer.publicKey(),
        ),
      ).toBeUndefined();
      done("participants");
    },
    TIMEOUT,
  );

  it(
    "stage 3/7 boot-api: the real API boots with path payments on and a 10 USDC link exists",
    async (t) => {
      after("participants", () => t.skip());
      databaseDir = mkdtempSync(join(tmpdir(), "quay-path-probe-"));
      container = await bootContainer({
        STELLAR_NETWORK: "testnet",
        DATABASE_URL: `file:${join(databaseDir, "quay.db")}`,
        KYC_ENCRYPTION_KEY: "0".repeat(64),
        WEBHOOK_SECRET_ENCRYPTION_KEY: "1".repeat(64),
        OFFRAMP: "mock",
        USDC_ISSUER_TESTNET: issuer.publicKey(),
        // The switch the probe exists to gate. Without it the API refuses every
        // path payment stage below, so a probe run that cannot turn it on would
        // be testing the off-switch.
        PATH_PAYMENTS_ENABLED: "1",
        PATH_PAYMENTS_SOURCE_ASSETS: "native",
      });

      app = new Hono();
      // The real routes, mounted the way src/index.ts mounts them. The strict
      // limiter is a pass-through: rate limiting is not what this probe tests.
      app.route("/links", linkRoutes(container, async (_c, next) => next()));
      app.route("/r", publicRoutes(container));

      const seller = await container.sellers.createIfAbsent(sellerKey.publicKey());
      const created = await container.service.createLink(seller.id, {
        amount: LINK_AMOUNT,
        assetCode: "USDC",
        title: "Testnet live path payment probe",
      });
      link = created.link;

      expect(link.amount).toBe(LINK_AMOUNT);
      expect(link.asset.code).toBe("USDC");
      expect(link.asset.issuer).toBe(issuer.publicKey());
      expect(link.destination).toBe(sellerKey.publicKey());

      // The mounted API answers for that link before anything is paid.
      const res = await api(`/links/${link.id}`);
      await expectStatus(res, 200);
      const body = (await res.json()) as { link: { id: string; status: string } };
      expect(body.link.id).toBe(link.id);
      expect(body.link.status).toBe("active");
      done("boot-api");
    },
    TIMEOUT,
  );

  it(
    "stage 4/7 pay-options: GET /links/:id/pay-options offers XLM for the 10 USDC at the seeded price",
    async (t) => {
      after("boot-api", () => t.skip());
      const res = await api(`/links/${link.id}/pay-options?account=${buyerKey.publicKey()}`);
      if (res.status === 404) {
        skip(
          t,
          "GET /links/:id/pay-options is not on dev yet, so there is no quote to pay against (#548).",
        );
      }
      // Any other answer is the server failing at the thing this stage exists
      // to check, so it fails the probe rather than skipping or re-quoting
      // against Horizon behind the API's back.
      await expectStatus(res, 200);
      const body = (await res.json()) as PayOptions;

      expect(Number(body.amount)).toBeCloseTo(Number(LINK_AMOUNT), 7);
      expect(body.linkAsset).toEqual({ code: "USDC", issuer: issuer.publicKey() });

      const xlm = body.options.find(
        (option) => option.sourceAsset.code === "XLM" && option.sourceAsset.issuer === null,
      );
      if (!xlm) {
        throw new Error(
          `pay-options offered no XLM option (${JSON.stringify(body.options)}) even though the probe seeded an XLM/USDC market`,
        );
      }
      // The seeded offer sells USDC at exactly 2 XLM, straight, so the quote is
      // the price and the path is empty.
      expect(Number(xlm.sourceAmount)).toBeCloseTo(Number(LINK_AMOUNT) * Number(PRICE), 5);
      expect(Number(xlm.sendMax)).toBeGreaterThanOrEqual(Number(xlm.sourceAmount));
      expect(xlm.path).toEqual([]);
      expect(xlm.expiresAt).toBeGreaterThan(Date.now());

      quote = xlm;
      done("pay-options");
    },
    TIMEOUT,
  );

  it(
    "stage 5/7 price-moved: POST /links/:id/submit refuses a sendMax far above the quote and says price_moved",
    async (t) => {
      after("pay-options", () => t.skip());
      const buyerAccount = await horizon.loadAccount(buyerKey.publicKey());
      // Twice the quoted cost: far above the slippage the API allows on top of
      // a quote, which is what a stale quote turns into for a buyer.
      const overpricedSendMax = calculateSendMax(quote.sourceAmount, 10_000);
      const tx = buildPathPayment({
        sourceAccount: buyerKey.publicKey(),
        sequence: buyerAccount.sequence,
        destination: sellerKey.publicKey(),
        destAsset: { code: "USDC", issuer: issuer.publicKey() },
        destAmount: `${LINK_AMOUNT}.0000000`,
        sendAsset: { code: "XLM", issuer: null },
        sendMax: overpricedSendMax,
        path: [],
        memo: link.reference,
        expiresAt: Date.now() + TX_LIFETIME_MS,
      });
      tx.sign(buyerKey);

      const res = await postJson(`/links/${link.id}/submit`, { signedXdr: tx.toXDR() });
      const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
      if (res.status === 404) {
        skip(t, "POST /links/:id/submit is missing, so nothing relays a path payment (#549).");
      }
      if (isPathPaymentsNotRelayedYet(res.status, body)) {
        skip(
          t,
          `the API does not relay path payments on dev yet (#549), so it has no price to hold sendMax to. Got ${res.status}: ${body.error}`,
        );
      }

      // The server's own reason, not one re-derived from a Horizon error.
      expect({ status: res.status, error: body.error, reason: body.reason }).toEqual({
        status: 409,
        error: "payment_rejected",
        reason: "price_moved",
      });
      done("price-moved");
    },
    TIMEOUT,
  );

  it(
    "stage 6/7 path-payment-and-watcher: submit relays the quoted path payment, the watcher marks the link paid at exactly 10 USDC",
    async (t) => {
      after("price-moved", () => t.skip());
      const buyerAccount = await horizon.loadAccount(buyerKey.publicKey());
      const tx = buildPathPayment({
        sourceAccount: buyerKey.publicKey(),
        sequence: buyerAccount.sequence,
        destination: sellerKey.publicKey(),
        destAsset: { code: "USDC", issuer: issuer.publicKey() },
        destAmount: `${LINK_AMOUNT}.0000000`,
        sendAsset: { code: "XLM", issuer: null },
        sendMax: quote.sendMax,
        path: [],
        memo: link.reference,
        expiresAt: Date.now() + TX_LIFETIME_MS,
      });
      tx.sign(buyerKey);

      const res = await postJson(`/links/${link.id}/submit`, { signedXdr: tx.toXDR() });
      const body = (await res.json().catch(() => ({}))) as { error?: string; txHash?: string };
      if (res.status === 404) {
        skip(t, "POST /links/:id/submit is missing, so nothing relays a path payment (#549).");
      }
      if (isPathPaymentsNotRelayedYet(res.status, body)) {
        skip(
          t,
          `the API does not relay path payments on dev yet (#549). Got ${res.status}: ${body.error}`,
        );
      }
      await expectStatus(res, 200);
      const txHash = body.txHash;
      expect(txHash).toMatch(/^[0-9a-f]{64}$/);

      // The watcher owns the paid transition. This process runs no server, so
      // it drives Horizon's payments feed itself and applies the match.
      const watcher = new HorizonWatcher({ primaryServer: HORIZON_TESTNET_URL });
      let payment: NormalizedPayment | null = null;
      const deadline = Date.now() + MATCH_TIMEOUT_MS;
      while (!payment && Date.now() < deadline) {
        for (const candidate of await watcher.fetchSince(sellerKey.publicKey(), "")) {
          if (candidate.txHash !== txHash) continue;
          const outcome = matchPayment(candidate, (reference) =>
            reference === link.reference ? link : undefined,
          );
          if (outcome.kind === "paid") {
            await container.service.applyMatch(candidate, outcome);
            payment = candidate;
            break;
          }
        }
        if (!payment) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      if (!payment) {
        throw new Error(`the watcher did not see ${txHash} pay ${link.reference} within ${MATCH_TIMEOUT_MS}ms`);
      }

      const paid = await api(`/links/${link.id}`);
      await expectStatus(paid, 200);
      const { link: updated } = (await paid.json()) as {
        link: { status: string; paidAmount?: string | null; asset: AssetRef };
      };
      expect(updated.status).toBe("paid");
      expect(Number(updated.paidAmount)).toBeCloseTo(Number(LINK_AMOUNT), 7);
      expect(updated.asset).toEqual({ code: "USDC", issuer: issuer.publicKey() });
      done("path-payment-and-watcher");
    },
    TIMEOUT + MATCH_TIMEOUT_MS,
  );

  it(
    "stage 7/7 paid-with: GET /r/:reference reports the buyer paid with XLM",
    async (t) => {
      after("path-payment-and-watcher", () => t.skip());
      const res = await api(`/r/${link.reference}`);
      await expectStatus(res, 200);
      const receipt = (await res.json()) as PublicReceipt;

      expect(receipt.status).toBe("paid");
      expect(Number(receipt.paidAmount)).toBeCloseTo(Number(LINK_AMOUNT), 7);

      // The receipt is the buyer-facing answer to "what did I pay with", so it
      // is the only source this stage accepts. Reading the operation off
      // Horizon would pass even if the API recorded and showed nothing.
      if (!("paidWith" in receipt)) {
        skip(
          t,
          "the public receipt has no paidWith yet: #550 (record what the buyer paid with) and the source-side normalization from #548 are not on dev.",
        );
      }
      expect(receipt.paidWith).not.toBeNull();
      const entries = receipt.paidWith ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0]!.asset).toEqual({ code: "XLM", issuer: null });
      expect(Number(entries[0]!.amount)).toBeCloseTo(Number(LINK_AMOUNT) * Number(PRICE), 5);
      done("paid-with");
    },
    TIMEOUT,
  );
});
