import type { PageSnapshot } from "./safety.ts";

const PAYMENT_INTENT = /\b(pay(?:ment)?|submit|checkout|transfer|bharo|bharna|chuka(?:o|ao|na)?)\b|भुगतान|बिल\s*(?:भर|जमा)|चुक/i;
const RECEIPT_SIGNALS = /payment\s+successful|भुगतान\s+सफल|transaction\s*(?:id|no\.?|number)|receipt|रसीद|लेन.?देन|order\s+confirmed|ऑर्डर\s+पुष्टि/i;

/** Detect generic visible completion/receipt evidence without relying on demo DOM selectors. */
export function hasPaymentReceipt(summary: string): boolean {
  return RECEIPT_SIGNALS.test(summary);
}

export function isPaymentIntent(request: string): boolean {
  return PAYMENT_INTENT.test(request);
}

/** Detect the demo payment form without exposing or reading any field values. */
export function hasVisiblePaymentForm(snapshot: PageSnapshot): boolean {
  const hasSensitivePaymentField = snapshot.interactiveElements.some((element) =>
    element.isSensitive && /card|cvv|cvc|expiry|payment|account|upi/i.test(
      `${element.name || ""} ${element.label} ${element.placeholder || ""}`,
    ),
  );
  return hasSensitivePaymentField;
}
