import { USER_ONLY_LEXICON } from "./user-only-lexicon.ts";

export type UserOnlyCategory = "credential" | "one_time_code" | "payment_instrument" | "payment_method_choice" | "government_id" | "private";
export interface UserOnlyElement {
  id?: number; tag?: string; role?: string; type?: string; name?: string; label?: string; placeholder?: string;
  autocomplete?: string; inputmode?: string; maxlength?: number; pattern?: string; value?: string;
  options?: string[]; selected?: string; description?: string; category?: UserOnlyCategory; isSensitive?: boolean;
}
export interface UserOnlyClassification { isUserOnly: boolean; category?: UserOnlyCategory; confidence: number; humanKind: string }

function termMatches(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export function classifyUserOnlyField(element: UserOnlyElement, pageContext = ""): UserOnlyClassification {
  if (element.isSensitive || element.category) return { isUserOnly: true, category: element.category || "private", confidence: 1, humanKind: element.category || "private information" };
  const idText = [element.label, element.name, element.placeholder, element.description, element.autocomplete].filter(Boolean).join(" ");
  const ac = (element.autocomplete || "").toLowerCase();
  const flags: Array<[UserOnlyCategory, string[], number]> = [
    ["credential", ["current-password", "new-password", "password"], 1],
    ["one_time_code", ["one-time-code"], 1],
    ["payment_instrument", ["cc-number", "cc-csc", "cc-exp", "cc-name"], 1],
  ];
  for (const [category, tokens, confidence] of flags) if (tokens.some((token) => ac.split(/\s+/).includes(token))) return { isUserOnly: true, category, confidence, humanKind: category.replaceAll("_", " ") };
  if (element.type === "password") return { isUserOnly: true, category: "credential", confidence: 1, humanKind: "credential" };
  const categories = ["credential", "one_time_code", "payment_instrument", "payment_method_choice", "government_id"] as const;
  for (const category of categories) {
    const dictionary = USER_ONLY_LEXICON[category];
    if (Object.values(dictionary).flat().some((term) => termMatches(idText, term))) return { isUserOnly: true, category, confidence: 0.95, humanKind: category.replaceAll("_", " ") };
  }
  const paymentContext = Object.values(USER_ONLY_LEXICON.payment_context).flat().some((term) => termMatches(pageContext, term));
  const numericHint = /numeric|decimal|tel/i.test(`${element.inputmode || ""} ${element.type || ""}`);
  const limit = element.maxlength || (element.maxlength === 0 ? 0 : undefined);
  const format = `${element.placeholder || ""} ${element.pattern || ""}`;
  const value = element.value || "";
  const isFormField = /^(input|textarea|select)$/i.test(element.tag || "");
  if (paymentContext && isFormField && ((numericHint && (limit === undefined || (limit >= 4 && limit <= 19))) || /\d{12,19}/.test(format) || /\d{12,19}/.test(value))) return { isUserOnly: true, category: "payment_instrument", confidence: 0.82, humanKind: "payment detail" };
  const isPaymentMethodControl =
    element.tag === "select" ||
    (element.tag === "input" && /radio|checkbox/i.test(`${element.type || ""} ${element.role || ""}`)) ||
    element.role === "tab";
  if (paymentContext && isPaymentMethodControl && (element.options?.length || /method|pay|payment/i.test(idText))) return { isUserOnly: true, category: "payment_method_choice", confidence: 0.85, humanKind: "payment method choice" };
  if (paymentContext && isFormField && !/name|address|city|mobile|phone|email|search|coupon|pin\s*code|postal|shipping/i.test(idText)) return { isUserOnly: true, category: "private", confidence: 0.6, humanKind: "private payment detail" };
  return { isUserOnly: false, confidence: 0, humanKind: "" };
}
