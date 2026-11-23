import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { XLM, type AssetRef } from "@checkout/core";
import { DEFAULT_PATH_QUOTE_TTL_MS, parseQuoteTtlMs, parseSourceAssets } from "../src/path-payments";

// ---------------------------------------------------------------------------
//  The two settings of GET /links/:id/pay-options (issue 4.64): which assets a
//  buyer may be quoted in, and how long a quote stands. Both are parsed at
//  boot, and a value that is not understood stops it.
// ---------------------------------------------------------------------------

const EURC_ISSUER = Keypair.random().publicKey();
const OTHER_ISSUER = Keypair.random().publicKey();
const EURC: AssetRef = { code: "EURC", issuer: EURC_ISSUER };

describe("PATH_PAYMENTS_SOURCE_ASSETS", () => {
  it("is native alone when unset or blank", () => {
    for (const raw of [undefined, "", "   "]) expect(parseSourceAssets(raw)).toEqual([XLM]);
  });

  it("reads native and CODE:ISSUER entries, in order, once each", () => {
    expect(parseSourceAssets(`native,EURC:${EURC_ISSUER}`)).toEqual([XLM, EURC]);
    expect(parseSourceAssets(` EURC:${EURC_ISSUER} , native , EURC:${EURC_ISSUER} `)).toEqual([EURC, XLM]);
    // The same code under two issuers is two assets.
    expect(parseSourceAssets(`EURC:${EURC_ISSUER},EURC:${OTHER_ISSUER}`)).toEqual([
      EURC,
      { code: "EURC", issuer: OTHER_ISSUER },
    ]);
    // An allowlist without native is allowed: XLM is then not offered.
    expect(parseSourceAssets(`EURC:${EURC_ISSUER}`)).toEqual([EURC]);
  });

  it.each([
    ["EURC", "is not CODE:ISSUER"],
    ["EURC:", "issuer that is not a G-address"],
    ["EURC:GNOTAKEY", "issuer that is not a G-address"],
    [`EURC:${EURC_ISSUER}:extra`, "is not CODE:ISSUER"],
    [`THIRTEENCHARS:${EURC_ISSUER}`, "asset code"],
    [`EU-RC:${EURC_ISSUER}`, "asset code"],
    [`:${EURC_ISSUER}`, "asset code"],
    [`XLM:${EURC_ISSUER}`, 'write "native" for XLM'],
    ["Native", "is not CODE:ISSUER"],
  ])("refuses %s", (entry, why) => {
    expect(() => parseSourceAssets(entry)).toThrow(why);
    // One bad entry spoils the list: nothing is silently dropped.
    expect(() => parseSourceAssets(`native,${entry}`)).toThrow("PATH_PAYMENTS_SOURCE_ASSETS");
  });

  it("refuses an empty entry between commas", () => {
    expect(() => parseSourceAssets("native,,")).toThrow("is empty");
    expect(() => parseSourceAssets(",")).toThrow("is empty");
  });
});

describe("PATH_QUOTE_TTL_MS", () => {
  it("defaults to 30 seconds", () => {
    expect(DEFAULT_PATH_QUOTE_TTL_MS).toBe(30_000);
    for (const raw of [undefined, "", "  "]) expect(parseQuoteTtlMs(raw)).toBe(30_000);
  });

  it("accepts a whole number of milliseconds from one second to five minutes", () => {
    expect(parseQuoteTtlMs("1000")).toBe(1_000);
    expect(parseQuoteTtlMs("45000")).toBe(45_000);
    expect(parseQuoteTtlMs("300000")).toBe(300_000);
  });

  it.each(["0", "999", "300001", "1500.5", "-30000", "30s", "NaN", "Infinity"])("refuses %s", (raw) => {
    expect(() => parseQuoteTtlMs(raw)).toThrow("PATH_QUOTE_TTL_MS");
  });
});
