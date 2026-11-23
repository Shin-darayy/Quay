import type { Asset, Horizon } from "@stellar/stellar-sdk";
import type { AssetRef } from "@checkout/core";
import type { HorizonClient } from "@checkout/stellar";

// Horizon, as far as a strict-receive path quote goes, for the tests of
// GET /links/:id/pay-options (issue 4.64) and of path payments on
// POST /links/:id/submit (issue 4.65). Nothing here reaches the network.

export type PathRecord = Horizon.ServerApi.PaymentPathRecord;

/**
 * A maker of Horizon strict-receive records that deliver `dest`: each one
 * says how much of `source` pays `amount`, through `path`.
 */
export function pathRecordsTo(dest: AssetRef) {
  const asset = (prefix: string, ref: AssetRef) =>
    ref.issuer === null
      ? { [`${prefix}asset_type`]: "native" }
      : {
          [`${prefix}asset_type`]: ref.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
          [`${prefix}asset_code`]: ref.code,
          [`${prefix}asset_issuer`]: ref.issuer,
        };
  return (source: AssetRef, sourceAmount: string, path: AssetRef[] = [], amount = "10"): PathRecord =>
    ({
      ...asset("source_", source),
      source_amount: sourceAmount,
      ...asset("destination_", dest),
      destination_amount: amount,
      path: path.map((hop) => asset("", hop)),
    }) as unknown as PathRecord;
}

/** What Horizon's SDK throws for an HTTP error: an error carrying the response. */
export function horizonError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
}

/** Canned records, scripted failures, and a record of what was asked. */
export class StubHorizon implements HorizonClient {
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
    throw new Error("a path quote must not read payments");
  }
  loadAccount(): never {
    throw new Error("a path quote must not load an account");
  }
}
