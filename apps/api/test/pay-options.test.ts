import { beforeEach, describe, expect, it } from "vitest";
import { Keypair, Networks, StrKey, type Asset, type Horizon } from "@stellar/stellar-sdk";
import { LINK_STATUSES, XLM, type AssetRef, type RailPort, type Seller, type SellerRepository } from "@checkout/core";
import { sendMaxFor, type HorizonClient, type StellarConfig } from "@checkout/stellar";
import type { Container } from "../src/services/container";
import { HttpError, LinkService } from "../src/services/link-service";
import { linkRoutes } from "../src/routes/links";
import { parseSourceAssets, type PathPaymentsConfig, type PayOptions } from "../src/path-payments";
import { SessionIssuer } from "../src/services/session";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeTelemetryRepository,
  FakeWebhookRepository,
  ScriptedOffRamp,
  makeLink,
} from "./fakes";

// ---------------------------------------------------------------------------
//  GET /links/:id/pay-options — which assets a buyer can pay a link with, and
//  how much of each (issue 4.64).
//
//  Nothing here reaches the network: Horizon is the stub below, and the quoting
//  itself is the real `quoteStrictReceive` / `sendMaxFor` from @checkout/stellar.
// ---------------------------------------------------------------------------

const DEST = Keypair.random().publicKey();
const BUYER = Keypair.random().publicKey();
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const EURC_ISSUER = Keypair.random().publicKey();
const OTHER_ISSUER = Keypair.random().publicKey();
const USDC: AssetRef = { code: "USDC", issuer: USDC_ISSUER };
const EURC: AssetRef = { code: "EURC", issuer: EURC_ISSUER };
const NOW = 1_763_560_000_000;

type PathRecord = Horizon.ServerApi.PaymentPathRecord;

/** A Horizon strict-receive record that pays `amount` USDC from `source`. */
function pathRecord(source: AssetRef, sourceAmount: string, path: AssetRef[] = [], amount = "10"): PathRecord {
  const asset = (prefix: string, ref: AssetRef) =>
    ref.issuer === null
      ? { [`${prefix}asset_type`]: "native" }
      : {
          [`${prefix}asset_type`]: ref.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
          [`${prefix}asset_code`]: ref.code,
          [`${prefix}asset_issuer`]: ref.issuer,
        };
  return {
    ...asset("source_", source),
    source_amount: sourceAmount,
    ...asset("destination_", USDC),
    destination_amount: amount,
    path: path.map((hop) => asset("", hop)),
  } as unknown as PathRecord;
}

/** What Horizon's SDK throws for an HTTP error: an error carrying the response. */
function horizonError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
}

/** Horizon, as far as a path quote goes: canned records, scripted failures, and a record of what was asked. */
class StubHorizon implements HorizonClient {
  records: PathRecord[] = [];
  failures: unknown[] = [];
  calls: { source: string | Asset[]; destination: Asset; amount: string }[] = [];
  /** Runs when Horizon is asked, for tests that care what happened before. */
  onCall: () => void = () => {};

  strictReceivePaths(source: string | Asset[], destination: Asset, amount: string) {
    return {
      call: async () => {
        this.calls.push({ source, destination, amount });
        this.onCall();
        const failure = this.failures.shift();
        if (failure !== undefined) throw failure;
        return { records: [...this.records] };
      },
    };
  }
  payments(): never {
    throw new Error("pay-options must not read payments");
  }
  loadAccount(): never {
    throw new Error("pay-options must not load an account");
  }
}

const stellar: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  usdcIssuer: USDC_ISSUER,
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
  buildRequest: () => ({ uri: "web+stellar:pay", destination: DEST, amount: "10", asset: USDC, memo: "r" }),
  isValidDestination: () => true,
  async assertCanReceive() {},
};

let links: FakeLinkRepository;
let horizon: StubHorizon;

/** A service with the feature on, unless `over` says otherwise. `null` leaves the settings out altogether. */
function serviceWith(over: Partial<PathPaymentsConfig> | null = {}): LinkService {
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
    ...(over === null
      ? {}
      : {
          pathPayments: {
            enabled: true,
            maxSlippageBps: 100,
            sourceAssets: [XLM],
            quoteTtlMs: 30_000,
            horizon,
            now: () => NOW,
            ...over,
          },
        }),
  });
}

/** The HttpError a call is refused with. Fails the test if it is not refused that way. */
async function refusal(call: Promise<unknown>): Promise<HttpError> {
  const err = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

beforeEach(async () => {
  links = new FakeLinkRepository();
  horizon = new StubHorizon();
  horizon.records = [pathRecord(XLM, "24.1234567")];
  await links.save(
    makeLink({ id: "lnk_1", status: "active", txHash: null, payer: null, paidAmount: null, amount: "10", asset: USDC }),
  );
});

describe("LinkService.getPayOptions", () => {
  it("quotes the link amount from the buyer's account, with sendMax and an expiry", async () => {
    const result = await serviceWith().getPayOptions("lnk_1", BUYER);
    // The example in issue 4.64: 24.1234567 XLM at 100 bps is 24.36469127, up to the next stroop.
    expect(result).toEqual({
      linkAsset: USDC,
      amount: "10",
      options: [
        {
          sourceAsset: { code: "XLM", issuer: null },
          sourceAmount: "24.1234567",
          sendMax: "24.3646913",
          path: [],
          quotedAt: NOW,
          expiresAt: NOW + 30_000,
        },
      ],
    } satisfies PayOptions);

    // Horizon was asked once, for paths from this account to exactly the link.
    expect(horizon.calls).toHaveLength(1);
    const asked = horizon.calls[0]!;
    expect(asked.source).toBe(BUYER);
    expect([asked.destination.getCode(), asked.destination.getIssuer()]).toEqual(["USDC", USDC_ISSUER]);
    expect(asked.amount).toBe("10");
  });

  it("quotes only what an underpaid link still owes", async () => {
    await links.save(
      makeLink({ id: "lnk_under", status: "underpaid", txHash: null, paidAmount: "4.25", amount: "10", asset: USDC }),
    );
    horizon.records = [pathRecord(XLM, "13.5", [], "5.75")];
    const result = await serviceWith().getPayOptions("lnk_under", BUYER);
    expect(horizon.calls[0]!.amount).toBe("5.75");
    expect(result.amount).toBe("5.75");
    expect(result.options.map((o) => o.sourceAmount)).toEqual(["13.5"]);
  });

  it("is unavailable (501) while the switch is off, and asks Horizon nothing", async () => {
    for (const service of [serviceWith({ enabled: false }), serviceWith(null)]) {
      const err = await refusal(service.getPayOptions("lnk_1", BUYER));
      expect([err.status, err.message]).toEqual([501, "path_payments_disabled"]);
    }
    // Off wins over everything else that is wrong with the request.
    const err = await refusal(serviceWith({ enabled: false }).getPayOptions("lnk_missing", "not-an-account"));
    expect(err.status).toBe(501);
    expect(horizon.calls).toHaveLength(0);
  });

  it("refuses an account that is not a G-address (400)", async () => {
    const contract = StrKey.encodeContract(Buffer.alloc(32, 7));
    const secret = Keypair.random().secret();
    for (const account of ["", "GABC", BUYER.toLowerCase(), `${BUYER} `, contract, secret, "native"]) {
      const err = await refusal(serviceWith().getPayOptions("lnk_1", account));
      expect([account, err.status, err.message]).toEqual([account, 400, "invalid_account"]);
    }
    expect(horizon.calls).toHaveLength(0);
  });

  it("answers 404 for a link that does not exist", async () => {
    const err = await refusal(serviceWith().getPayOptions("lnk_missing", BUYER));
    expect([err.status, err.message]).toEqual([404, "not_found"]);
    expect(horizon.calls).toHaveLength(0);
  });

  it("answers 409 for a link in any status but active and underpaid, and says which", async () => {
    // Taken from the status list itself, so a status added later is refused too.
    const notPayable = LINK_STATUSES.filter((status) => status !== "active" && status !== "underpaid");
    expect(notPayable).toEqual(["paid", "expired", "cancelled", "offramp_pending", "offramp_settled", "offramp_failed"]);
    for (const status of notPayable) {
      await links.save(makeLink({ id: `lnk_${status}`, status, amount: "10", asset: USDC }));
      const err = await refusal(serviceWith().getPayOptions(`lnk_${status}`, BUYER));
      expect([err.status, err.message, err.extra]).toEqual([409, "link_not_payable", { status }]);
    }
    expect(horizon.calls).toHaveLength(0);
  });

  it("offers only the assets on the allowlist", async () => {
    const AQUA: AssetRef = { code: "AQUA", issuer: OTHER_ISSUER };
    horizon.records = [pathRecord(XLM, "24"), pathRecord(EURC, "9.2"), pathRecord(AQUA, "5000")];

    // The default allowlist is native alone.
    const byDefault = await serviceWith({ sourceAssets: parseSourceAssets(undefined) }).getPayOptions("lnk_1", BUYER);
    expect(byDefault.options.map((o) => o.sourceAsset)).toEqual([XLM]);

    const withEurc = await serviceWith({ sourceAssets: [XLM, EURC] }).getPayOptions("lnk_1", BUYER);
    expect(withEurc.options.map((o) => o.sourceAsset)).toEqual([EURC, XLM]);

    // Nothing allowed means nothing offered, whatever the buyer holds.
    const none = await serviceWith({ sourceAssets: [] }).getPayOptions("lnk_1", BUYER);
    expect(none.options).toEqual([]);
  });

  it("does not take an asset with an allowed code and another issuer for the allowed one", async () => {
    const lookAlike: AssetRef = { code: "EURC", issuer: OTHER_ISSUER };
    const fakeXlm: AssetRef = { code: "XLM", issuer: OTHER_ISSUER };
    horizon.records = [pathRecord(lookAlike, "9"), pathRecord(fakeXlm, "1")];
    const result = await serviceWith({ sourceAssets: [XLM, EURC] }).getPayOptions("lnk_1", BUYER);
    expect(result.options).toEqual([]);
  });

  it("never offers the link's own asset, and keeps the cheapest path per asset", async () => {
    horizon.records = [pathRecord(USDC, "10"), pathRecord(XLM, "25"), pathRecord(XLM, "24.5", [EURC])];
    const result = await serviceWith({ sourceAssets: [XLM, USDC] }).getPayOptions("lnk_1", BUYER);
    expect(result.options).toHaveLength(1);
    // The cheaper XLM path goes through EURC, and the hop is passed on.
    expect(result.options[0]).toMatchObject({ sourceAsset: XLM, sourceAmount: "24.5", path: [EURC] });
  });

  it("computes sendMax from the configured slippage, with the quoting package's own rounding", async () => {
    horizon.records = [pathRecord(XLM, "12.3456789")];
    for (const bps of [0, 100, 250, 1000]) {
      const result = await serviceWith({ maxSlippageBps: bps }).getPayOptions("lnk_1", BUYER);
      expect(result.options[0]!.sendMax).toBe(sendMaxFor("12.3456789", bps));
    }
    // No slippage is the quote itself, and any slippage is strictly more.
    expect(sendMaxFor("12.3456789", 0)).toBe("12.3456789");
    const atOnePercent = await serviceWith({ maxSlippageBps: 100 }).getPayOptions("lnk_1", BUYER);
    expect(atOnePercent.options[0]!.sendMax).toBe("12.4691357");
  });

  it("stamps the quote before asking Horizon, and expires it after the configured lifetime", async () => {
    let clock = NOW;
    horizon.onCall = () => {
      clock += 1_500; // Horizon takes a while to answer
    };
    const result = await serviceWith({ now: () => clock, quoteTtlMs: 45_000 }).getPayOptions("lnk_1", BUYER);
    expect(result.options[0]).toMatchObject({ quotedAt: NOW, expiresAt: NOW + 45_000 });
  });

  it("answers 503, retryable, when Horizon stays down, after retrying as the watcher does", async () => {
    horizon.failures = [horizonError(503), horizonError(503), horizonError(503)];
    const err = await refusal(serviceWith().getPayOptions("lnk_1", BUYER));
    expect([err.status, err.message, err.extra]).toEqual([503, "horizon_unavailable", { retryable: true }]);
    expect(horizon.calls).toHaveLength(3);

    // No response at all (a network error) is the same outage.
    horizon.calls = [];
    horizon.failures = [new Error("socket hang up"), new Error("socket hang up"), new Error("socket hang up")];
    const noAnswer = await refusal(serviceWith().getPayOptions("lnk_1", BUYER));
    expect([noAnswer.status, noAnswer.extra]).toEqual([503, { retryable: true }]);
  });

  it("recovers when Horizon answers on a retry", async () => {
    horizon.failures = [horizonError(429)];
    const result = await serviceWith().getPayOptions("lnk_1", BUYER);
    expect(result.options).toHaveLength(1);
    expect(horizon.calls).toHaveLength(2);
  });

  it("answers 502, not retryable, when Horizon refuses the search outright", async () => {
    horizon.failures = [horizonError(400)];
    const err = await refusal(serviceWith().getPayOptions("lnk_1", BUYER));
    expect([err.status, err.message, err.extra]).toEqual([502, "quote_failed", { retryable: false }]);
    expect(horizon.calls).toHaveLength(1);
  });

  it("offers nothing, without an error, to an account that is not on the ledger", async () => {
    horizon.failures = [horizonError(404)];
    const result = await serviceWith().getPayOptions("lnk_1", BUYER);
    expect(result).toEqual({ linkAsset: USDC, amount: "10", options: [] });
    expect(horizon.calls).toHaveLength(1);
  });

  it("offers nothing when there is no path", async () => {
    horizon.records = [];
    const result = await serviceWith().getPayOptions("lnk_1", BUYER);
    expect(result.options).toEqual([]);
  });

  it("does not ask Horizon to quote an amount of zero", async () => {
    await links.save(makeLink({ id: "lnk_zero", status: "active", txHash: null, paidAmount: "10", amount: "10", asset: USDC }));
    const result = await serviceWith().getPayOptions("lnk_zero", BUYER);
    expect(result).toEqual({ linkAsset: USDC, amount: "0", options: [] });

    // More paid than asked is nothing owed either, never an amount below zero.
    await links.save(makeLink({ id: "lnk_over", status: "active", txHash: null, paidAmount: "12.5", amount: "10", asset: USDC }));
    const over = await serviceWith().getPayOptions("lnk_over", BUYER);
    expect(over).toEqual({ linkAsset: USDC, amount: "0", options: [] });
    expect(horizon.calls).toHaveLength(0);
  });
});

describe("GET /links/:id/pay-options", () => {
  const OPTIONS: PayOptions = {
    linkAsset: USDC,
    amount: "10",
    options: [
      { sourceAsset: XLM, sourceAmount: "24.1234567", sendMax: "24.3646913", path: [], quotedAt: NOW, expiresAt: NOW + 30_000 },
    ],
  };

  /** The routes over a service that answers `getPayOptions` with `answer`, and a limiter that counts. */
  function routes(answer: (id: string, account: string) => Promise<PayOptions>) {
    const asked: { id: string; account: string }[] = [];
    const limited: string[] = [];
    const linkReads: string[] = [];
    const container = {
      service: {
        getPayOptions: async (id: string, account: string) => {
          asked.push({ id, account });
          return answer(id, account);
        },
        getLink: async (id: string) => {
          linkReads.push(id);
          return { link: makeLink({ id, status: "active", asset: USDC }), request: {} };
        },
      },
      auth: { session: new SessionIssuer("test-secret"), sellers, revocations: {} },
      sellers,
      apiKeys: {},
      db: {},
    } as unknown as Container;
    const app = linkRoutes(container, async (ctx, next) => {
      limited.push(new URL(ctx.req.url).pathname);
      await next();
    });
    return { app, asked, limited, linkReads };
  }

  it("returns the options for the account in the query, uncached and rate limited", async () => {
    const { app, asked, limited } = routes(async () => OPTIONS);
    const res = await app.request(`/lnk_1/pay-options?account=${BUYER}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OPTIONS);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(asked).toEqual([{ id: "lnk_1", account: BUYER }]);
    // No session and no API key: the caller is a buyer holding a link.
    expect(limited).toEqual(["/lnk_1/pay-options"]);
  });

  it("passes a missing account on as empty, for the service to refuse", async () => {
    const { app, asked } = routes(async () => {
      throw new HttpError(400, "invalid_account");
    });
    const res = await app.request("/lnk_1/pay-options");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_account" });
    expect(asked).toEqual([{ id: "lnk_1", account: "" }]);
  });

  it.each([
    [404, "not_found", undefined, { error: "not_found" }],
    [409, "link_not_payable", { status: "paid" }, { error: "link_not_payable", status: "paid" }],
    [501, "path_payments_disabled", undefined, { error: "path_payments_disabled" }],
    [502, "quote_failed", { retryable: false }, { error: "quote_failed", retryable: false }],
    [503, "horizon_unavailable", { retryable: true }, { error: "horizon_unavailable", retryable: true }],
  ] as const)("answers %i %s as the service refused it, and does not cache the refusal", async (status, error, extra, body) => {
    const { app } = routes(async () => {
      throw new HttpError(status, error, extra);
    });
    const res = await app.request(`/lnk_1/pay-options?account=${BUYER}`);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not turn an unexpected failure into one of its own answers", async () => {
    const { app } = routes(async () => {
      throw new Error("boom");
    });
    const res = await app.request(`/lnk_1/pay-options?account=${BUYER}`);
    expect(res.status).toBe(500);
  });

  it("leaves the public link read alone: GET /:id does not ask for pay options, and is not rate limited by it", async () => {
    const { app, asked, limited, linkReads } = routes(async () => OPTIONS);
    const res = await app.request("/lnk_1");
    expect(res.status).toBe(200);
    expect(linkReads).toEqual(["lnk_1"]);
    expect(asked).toEqual([]);
    expect(limited).toEqual([]);

    // And the other way round: asking for pay options does not read the link through the public route.
    await app.request(`/lnk_1/pay-options?account=${BUYER}`);
    expect(linkReads).toEqual(["lnk_1"]);
    expect(asked).toEqual([{ id: "lnk_1", account: BUYER }]);
  });
});
