/**
 * Context-aware form value handling.
 *
 * Speech recognition is allowed to translate natural language, but values that
 * identify an account, endpoint, person, or record must be copied byte-for-byte
 * once they are recognized. This module is deliberately based on the target
 * field's HTML/accessibility context rather than a dictionary of English words.
 */

import type { InteractiveElement } from "./safety.ts";

export type FormValueKind =
  | "email"
  | "url"
  | "upi"
  | "phone"
  | "numeric"
  | "account"
  | "username"
  | "technical"
  | "text";

export interface FormValueContext {
  label?: string;
  type?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  autocomplete?: string;
  inputMode?: string;
  role?: string;
}

export interface ExactValueCandidate {
  value: string;
  kind: FormValueKind;
}

export interface FormValueDecision {
  expectedKind: FormValueKind;
  requiresExactValue: boolean;
  exactValue?: string;
  ambiguous: boolean;
  reason?: string;
}

const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const URL_PATTERN = /^(?:(?:https?:\/\/|www\.)[^\s]+|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[^\s]*)?)$/i;
const UPI_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
const PHONE_PATTERN = /^\+?[0-9][0-9() .-]{5,}$/;
const NUMERIC_PATTERN = /^[0-9]+$/;
const TOKEN_PATTERN = /(?:https?:\/\/|www\.)[^\s,;]+|\+?[A-Za-z0-9]+(?:[._@:/?#%+\-=~][A-Za-z0-9._@:/?#%+\-=~]*)+|[A-Za-z0-9]{2,}/g;

function contextText(context: FormValueContext): string {
  return [
    context.type,
    context.name,
    typeof context.id === "string" ? context.id : undefined,
    context.label,
    context.placeholder,
    context.autocomplete,
    context.inputMode,
    context.role,
  ].filter(Boolean).join(" ").toLowerCase();
}

/** Classifies what a field expects from its HTML and accessible metadata. */
export function classifyFormValue(context: FormValueContext): FormValueKind {
  const text = contextText(context);
  const type = (context.type || "").toLowerCase();
  const autocomplete = (context.autocomplete || "").toLowerCase();

  if (type === "email" || autocomplete.includes("email") || /\b(e-mail|email|मेल)\b/i.test(text)) return "email";
  if (type === "url" || autocomplete.includes("url") || /\b(url|website|web address|domain|वेबसाइट|डोमेन)\b/i.test(text)) return "url";
  if (/\b(upi|vpa|virtual payment address)\b/i.test(text)) return "upi";
  if (type === "tel" || autocomplete.includes("tel") || /\b(phone|mobile|telephone|contact number|फ़ोन|फोन|मोबाइल)\b/i.test(text)) return "phone";
  if (type === "number" || context.inputMode === "numeric" || /numeric|\b(pin|zip|postal|pincode|consumer number|reference number|account number|खाता|संख्या|नंबर)\b/i.test(text)) return "numeric";
  if (/\b(account|customer|consumer|reference|record|member|policy|connection|खाता|ग्राहक|सदस्य)\b/i.test(text)) return "account";
  if (autocomplete.includes("username") || /\b(username|user name|login id|handle|उपयोगकर्ता नाम)\b/i.test(text)) return "username";
  if (/\b(api\s*(key|token)|access\s*key|token|verification code|identifier|program(?:ming)? term|technical (?:term|identifier)|code)\b/i.test(text)) return "technical";
  return "text";
}

function candidateKind(value: string): FormValueKind {
  if (EMAIL_PATTERN.test(value)) return "email";
  if (URL_PATTERN.test(value)) return "url";
  if (UPI_PATTERN.test(value)) return "upi";
  if (NUMERIC_PATTERN.test(value)) return "numeric";
  if (PHONE_PATTERN.test(value) && /[0-9]/.test(value)) return "phone";
  return /[._:/?#%+\-=~]/.test(value) || /\d/.test(value) ? "technical" : "text";
}

/** Extracts only values that can be copied exactly from the recognized text. */
export function extractExactValueCandidates(text: string): ExactValueCandidate[] {
  const candidates: ExactValueCandidate[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const value = match[0].replace(/[.,;!?]+$/g, "");
    if (!value) continue;
    candidates.push({ value, kind: candidateKind(value) });
  }
  return candidates;
}

/**
 * Combines a final transcript with an alternate STT transcript without
 * translating either one. Only structured, exact-value candidates from the
 * alternate source are added, so natural-language sentences are not duplicated.
 */
export function mergeTranscriptsPreservingIdentifiers(primary: string, alternate: string): string {
  const hints = extractExactValueCandidates(alternate)
    .filter((candidate) => candidate.kind !== "text" && (candidate.kind !== "numeric" || candidate.value.length >= 4))
    .map((candidate) => candidate.value)
    .filter((value, index, values) => values.indexOf(value) === index && !primary.includes(value));
  return [primary.trim(), ...hints].filter(Boolean).join(" ");
}

function contextTerms(context: FormValueContext): Set<string> {
  // Examples in placeholders (e.g. "e.g. 100234567") are field guidance,
  // not field names. They must never cause a real spoken value to be dropped.
  return new Set([
    context.type,
    context.name,
    typeof context.id === "string" ? context.id : undefined,
    context.label,
    context.autocomplete,
    context.inputMode,
    context.role,
  ].filter(Boolean).join(" ").toLowerCase().match(/[a-z0-9]+/g) || []);
}

function compatible(candidate: ExactValueCandidate, expected: FormValueKind): boolean {
  if (expected === "email") return candidate.kind === "email";
  if (expected === "url") return candidate.kind === "url";
  if (expected === "upi") return candidate.kind === "upi";
  if (expected === "phone") return candidate.kind === "phone" || candidate.kind === "numeric";
  if (expected === "numeric" || expected === "account") return candidate.kind === "numeric" || candidate.kind === "technical";
  if (expected === "username" || expected === "technical") return candidate.kind !== "text" || candidate.value.length > 0;
  return false;
}

/**
 * Resolves an exact value without changing its case, punctuation, or script.
 * A non-Latin transcript for an exact-value field is intentionally ambiguous:
 * transliteration is not reversible and must never be entered silently.
 */
export function resolveFormValue(text: string, context: FormValueContext): FormValueDecision {
  const expectedKind = classifyFormValue(context);
  const requiresExactValue = expectedKind !== "text";
  if (!requiresExactValue) {
    return { expectedKind, requiresExactValue, ambiguous: false };
  }

  const terms = contextTerms(context);
  const candidates = extractExactValueCandidates(text)
    .filter((candidate) => !terms.has(candidate.value.toLowerCase()))
    .filter((candidate) => compatible(candidate, expectedKind));

  // Prefer the most structured/longest candidate. This supports sentences such
  // as "मेरी UPI ID is upi@bank" without any site-specific vocabulary.
  let exactValue: string | undefined;
  if (expectedKind === "username" || expectedKind === "technical") {
    // For plain usernames/terms, use the text after the last field-context
    // term ("username alice", "API key sk-...") rather than a dictionary of
    // words that may or may not be natural-language instructions.
    const lowerText = text.toLowerCase();
    const lastContextPosition = [...terms]
      .map((term) => lowerText.lastIndexOf(term))
      .reduce((max, position) => Math.max(max, position), -1);
    const trailing = lastContextPosition >= 0 ? text.slice(lastContextPosition) : text;
    const trailingCandidates = extractExactValueCandidates(trailing)
      .filter((candidate) => !terms.has(candidate.value.toLowerCase()));
    exactValue = trailingCandidates.at(-1)?.value;
  }
  exactValue ||= candidates
    .sort((a, b) => (Number(b.kind !== "technical") - Number(a.kind !== "technical")) || b.value.length - a.value.length)[0]?.value;
  if (exactValue) {
    return { expectedKind, requiresExactValue, exactValue, ambiguous: false };
  }

  return {
    expectedKind,
    requiresExactValue,
    ambiguous: true,
    reason: /[^\x00-\x7F]/.test(text)
      ? "Speech recognition returned translated or transliterated text and the exact identifier cannot be recovered."
      : "The exact value for this identifier field was not detected.",
  };
}

export function contextFromElement(element: InteractiveElement): FormValueContext {
  return {
    label: element.label,
    type: element.type,
    name: element.name,
    id: element.selector || element.name,
    placeholder: element.placeholder,
    inputMode: element.inputMode,
    role: element.role,
  };
}

/** Writes an exact string through the native value setter used by the page. */
export function setExactTextValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** Returns a planner-safe action value, or an ask-user action when it is unsafe. */
export function preserveExactPlannerValue<T extends { action: string; id?: number; text?: string }>(
  action: T,
  userText: string,
  target?: InteractiveElement,
): T | { action: "ask_user"; question: string; rationale: string } {
  if (action.action !== "type" || typeof action.text !== "string" || !target || target.isSensitive) return action;
  const decision = resolveFormValue(userText, contextFromElement(target));
  if (!decision.requiresExactValue) return action;
  if (decision.exactValue !== undefined) return { ...action, text: decision.exactValue };
  if (decision.ambiguous) {
    return {
      action: "ask_user",
      question: `I could not recover the exact ${decision.expectedKind} from speech. Please repeat it using its original English characters, including symbols such as @, dot, underscore, or hyphen.`,
      rationale: decision.reason || "Exact identifier confirmation is required.",
    };
  }
  return action;
}
