/**
 * Safety Rules and Policies for Browse Voice.
 *
 * Mandatory Rules Enforced:
 * 1. SENSITIVE FIELDS: Never read, type, store or speak passwords, OTPs, card numbers
 *    or Aadhaar numbers. Detect such fields (input type=password, name/label patterns)
 *    and instruct the user to fill them manually.
 * 2. CONFIRMATION GATING: Before any submit, payment, or send action, ask for spoken
 *    confirmation and wait for an explicit "yes" / "haan".
 * 3. EMERGENCY STOP: "ruko" / "stop" or the Stop button cancels speech and all pending
 *    actions immediately.
 * 4. ACTIVE SESSION: Only operate on pages the user has an active session with; show
 *    a clear "agent is active" indicator on the page.
 * 5. SECURE STORAGE: API keys live in chrome.storage.local. Never hardcode keys.
 */

import { isAllowedNavigationUrl, type PlannerAction } from "./schema.ts";
import { hasVisiblePaymentForm } from "./payment-state.ts";
import { classifyUserOnlyField, type UserOnlyCategory } from "./user-only.ts";

/** Normalized control kinds used by form observation and filling. */
export type FormControlKind =
  | "text"
  | "email"
  | "tel"
  | "number"
  | "date"
  | "password"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "combobox"
  | "listbox"
  | "file"
  | "contenteditable"
  | "button"
  | "other";

export interface InteractiveElement {
  id: number;
  tag: string;
  role: string;
  label: string;
  type?: string;
  name?: string;
  placeholder?: string;
  value?: string;
  checked?: boolean;
  options?: string[];
  selected?: string;
  description?: string;
  category?: UserOnlyCategory;
  groupIds?: number[];
  isSensitive: boolean;
  sensitiveReason?: string;
  selector?: string;
  /** Question / fieldset legend associated with this control when available. */
  question?: string;
  /** Normalized control family for form understanding. */
  controlKind?: FormControlKind;
  /** Radio / checkbox / ARIA group name when available. */
  groupName?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  /** Whether the control is currently visible and interactable. */
  interactable?: boolean;
  visible?: boolean;
  /** True for contenteditable / ARIA textboxes that are not native inputs. */
  contentEditable?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  summary: string;
  interactiveElements: InteractiveElement[];
  scrollY: number;
  scrollHeight: number;
  timestamp: number;
}

/**
 * Regular expressions detecting sensitive credentials and PII:
 * Passwords, OTPs, PINs, CVVs, Credit/Debit Cards, Aadhaar numbers.
 */
export const SENSITIVE_PATTERNS = {
  password: /(?:^|[^a-z0-9])(?:password|passwd|passcode|secret|pin(?!\s*code))(?:$|[^a-z0-9])/i,
  otp: /(?:^|[^a-z0-9])(?:otp|one[-\s_]?time[-\s_]?password|verification[-\s_]?code|auth[-\s_]?code)(?:$|[^a-z0-9])/i,
  paymentCard: /(?:^|[^a-z0-9])(?:card[_\s-]?(?:no|number|num)|credit[_\s-]?card|debit[_\s-]?card|cvv|cvc|expiry|exp[_\s-]?date|upi[_\s-]?(?:id|pin)|vpa|virtual[-\s_]?payment[-\s_]?address|mpin|tpin)(?:$|[^a-z0-9])/i,
  aadhaar: /(?:^|[^a-z0-9])(?:aadhaar|aadhar|uidai|unique[-\s_]?identification)(?:$|[^a-z0-9])/i,
  generalSensitive: /(?:^|[^a-z0-9])(?:ssn|pan[_\s-]?card|bank[_\s-]?acc|account[_\s-]?number)(?:$|[^a-z0-9])/i,
};

/**
 * Words that trigger immediate emergency cancellation of the agent loop.
 * Covers Hindi, Hinglish, and English commands.
 */
export const STOP_WORDS_REGEX =
  /\b(ruko|ruk|roko|stop|cancel|bas|thehro|pause|band karo|chup|khatam)\b/i;

/**
 * Words that confirm a pending consequential/submit/payment action.
 */
export const CONFIRMATION_WORDS_REGEX =
  /\b(?:yes|yeah|yep|ok|okay|sure|go ahead|do it|haan(?:\s+ji)?|ha|haa|kar do|karo|theek hai|sahi hai|proceed|confirm|approve|pay now)\b|ठीक है|सही है|जी|हाँ|हां/i;

export const NEGATIVE_CONFIRMATION_WORDS_REGEX =
  /\b(?:no|nope|nah|nahi|cancel|mat karo|don't|do not|not okay|never)\b|नहीं/i;

/**
 * Patterns identifying submit, payment, or irreversible actions requiring confirmation.
 */
export const CONSEQUENTIAL_PATTERNS =
  /\b(?:pay|payment|bharo|bharna|chukaao|submit|send|place order|checkout|confirm payment|order now|buy now|book now|donate|delete|remove account|complete purchase|confirm booking|authorize|apply|subscribe|unsubscribe|proceed to pay|transfer|debit)\b|भुगतान|खरीद(?:ें|ो)?|बुक(?: करें| करो)?|दान|हटाएं|खाता हटाएं|खरीद पूरी|बुकिंग की पुष्टि|अधिकृत|आवेदन करें|सब्सक्राइब|अनसब्सक्राइब|भुगतान पर जाएं/i;

/**
 * Checks whether an interactive DOM element represents a sensitive credential or PII.
 */
export function detectSensitiveField(field: {
  type?: string;
  name?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  autocomplete?: string;
}): { isSensitive: boolean; reason?: string } {
  // Input type = password is always sensitive
  if (field.type === "password") {
    return { isSensitive: true, reason: "Password field (input[type=password])" };
  }

  // Autocomplete hints
  const ac = (field.autocomplete || "").toLowerCase();
  if (ac.includes("password") || ac.includes("current-password") || ac.includes("new-password")) {
    return { isSensitive: true, reason: "Password autocomplete field" };
  }
  if (ac.includes("one-time-code") || ac.includes("otp")) {
    return { isSensitive: true, reason: "One-Time Password (OTP) field" };
  }
  if (ac.includes("cc-number") || ac.includes("cc-csc") || ac.includes("cc-exp")) {
    return { isSensitive: true, reason: "Credit/Debit Card field" };
  }

  // Inspect combined identifier text
  const identifierText = [
    field.name || "",
    field.id || "",
    field.label || "",
    field.placeholder || "",
  ].join(" ").toLowerCase();

  if (SENSITIVE_PATTERNS.password.test(identifierText)) {
    return { isSensitive: true, reason: "Password / PIN field pattern" };
  }
  if (SENSITIVE_PATTERNS.otp.test(identifierText)) {
    return { isSensitive: true, reason: "OTP / Verification code field pattern" };
  }
  if (SENSITIVE_PATTERNS.paymentCard.test(identifierText)) {
    return { isSensitive: true, reason: "Card number / CVV field pattern" };
  }
  if (SENSITIVE_PATTERNS.aadhaar.test(identifierText)) {
    return { isSensitive: true, reason: "Aadhaar number field pattern" };
  }
  if (SENSITIVE_PATTERNS.generalSensitive.test(identifierText)) {
    return { isSensitive: true, reason: "Sensitive financial / ID pattern" };
  }

  return { isSensitive: false };
}

/**
 * Masks sensitive values in snapshots to prevent reading or logging credentials.
 */
export function maskSensitiveValue(value: string | undefined, isSensitive: boolean): string {
  if (!value) return "";
  if (isSensitive) return "[REDACTED_SENSITIVE]";
  return value;
}

/**
 * Safety check on an intended planner action:
 * Returns whether the action is permitted, blocked, or requires confirmation.
 */
export function inspectActionSafety(
  action: PlannerAction,
  snapshot: PageSnapshot
): {
  permitted: boolean;
  requiresConfirmation: boolean;
  reason?: string;
  targetElement?: InteractiveElement;
  handoff?: { fields: InteractiveElement[]; category: UserOnlyCategory };
  safetyAlertSpeech?: string;
} {
  // Check action targeting an element
  if (action.action === "navigate" && !isAllowedNavigationUrl(action.url)) {
    return {
      permitted: false,
      requiresConfirmation: false,
      reason: "Safety Block: Navigation is limited to http(s) URLs.",
      safetyAlertSpeech: "I can only open secure or normal web addresses starting with HTTP or HTTPS.",
    };
  }

  if (action.action === "type" || action.action === "click" || action.action === "select" || action.action === "press_key") {
    const target = action.action === "press_key" ? undefined : snapshot.interactiveElements.find((el) => el.id === action.id);
    if (action.action === "press_key") return { permitted: true, requiresConfirmation: false };

    if (!target) {
      return {
        permitted: false,
        requiresConfirmation: false,
        reason: `Element ID [${action.id}] does not exist in the current page snapshot.`,
      };
    }

    const classification = classifyUserOnlyField(target, snapshot.summary);
    if (classification.isUserOnly) {
      const ids = new Set([target.id, ...(target.groupIds || [])]);
      const fields = snapshot.interactiveElements.filter((element) => ids.has(element.id) || element.groupIds?.includes(target.id));
      return {
        permitted: false,
        requiresConfirmation: false,
        targetElement: target,
        handoff: { fields, category: target.category || classification.category || "private" },
        reason: target.isSensitive
          ? `Safety Block: Cannot handle sensitive field (${target.sensitiveReason || "private information"}).`
          : "User-only information must be provided directly by the user.",
        safetyAlertSpeech: target.isSensitive
          ? "This is a password, OTP, or sensitive field. For your security, please fill it manually."
          : undefined,
      };
    }

    // MANDATORY RULE 1: Never type into sensitive fields
    if (action.action === "type" && target.isSensitive) {
      return {
        permitted: false,
        requiresConfirmation: false,
        targetElement: target,
        reason: `Safety Block: Cannot type into sensitive field (${target.sensitiveReason || "Password/OTP/Card/Aadhaar"}).`,
        safetyAlertSpeech:
          "This is a password, OTP, or card field. For your security, please fill it manually.",
      };
    }

    // MANDATORY RULE 2: Confirmation required before submit, payment, or send
    if (action.action === "click") {
      const isConsequential =
        target.type === "submit" ||
        hasVisiblePaymentForm(snapshot) ||
        CONSEQUENTIAL_PATTERNS.test(target.label) ||
        CONSEQUENTIAL_PATTERNS.test(target.name || "") ||
        CONSEQUENTIAL_PATTERNS.test(target.role || "");

      if (isConsequential) {
        return {
          permitted: true,
          requiresConfirmation: true,
          targetElement: target,
          reason: `Confirmation Required: Action '${target.label}' involves payment or form submission.`,
          safetyAlertSpeech: `Do you want to confirm '${target.label}'? Say yes or press Confirm.`,
        };
      }
    }

    return { permitted: true, requiresConfirmation: false, targetElement: target };
  }

  return { permitted: true, requiresConfirmation: false };
}

/**
 * Checks if user speech is an emergency stop command.
 */
export function isStopCommand(text: string): boolean {
  const normalized = text.trim().replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ");
  if (!normalized) return false;
  const words = normalized.split(" ");
  return words.length <= 3 && /^(?:ruko|ruk|roko|stop|cancel|bas|thehro|pause|band\s+karo|chup|khatam)\b/i.test(normalized);
}

/**
 * Checks if user speech provides positive confirmation.
 */
export function isConfirmationCommand(text: string): boolean {
  const normalized = text.trim().replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ");
  if (!normalized || NEGATIVE_CONFIRMATION_WORDS_REGEX.test(normalized)) return false;
  return CONFIRMATION_WORDS_REGEX.test(normalized);
}

/** Returns true only for an explicit negative answer to a pending confirmation. */
export function isCancellationCommand(text: string): boolean {
  return NEGATIVE_CONFIRMATION_WORDS_REGEX.test(text.trim());
}
