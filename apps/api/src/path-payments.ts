import { StrKey } from "@stellar/stellar-sdk";
import { XLM, assetEquals, type AssetRef } from "@checkout/core";
import type { HorizonClient } from "@checkout/stellar";

/**
 * Settings for paying a link with another asset (the "pay with any asset"
 * feature, issues 8.30 and 4.64). Passed to `LinkService`, so the service
 * never reads the environment and a test can state each one.
 */
export interface PathPaymentsConfig {
  /** The feature switch (issue 8.30). Off answers `501 path_payments_disabled`. */
  enabled: boolean;
  /** Slippage allowed on top of a quoted source amount, in basis points (issue 8.30). */
  maxSlippageBps: number;
  /** The assets a buyer may pay with. A quote in any other asset is not offered. */
  sourceAssets: AssetRef[];
  /** How long a quote stands, in milliseconds. */
  quoteTtlMs: number;
  /** Where `GET /paths/strict-receive` is asked. */
  horizon: HorizonClient;
  /** The clock quotes are stamped with. Tests pass a fixed one. */
  now?: () => number;
}

/** One way to pay the outstanding amount of a link with another asset. */
export interface PayOption {
  sourceAsset: AssetRef;
  /** What the path costs right now, in `sourceAsset`. */
  sourceAmount: string;
  /** The most the buyer agrees to spend: `sourceAmount` plus the allowed slippage, rounded up. */
  sendMax: string;
  /** Intermediate assets between source and destination, in order. Empty for a direct trade. */
  path: AssetRef[];
  /** When the quote was taken, epoch milliseconds. */
  quotedAt: number;
  /** When it stops standing: `quotedAt` plus the configured lifetime. */
  expiresAt: number;
}

/** The body of `GET /links/:id/pay-options`. */
export interface PayOptions {
  linkAsset: AssetRef;
  /** The outstanding amount of the link, which is what every option delivers. */
  amount: string;
  options: PayOption[];
}

/** Lifetime of a quote when `PATH_QUOTE_TTL_MS` is unset. */
export const DEFAULT_PATH_QUOTE_TTL_MS = 30_000;
/** A quote that outlives the wallet transaction it is built into (300 s) protects nobody. */
const MAX_PATH_QUOTE_TTL_MS = 300_000;
const MIN_PATH_QUOTE_TTL_MS = 1_000;

const ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;

/**
 * Parses `PATH_PAYMENTS_SOURCE_ASSETS`: a comma-separated allowlist such as
 * `native,EURC:GDHU...`. `native` is XLM; anything else is `CODE:ISSUER`.
 *
 * Unset or blank means `native` alone, so a deployment never offers an asset
 * nobody chose to allow. A malformed entry is rejected at boot: an allowlist
 * that silently dropped a typo would offer less than the operator configured,
 * and one that silently kept it could not match anything.
 */
export function parseSourceAssets(raw: string | undefined): AssetRef[] {
  if (raw === undefined || raw.trim() === "") return [XLM];
  const assets: AssetRef[] = [];
  for (const entry of raw.split(",").map((part) => part.trim())) {
    const asset = parseSourceAsset(entry);
    if (!assets.some((seen) => assetEquals(seen, asset))) assets.push(asset);
  }
  return assets;
}

function parseSourceAsset(entry: string): AssetRef {
  const fail = (why: string): never => {
    throw new Error(
      `PATH_PAYMENTS_SOURCE_ASSETS: "${entry}" ${why}. Use "native" or CODE:ISSUER, separated by commas.`,
    );
  };
  if (entry === "") return fail("is empty");
  if (entry === "native") return XLM;
  const [code, issuer, ...rest] = entry.split(":");
  if (issuer === undefined || rest.length > 0) return fail("is not CODE:ISSUER");
  if (!ASSET_CODE.test(code!)) return fail("has an asset code that is not 1-12 letters or digits");
  // XLM has no issuer, and an issued asset that calls itself XLM is the
  // classic look-alike. It is spelled `native` here and nothing else.
  if (code === "XLM") return fail('names XLM with an issuer; write "native" for XLM');
  if (!StrKey.isValidEd25519PublicKey(issuer)) return fail("has an issuer that is not a G-address");
  return { code: code!, issuer };
}

/**
 * Parses `PATH_QUOTE_TTL_MS`. Unset or blank is the default. Anything that is
 * not a whole number of milliseconds between one second and five minutes is
 * rejected at boot.
 */
export function parseQuoteTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PATH_QUOTE_TTL_MS;
  const ttl = Number(raw);
  if (!Number.isInteger(ttl) || ttl < MIN_PATH_QUOTE_TTL_MS || ttl > MAX_PATH_QUOTE_TTL_MS) {
    throw new Error(
      `PATH_QUOTE_TTL_MS must be a whole number from ${MIN_PATH_QUOTE_TTL_MS} to ${MAX_PATH_QUOTE_TTL_MS}, got "${raw}"`,
    );
  }
  return ttl;
}
