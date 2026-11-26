import type { AssetRef, LinkPaymentRecord } from "@checkout/core";

/** What the buyer spent for one path payment: the source side of it. */
export interface PaidWithEntry {
  asset: AssetRef;
  amount: string;
}

/**
 * The source side of each path payment recorded against a link (issue 4.66).
 *
 * A plain payment is not listed: it spent what it delivered, which the receipt
 * and CSV already report as `asset`/`paidAmount`. Returns null when every
 * payment was a plain payment, so a receipt can say "nothing beyond the
 * delivered asset" rather than an empty list.
 */
export function paidWithFor(payments: LinkPaymentRecord[]): PaidWithEntry[] | null {
  const entries = payments
    .filter((p) => p.sourceAsset && p.sourceAmount != null)
    .map((p) => ({ asset: p.sourceAsset!, amount: p.sourceAmount! }));
  return entries.length > 0 ? entries : null;
}

/**
 * `24.1234567 XLM`; several path payments are joined with `; `. Empty for a
 * link paid without any path payment.
 */
export function paidWithLabel(entries: PaidWithEntry[] | null): string {
  if (!entries || entries.length === 0) return "";
  return entries.map((e) => `${e.amount} ${e.asset.code}`).join("; ");
}
