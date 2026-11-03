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

import type { PlannerAction } from "./schema.ts";

export interface InteractiveElement {
  id: number;
  tag: string;
  role: string;
  label: string;
  type?: string;
  name?: string;
  placeholder?: string;
  value?: string;
  isSensitive: boolean;
  sensitiveReason?: string;
  selector?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  summary: string;
  interactiveElements: InteractiveElement[];
  timestamp: number;
}

/**
 * Regular expressions detecting sensitive credentials and PII:
 * Passwords, OTPs, PINs, CVVs, Credit/Debit Cards, Aadhaar numbers.
 */
export const SENSITIVE_PATTERNS = {
  password: /(password|passwd|passcode|secret|pin|mpin|tpin)/i,
  otp: /(otp|one[-\s_]?time[-\s_]?password|verification[-\s_]?code|auth[-\s_]?code)/i,
  paymentCard: /(card[_\s-]?no|card[_\s-]?number|cardnum|credit[_\s-]?card|debit[_\s-]?card|cvv|cvc|expiry|exp[_\s-]?date)/i,
  aadhaar: /(aadhaar|aadhar|uidai|unique[-\s_]?identification)/i,
  generalSensitive: /(ssn|pan[_\s-]?card|bank[_\s-]?acc|account[_\s-]?number)/i,
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
  /\b(yes|haan|ha|haa|sahi hai|theek hai|proceed|confirm|bharo|chukaao|kardo|kar do|approve|pay now)\b/i;

/**
 * Patterns identifying submit, payment, or irreversible actions requiring confirmation.
 */
export const CONSEQUENTIAL_PATTERNS =
  /\b(pay|payment|bharo|chukaao|submit|send|place order|checkout|confirm payment|karein|order now|transfer|debit)\b/i;

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
  safetyAlertSpeech?: string;
} {
  // Check action targeting an element
  if (action.action === "type" || action.action === "click" || action.action === "select") {
    const target = snapshot.interactiveElements.find((el) => el.id === action.id);

    if (!target) {
      return {
        permitted: false,
        requiresConfirmation: false,
        reason: `Element ID [${action.id}] does not exist in the current page snapshot.`,
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
          "यह पासवर्ड, ओटीपी या कार्ड फील्ड है। सुरक्षा के लिए कृपया इसे खुद भरें।",
      };
    }

    // MANDATORY RULE 2: Confirmation required before submit, payment, or send
    if (action.action === "click") {
      const isConsequential =
        target.type === "submit" ||
        CONSEQUENTIAL_PATTERNS.test(target.label) ||
        CONSEQUENTIAL_PATTERNS.test(target.name || "") ||
        CONSEQUENTIAL_PATTERNS.test(target.role || "");

      if (isConsequential) {
        return {
          permitted: true,
          requiresConfirmation: true,
          targetElement: target,
          reason: `Confirmation Required: Action '${target.label}' involves payment or form submission.`,
          safetyAlertSpeech: `क्या आप '${target.label}' की पुष्टि करना चाहते हैं? कृपया 'हाँ' कहें या Yes दबाएँ।`,
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
  return STOP_WORDS_REGEX.test(text.trim());
}

/**
 * Checks if user speech provides positive confirmation.
 */
export function isConfirmationCommand(text: string): boolean {
  return CONFIRMATION_WORDS_REGEX.test(text.trim());
}
