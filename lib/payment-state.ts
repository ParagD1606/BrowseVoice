import type { PageSnapshot } from "./safety.ts";

const PAYMENT_INTENT = /\b(pay(?:ment)?|submit|checkout|transfer|bharo|bharna|chuka(?:o|ao|na)?)\b|भुगतान|बिल\s*(?:भर|जमा)|चुक/i;
const PAYMENT_SUCCESS = /payment\s+successful|भुगतान\s+सफल/i;
const RECEIPT_EVIDENCE = /transaction\s*(?:id|no\.?|number)|receipt|रसीद|लेन.?देन/i;

/** Only a visible success message together with receipt evidence proves payment completion. */
export function hasPaymentReceipt(summary: string): boolean {
  return PAYMENT_SUCCESS.test(summary) && RECEIPT_EVIDENCE.test(summary);
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
  const hasPaySubmit = snapshot.interactiveElements.some((element) =>
    (element.type === "submit" || element.role === "button" || element.tag === "button") &&
    /\bpay\b|भुगतान/i.test(element.label),
  );

  return hasSensitivePaymentField && hasPaySubmit;
}
