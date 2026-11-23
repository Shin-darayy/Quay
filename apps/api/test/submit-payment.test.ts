import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { XLM, type AssetRef, type RailPort, type Seller, type SellerRepository } from "@checkout/core";
import { sendMaxFor, type StellarConfig } from "@checkout/stellar";
import { HttpError, LinkService } from "../src/services/link-service";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeTelemetryRepository,
  FakeWebhookRepository,
  ScriptedOffRamp,
  makeLink,
} from "./fakes";
import { StubHorizon, horizonError, pathRecordsTo } from "./path-payment-fakes";
import type { PathPaymentsConfig } from "../src/path-payments";

// ---------------------------------------------------------------------------
//  POST /links/:id/submit — validating a wallet-signed XDR (issue #31).
//
//  The buyer signs locally and we only relay, so the envelope is entirely
//  attacker-controlled. Every test here is a rejection: the point of the
//  endpoint is what it refuses to pass on to Horizon.
//
//  None of these reach the network — each assertion fires before submission.
// ---------------------------------------------------------------------------

const DEST = Keypair.random().publicKey();
const BUYER = Keypair.random();
const ATTACKER = Keypair.random();
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", ISSUER);

const stellar: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  usdcIssuer: ISSUER,
};

const seller: Seller = { id: "sel_1", name: "S", wallet: DEST, profileKind: "individual", payoutFields: null, createdAt: 0 };
const sellers: SellerRepository = {
  async findById() { return seller; },
  async findByWallet() { return seller; },
  async createIfAbsent() { return seller; },
  async savePayoutFields() {},
  async saveProfileKind() {},
};
const rail: RailPort = {
  buildRequest: () => ({ uri: "web+stellar:pay", destination: DEST, amount: "10", asset: { code: "USDC", issuer: ISSUER }, memo: "r" }),
  isValidDestination: () => true,
  async assertCanReceive() {},
};

let links: FakeLinkRepository;
let service: LinkService;

beforeEach(async () => {
  links = new FakeLinkRepository();
  service = new LinkService({
    links,
    sellers,
    webhooks: new FakeWebhookRepository(),
    rail,
    offramp: new ScriptedOffRamp(),
    offrampState: new FakeOffRampStateRepository(),
    kyc: new AlwaysAcceptedKyc(),
    telemetry: new FakeTelemetryRepository(),
    stellar,
    correlation: "memo",
  });
  await links.save(
    makeLink({
      id: "lnk_1",
      reference: "pl_ref1",
      status: "active",
      txHash: null,
      paidAmount: null,
      destination: DEST,
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
    }),
  );
});

/** Builds a signed envelope, defaulting to the exact payment the link asks for. */
function build(
  ops: Parameters<TransactionBuilder["addOperation"]>[0][] = [
    Operation.payment({ destination: DEST, asset: USDC, amount: "10" }),
  ],
  memo: Memo = Memo.text("pl_ref1"),
): string {
  const source = new Account(BUYER.publicKey(), "1");
  const builder = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.addMemo(memo).setTimeout(300).build();
  tx.sign(BUYER);
  return tx.toXDR();
}

async function expectRejected(xdr: string, status: number, match: RegExp) {
  await expect(service.submitPayment("lnk_1", xdr)).rejects.toThrow(match);
  await service.submitPayment("lnk_1", xdr).catch((err) => {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
  });
}

describe("submitPayment — envelope validation", () => {
  // The one that matters most. An envelope whose FIRST operation is exactly the
  // payment we asked for, followed by anything at all. Validating operations[0]
  // and relaying the envelope would submit every one of them.
  it("rejects a second operation hidden behind a valid payment", async () => {
    const xdr = build([
      Operation.payment({ destination: DEST, asset: USDC, amount: "10" }),
      Operation.payment({ destination: ATTACKER.publicKey(), asset: USDC, amount: "1000" }),
    ]);
    await expectRejected(xdr, 400, /exactly one operation, got 2/);
  });

  it("rejects a trailing setOptions that would add a signer", async () => {
    const xdr = build([
      Operation.payment({ destination: DEST, asset: USDC, amount: "10" }),
      Operation.setOptions({ signer: { ed25519PublicKey: ATTACKER.publicKey(), weight: 255 } }),
    ]);
    await expectRejected(xdr, 400, /exactly one operation/);
  });

  it("rejects a trailing accountMerge", async () => {
    const xdr = build([
      Operation.payment({ destination: DEST, asset: USDC, amount: "10" }),
      Operation.accountMerge({ destination: ATTACKER.publicKey() }),
    ]);
    await expectRejected(xdr, 400, /exactly one operation/);
  });

  it("rejects a non-payment operation", async () => {
    const xdr = build([Operation.changeTrust({ asset: USDC })]);
    await expectRejected(xdr, 400, /single payment operation, got "changeTrust"/);
  });

  it("rejects an operation-level source override", async () => {
    const xdr = build([
      Operation.payment({ destination: DEST, asset: USDC, amount: "10", source: ATTACKER.publicKey() }),
    ]);
    await expectRejected(xdr, 400, /must not override the transaction source/);
  });

  it("rejects a wrong destination", async () => {
    const xdr = build([Operation.payment({ destination: ATTACKER.publicKey(), asset: USDC, amount: "10" })]);
    await expectRejected(xdr, 409, /destination does not match/);
  });

  it("rejects a wrong asset", async () => {
    const xdr = build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: "10" })]);
    await expectRejected(xdr, 409, /Asset mismatch/);
  });

  it("rejects an asset with the right code but a different issuer", async () => {
    const impostor = new Asset("USDC", ATTACKER.publicKey());
    const xdr = build([Operation.payment({ destination: DEST, asset: impostor, amount: "10" })]);
    await expectRejected(xdr, 409, /Asset mismatch/);
  });

  it("rejects an underpayment", async () => {
    const xdr = build([Operation.payment({ destination: DEST, asset: USDC, amount: "9.9999999" })]);
    await expectRejected(xdr, 409, /Amount too low/);
  });

  it("rejects a mismatched memo", async () => {
    const xdr = build(undefined, Memo.text("someone_elses_ref"));
    await expectRejected(xdr, 409, /memo does not match/i);
  });

  it("rejects a missing memo", async () => {
    const xdr = build(undefined, Memo.none());
    await expectRejected(xdr, 409, /memo does not match/i);
  });

  it("rejects a MEMO_ID where MEMO_TEXT was required", async () => {
    // The reference is a text memo. An id memo that happens to stringify
    // similarly must not be accepted as correlation.
    const xdr = build(undefined, Memo.id("12345"));
    await expectRejected(xdr, 409, /memo does not match/i);
  });

  // Signature authenticity — including which network it was signed for — is
  // Horizon's to decide, and it is authoritative. This layer owns the envelope's
  // *contents*: what the transaction would do if it were valid. A pubnet-signed
  // envelope parses cleanly against the testnet passphrase (the XDR carries no
  // network), passes every content check, and is then rejected on submission for
  // a bad signature. Asserting a local rejection here would be asserting
  // signature verification this service deliberately does not duplicate.

  it("rejects malformed XDR", async () => {
    await expectRejected("not-base64-xdr", 400, /invalid_xdr/);
  });

  it("404s an unknown link", async () => {
    await expect(service.submitPayment("lnk_nope", build())).rejects.toThrow(/Link not found/);
  });

  it("409s a link that is no longer open", async () => {
    await links.save(makeLink({ id: "lnk_1", reference: "pl_ref1", status: "paid", destination: DEST }));
    await expect(service.submitPayment("lnk_1", build())).rejects.toThrow(/cannot accept payment/);
  });
});

// ---------------------------------------------------------------------------
//  Path payments (issue 4.65). While paying with another asset is switched on,
//  a strict-receive path payment is a second accepted shape. Every check a
//  plain payment gets applies to what it delivers, and its source side gets
//  checks of its own: the asset, the path, the expiry and `sendMax`.
//
//  Horizon is a stub for the quote, and `submitTransaction` is replaced, so
//  nothing here reaches the network either.
// ---------------------------------------------------------------------------

describe("submitPayment — path payments", () => {
  const NOW = 1_763_560_000_000;
  const NOW_S = NOW / 1000;
  const TTL_MS = 30_000;
  const EURC_ISSUER = Keypair.random().publicKey();
  const EURC = new Asset("EURC", EURC_ISSUER);
  const EURC_REF: AssetRef = { code: "EURC", issuer: EURC_ISSUER };
  const USDC_REF: AssetRef = { code: "USDC", issuer: ISSUER };
  const pathRecord = pathRecordsTo(USDC_REF);
  // 24.1234567 XLM is what the stub quotes for 10 USDC. A checkout adds 1% to
  // it; the server allows twice that, and not one stroop more.
  const QUOTED = "24.1234567";
  const SEND_MAX = sendMaxFor(QUOTED, 100);
  const LIMIT = sendMaxFor(QUOTED, 200);

  let horizon: StubHorizon;
  let relayed: Transaction[];

  function withPaths(over: Partial<PathPaymentsConfig> = {}): LinkService {
    return new LinkService({
      links,
      sellers,
      webhooks: new FakeWebhookRepository(),
      rail,
      offramp: new ScriptedOffRamp(),
      offrampState: new FakeOffRampStateRepository(),
      kyc: new AlwaysAcceptedKyc(),
      telemetry: new FakeTelemetryRepository(),
      stellar,
      correlation: "memo",
      pathPayments: {
        enabled: true,
        maxSlippageBps: 100,
        sourceAssets: [XLM],
        quoteTtlMs: TTL_MS,
        horizon,
        now: () => NOW,
        ...over,
      },
    });
  }

  type PathOp = Parameters<typeof Operation.pathPaymentStrictReceive>[0];

  /**
   * A signed envelope with one strict-receive path payment: by default exactly
   * what a correct checkout builds for the link, expiring with its quote.
   */
  function buildPath(
    over: Partial<PathOp> = {},
    env: { maxTime?: number; memo?: Memo; extra?: Parameters<TransactionBuilder["addOperation"]>[0][] } = {},
  ): string {
    const source = new Account(BUYER.publicKey(), "1");
    const builder = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: 0, maxTime: env.maxTime ?? NOW_S + TTL_MS / 1000 },
    });
    builder.addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: SEND_MAX,
        destination: DEST,
        destAsset: USDC,
        destAmount: "10",
        path: [],
        ...over,
      }),
    );
    for (const op of env.extra ?? []) builder.addOperation(op);
    const tx = builder.addMemo(env.memo ?? Memo.text("pl_ref1")).build();
    tx.sign(BUYER);
    return tx.toXDR();
  }

  /** The HttpError a submit is refused with. Fails the test if it is relayed or fails another way. */
  async function refused(service: LinkService, xdr: string, linkId = "lnk_1"): Promise<HttpError> {
    const err = await service.submitPayment(linkId, xdr).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(relayed).toEqual([]);
    return err as HttpError;
  }

  beforeEach(() => {
    horizon = new StubHorizon();
    horizon.records = [pathRecord(XLM, QUOTED)];
    relayed = [];
    vi.spyOn(Horizon.Server.prototype, "submitTransaction").mockImplementation(async (tx) => {
      relayed.push(tx as Transaction);
      return { hash: "tx_relayed" } as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("relays a strict-receive path payment that is what the link asks for, and does not mark the link paid", async () => {
    const result = await withPaths().submitPayment("lnk_1", buildPath());
    expect(result).toEqual({ txHash: "tx_relayed" });
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.operations[0]!.type).toBe("pathPaymentStrictReceive");

    // The watcher still owns `paid`: nothing here touched the link.
    expect(await links.findById("lnk_1")).toMatchObject({ status: "active", paidAmount: null, txHash: null });

    // One fresh quote, from the source asset alone, for what the transaction delivers.
    expect(horizon.calls).toHaveLength(1);
    const asked = horizon.calls[0]!;
    expect((asked.source as Asset[]).map((a) => a.isNative())).toEqual([true]);
    expect([asked.destination.getCode(), asked.destination.getIssuer(), asked.amount]).toEqual(["USDC", ISSUER, "10"]);
  });

  it("with the switch off, refuses a path payment exactly as before", async () => {
    // `service` is the one every test above uses: it has no path payment settings at all.
    for (const off of [service, withPaths({ enabled: false })]) {
      const err = await refused(off, buildPath());
      expect([err.status, err.message]).toEqual([
        400,
        'Transaction must be a single payment operation, got "pathPaymentStrictReceive"',
      ]);
    }
    expect(horizon.calls).toEqual([]);
  });

  it("with the switch on, still relays a plain payment, and asks for no quote", async () => {
    const result = await withPaths().submitPayment("lnk_1", build());
    expect(result).toEqual({ txHash: "tx_relayed" });
    expect(relayed[0]!.operations[0]!.type).toBe("payment");
    expect(horizon.calls).toEqual([]);
  });

  it("refuses a strict-send path payment, which can deliver less than the link asks for", async () => {
    const strictSend = build([
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: "24",
        destination: DEST,
        destAsset: USDC,
        destMin: "10",
        path: [],
      }),
    ]);
    const on = await refused(withPaths(), strictSend);
    expect(on.status).toBe(400);
    expect(on.message).toMatch(/got "pathPaymentStrictSend": a strict-send path payment can deliver less/);
    // Off, it is one more operation that is not a payment.
    const off = await refused(service, strictSend);
    expect([off.status, off.message]).toEqual([
      400,
      'Transaction must be a single payment operation, got "pathPaymentStrictSend"',
    ]);
    expect(horizon.calls).toEqual([]);
  });

  it("holds what a path payment delivers to every check a plain payment gets", async () => {
    const otherUsdc = new Asset("USDC", ATTACKER.publicKey());
    const cases: [string, string, number, RegExp][] = [
      ["a wrong destination", buildPath({ destination: ATTACKER.publicKey() }), 409, /destination does not match/],
      ["a wrong destination asset", buildPath({ destAsset: EURC }), 409, /Asset mismatch: link expects USDC, transaction sends EURC/],
      ["the right code under another issuer", buildPath({ destAsset: otherUsdc }), 409, /Asset mismatch/],
      ["less than the link asks for", buildPath({ destAmount: "9.9999999" }), 409, /Amount too low: link expects 10/],
      ["a wrong memo", buildPath({}, { memo: Memo.text("pl_other") }), 409, /memo does not match/],
      ["no memo", buildPath({}, { memo: Memo.none() }), 409, /memo does not match/],
      ["an operation-level source", buildPath({ source: ATTACKER.publicKey() }), 400, /must not override the transaction source/],
      [
        "a second operation behind it",
        buildPath({}, { extra: [Operation.payment({ destination: ATTACKER.publicKey(), asset: USDC, amount: "1000" })] }),
        400,
        /exactly one operation, got 2/,
      ],
    ];
    for (const [what, xdr, status, message] of cases) {
      const err = await refused(withPaths(), xdr);
      expect([what, err.status]).toEqual([what, status]);
      expect(err.message).toMatch(message);
    }
    // None of them got as far as asking Horizon for a price.
    expect(horizon.calls).toEqual([]);
  });

  it("asks an underpaid link's path payment for what is still owed, not for the whole amount", async () => {
    await links.save(
      makeLink({ id: "lnk_under", reference: "pl_ref1", status: "underpaid", txHash: null, paidAmount: "4", destination: DEST, amount: "10", asset: USDC_REF }),
    );
    horizon.records = [pathRecord(XLM, "14.5", [], "6")];
    const short = await refused(withPaths(), buildPath({ destAmount: "5.9999999", sendMax: "14.6" }), "lnk_under");
    expect([short.status, short.message]).toEqual([409, "Amount too low: link expects 6, transaction sends 5.9999999"]);

    await withPaths().submitPayment("lnk_under", buildPath({ destAmount: "6", sendMax: "14.6" }));
    expect(relayed).toHaveLength(1);
    expect(horizon.calls[0]!.amount).toBe("6");
  });

  it("prices the amount the transaction delivers, which may be more than the link still owes", async () => {
    // Overpaying is allowed, as for a plain payment. The price sendMax is held
    // to is then the price of what is delivered, not of the smaller amount owed.
    horizon.records = [pathRecord(XLM, "29", [], "12")];
    await withPaths().submitPayment("lnk_1", buildPath({ destAmount: "12", sendMax: "29.5" }));
    expect(relayed).toHaveLength(1);
    expect(horizon.calls.map((call) => call.amount)).toEqual(["12"]);
  });

  it("refuses a source asset that is the link's own asset", async () => {
    const err = await refused(withPaths({ sourceAssets: [XLM, USDC_REF] }), buildPath({ sendAsset: USDC, sendMax: "10.1" }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/must send another asset than USDC/);
    expect(horizon.calls).toEqual([]);
  });

  it("refuses a source asset that is not on the allowlist", async () => {
    const xdr = buildPath({ sendAsset: EURC, sendMax: "9.3" });
    const err = await refused(withPaths(), xdr);
    expect([err.status, err.message, err.extra]).toEqual([
      409,
      "Source asset EURC is not accepted for path payments",
      { reason: "source_asset_not_allowed" },
    ]);
    expect(horizon.calls).toEqual([]);

    // The same transaction is relayed once the operator allows the asset.
    horizon.records = [pathRecord(EURC_REF, "9.2")];
    await withPaths({ sourceAssets: [XLM, EURC_REF] }).submitPayment("lnk_1", xdr);
    expect(relayed).toHaveLength(1);
  });

  it("does not take an asset with an allowed code and another issuer for the allowed one", async () => {
    const fakeEurc = new Asset("EURC", ATTACKER.publicKey());
    const fakeXlm = new Asset("XLM", ATTACKER.publicKey());
    for (const sendAsset of [fakeEurc, fakeXlm]) {
      const err = await refused(withPaths({ sourceAssets: [XLM, EURC_REF] }), buildPath({ sendAsset }));
      expect([err.status, err.extra]).toEqual([409, { reason: "source_asset_not_allowed" }]);
    }
  });

  it("accepts a path of five assets, the most the protocol can carry", async () => {
    const hops = Array.from({ length: 5 }, (_, i) => new Asset(`HOP${i}`, EURC_ISSUER));
    await withPaths().submitPayment("lnk_1", buildPath({ path: hops }));
    expect(relayed).toHaveLength(1);
    // A sixth cannot be put in an envelope at all: the XDR array is capped at
    // five, so such a transaction never reaches the service's own check.
    expect(() => buildPath({ path: [...hops, new Asset("HOP5", EURC_ISSUER)] })).toThrow();
  });

  it("refuses a path payment that never expires", async () => {
    const err = await refused(withPaths(), buildPath({}, { maxTime: 0 }));
    expect([err.status, err.message]).toEqual([
      400,
      "Path payment must expire: the transaction has no timeBounds.maxTime",
    ]);
    expect(horizon.calls).toEqual([]);
  });

  it("refuses a path payment that expires later than its quote plus 30 seconds", async () => {
    const latest = NOW_S + TTL_MS / 1000 + 30;
    await withPaths().submitPayment("lnk_1", buildPath({}, { maxTime: latest }));
    expect(relayed).toHaveLength(1);
    relayed.length = 0;

    const err = await refused(withPaths(), buildPath({}, { maxTime: latest + 1 }));
    expect([err.status, err.message]).toEqual([
      400,
      `Path payment expires too late: timeBounds.maxTime is ${latest + 1}, at most ${latest} is allowed`,
    ]);

    // The 300 seconds a plain payment is built with are far too long for a price.
    const plainTimeout = await refused(withPaths(), buildPath({}, { maxTime: NOW_S + 300 }));
    expect(plainTimeout.message).toMatch(/expires too late/);

    // A longer configured lifetime moves the limit with it.
    await withPaths({ quoteTtlMs: 300_000 }).submitPayment("lnk_1", buildPath({}, { maxTime: NOW_S + 300 }));
    expect(relayed).toHaveLength(1);
  });

  it("refuses a sendMax above twice the allowed slippage over what the path costs now", async () => {
    // At the limit to the stroop: relayed.
    await withPaths().submitPayment("lnk_1", buildPath({ sendMax: LIMIT }));
    expect(relayed).toHaveLength(1);
    relayed.length = 0;

    const oneStroopOver = (BigInt(LIMIT.replace(".", "")) + 1n).toString().replace(/(\d{7})$/, ".$1");
    for (const sendMax of [oneStroopOver, "1000000"]) {
      const err = await refused(withPaths(), buildPath({ sendMax }));
      expect([err.status, err.message, err.extra?.reason]).toEqual([409, "payment_rejected", "price_moved"]);
      expect(String(err.extra?.detail)).toContain(`is above ${LIMIT}`);
    }

    // The limit follows the configured slippage: at 0 bps nothing above the quote passes.
    const strict = withPaths({ maxSlippageBps: 0 });
    await strict.submitPayment("lnk_1", buildPath({ sendMax: QUOTED }));
    expect(relayed).toHaveLength(1);
    relayed.length = 0;
    expect((await refused(strict, buildPath({ sendMax: SEND_MAX }))).extra?.reason).toBe("price_moved");
  });

  it("refuses a path payment when there is no path for its source asset right now", async () => {
    for (const records of [[], [pathRecord(EURC_REF, "9.2")]]) {
      horizon.records = records;
      const err = await refused(withPaths(), buildPath());
      expect([err.status, err.message, err.extra]).toEqual([
        409,
        "payment_rejected",
        { reason: "no_path", detail: "No path from XLM to USDC right now" },
      ]);
    }
  });

  it("fails closed with 503 when Horizon cannot give a price to check sendMax against", async () => {
    for (const failures of [
      [horizonError(503), horizonError(503), horizonError(503)],
      [horizonError(400)],
      [new Error("socket hang up"), new Error("socket hang up"), new Error("socket hang up")],
    ]) {
      horizon.failures = failures;
      const err = await refused(withPaths(), buildPath());
      expect([err.status, err.message, err.extra]).toEqual([503, "horizon_unavailable", { retryable: true }]);
    }
  });

  it("asks Horizon for a price only once everything else about the transaction is right", async () => {
    horizon.failures = [horizonError(503), horizonError(503), horizonError(503)];
    // Each of these is wrong in a way that costs nothing to see, and is refused for that.
    for (const xdr of [
      buildPath({}, { memo: Memo.text("pl_other") }),
      buildPath({ sendAsset: EURC }),
      buildPath({}, { maxTime: 0 }),
      buildPath({}, { maxTime: NOW_S + 3600 }),
    ]) {
      const err = await refused(withPaths(), xdr);
      expect(err.status).not.toBe(503);
    }
    expect(horizon.calls).toEqual([]);
  });
});
