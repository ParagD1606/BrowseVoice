import type { PageSnapshot } from "./safety.ts";

const PAYMENT_INTENT = /\b(?:pay(?:ment)?|submit|transfer|buy|purchase|place\s+order|order\s+now|pay\s+now|bharo|bharna|chuka(?:o|ao|na)?)\b|भुगतान|बिल\s*(?:भर|जमा)|चुक|खरीद|ऑर्डर\s*(?:करो|रखो)/i;
const FORM_ONLY_REQUEST = /\b(?:fill|complete|edit)\b.*\b(?:checkout|payment)\b(?:\s+form)?\b/i;
const PAYMENT_COMPLETION_WORD = /\b(?:pay|buy|purchase|place\s+order|order\s+now|pay\s+now)\b/i;
const RECEIPT_SIGNALS = /payment\s+successful|भुगतान\s+सफल|transaction\s*(?:id|no\.?|number)|receipt|रसीद|लेन.?देन|order\s+confirmed|ऑर्डर\s+पुष्टि/i;

/** Detect generic visible completion/receipt evidence without relying on demo DOM selectors. */
export function hasPaymentReceipt(summary: string): boolean {
  return RECEIPT_SIGNALS.test(summary);
}

export function isPaymentIntent(request: string): boolean {
  if (FORM_ONLY_REQUEST.test(request) && !PAYMENT_COMPLETION_WORD.test(request)) return false;
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
