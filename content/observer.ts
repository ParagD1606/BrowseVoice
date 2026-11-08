/**
 * Page Observer for Browse Voice Content Script.
 *
 * Requirements:
 * - Returns a compact snapshot:
 *   1. URL
 *   2. Title
 *   3. Visible text summary
 *   4. List of interactive elements, each with numeric id, role, label, type,
 *      and current value (sensitive values masked).
 */

import {
  detectSensitiveField,
  maskSensitiveValue,
  type InteractiveElement,
  type PageSnapshot,
} from "../lib/safety";
import { hasPaymentReceipt } from "../lib/payment-state";
import { classifyUserOnlyField } from "../lib/user-only";

// Store assigned DOM element references in a WeakMap / Map keyed by numeric ID
const elementRegistry = new Map<number, HTMLElement>();

/**
 * Checks whether an element is visible to the user.
 */
function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;

  const style = window.getComputedStyle(el);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;

  return true;
}

/**
 * Extracts a readable accessible label for an element.
 */
function getElementLabel(el: HTMLElement): string {
  // 1. ARIA label or labelledby
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  // 2. Associated label element for inputs
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (labelEl && labelEl.textContent?.trim()) {
        return labelEl.textContent.trim();
      }
    }
    const parentLabel = el.closest("label");
    if (parentLabel && parentLabel.textContent?.trim()) {
      return parentLabel.textContent.trim();
    }
  }

  // 3. Placeholder or title attribute
  const placeholder = el.getAttribute("placeholder");
  if (placeholder && placeholder.trim()) return placeholder.trim();

  const title = el.getAttribute("title");
  if (title && title.trim()) return title.trim();

  // 4. Value of submit/button inputs
  if (el instanceof HTMLInputElement && (el.type === "button" || el.type === "submit")) {
    if (el.value && el.value.trim()) return el.value.trim();
  }

  // 5. Inner text content (truncated to reasonable size)
  const text = el.innerText || el.textContent || "";
  if (text.trim()) {
    return text.trim().replace(/\s+/g, " ").slice(0, 80);
  }

  return el.tagName.toLowerCase();
}

/**
 * Traverses the DOM including open Shadow DOM roots and gathers candidate interactive elements.
 */
function collectInteractiveCandidates(root: Document | ShadowRoot): HTMLElement[] {
  const selector = [
    "button",
    "a[href]",
    "input",
    "select",
    "textarea",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='combobox']",
    "[tabindex='0']",
  ].join(", ");

  const results: HTMLElement[] = [];
  const found = Array.from(root.querySelectorAll<HTMLElement>(selector));

  for (const el of found) {
    if (isElementVisible(el)) {
      results.push(el);
    }
    // Deep inspect Shadow DOM if attached
    if (el.shadowRoot) {
      results.push(...collectInteractiveCandidates(el.shadowRoot));
    }
  }

  return results;
}

/**
 * Generates a concise textual summary of the visible page.
 */
function extractPageSummary(): string {
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .filter((el) => isElementVisible(el as HTMLElement))
    .map((el) => (el as HTMLElement).innerText?.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(" | ");

  const fullBodyText = document.body?.innerText?.replace(/\s+/g, " ") || "";
  const bodyText = fullBodyText.slice(0, 400);
  const receiptEvidence = hasPaymentReceipt(fullBodyText)
    ? "Visible payment receipt or order confirmation evidence detected."
    : "";

  return [headings ? `${headings} - ${bodyText}` : bodyText, receiptEvidence]
    .filter(Boolean)
    .join(" | ");
}

/**
 * Captures the current page snapshot and assigns fresh numeric IDs.
 */
export function capturePageSnapshot(): PageSnapshot {
  elementRegistry.clear();
  let nextId = 1;

  const rawElements = collectInteractiveCandidates(document);
  const interactiveElements: InteractiveElement[] = [];

  const pageContext = `${document.title} ${document.body?.innerText?.slice(0, 2500) || ""}`;
  for (const el of rawElements) {
    const id = nextId++;
    elementRegistry.set(id, el);

    // Annotate element with data-browse-voice-id for debugging and highlights
    el.setAttribute("data-browse-voice-id", String(id));

    const tag = el.tagName.toLowerCase();
    const type = el instanceof HTMLInputElement ? el.type.toLowerCase() : undefined;
    const name = el.getAttribute("name") || el.getAttribute("id") || undefined;
    const placeholder = el.getAttribute("placeholder") || undefined;
    const label = getElementLabel(el);
    const role = el.getAttribute("role") || tag;

    // Detect sensitive field (password, OTP, card, Aadhaar)
    const sensitivity = detectSensitiveField({
      type,
      name,
      id: el.id,
      label,
      placeholder,
      autocomplete: el.getAttribute("autocomplete") || undefined,
    });

    const description = [placeholder, el.getAttribute("aria-describedby") ? document.getElementById(el.getAttribute("aria-describedby")!)?.textContent : "", el.closest("fieldset")?.querySelector("legend")?.textContent, el.closest("section,[role=dialog],form")?.getAttribute("aria-label")].filter(Boolean).join(" · ").slice(0, 180);
    const classification = classifyUserOnlyField({ id, tag, role, type, name, label, placeholder, autocomplete: el.getAttribute("autocomplete") || undefined, inputmode: el.getAttribute("inputmode") || undefined, maxlength: el instanceof HTMLInputElement ? el.maxLength : undefined, pattern: el instanceof HTMLInputElement ? el.pattern : undefined, description, options: el instanceof HTMLSelectElement ? Array.from(el.options).map((option) => option.text) : undefined, isSensitive: sensitivity.isSensitive }, `${pageContext} ${description}`);
    const isUserOnly = sensitivity.isSensitive || classification.isUserOnly;

    // Extract value (and mask if sensitive)
    let rawValue: string | undefined;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      rawValue = el.value;
    }
    const safeValue = maskSensitiveValue(rawValue, isUserOnly);

    interactiveElements.push({
      id,
      tag,
      role,
      label,
      type,
      name,
      placeholder,
      value: safeValue,
      checked: el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? el.checked : undefined,
      options: el instanceof HTMLSelectElement
        ? Array.from(el.options).map((option) => option.text.trim()).filter(Boolean).slice(0, 30)
        : undefined,
      selected: el instanceof HTMLSelectElement ? el.selectedOptions[0]?.text.trim() || undefined : undefined,
      isSensitive: isUserOnly,
      sensitiveReason: sensitivity.reason || (classification.isUserOnly ? `User-only ${classification.category || "private"} field` : undefined),
      description,
      category: sensitivity.isSensitive ? "credential" : classification.category,
    });
  }

  return {
    url: window.location.href,
    title: document.title,
    summary: extractPageSummary(),
    interactiveElements,
    scrollY: Math.round(window.scrollY / 50) * 50,
    scrollHeight: document.documentElement.scrollHeight,
    timestamp: Date.now(),
  };
}

/**
 * Resolves a numeric element ID back to the live DOM HTMLElement.
 */
export function getElementById(id: number): HTMLElement | undefined {
  const cached = elementRegistry.get(id);
  if (cached && cached.isConnected) return cached;

  // Fallback: search by attribute data-browse-voice-id
  const byAttr = document.querySelector<HTMLElement>(`[data-browse-voice-id="${id}"]`);
  if (byAttr) {
    elementRegistry.set(id, byAttr);
    return byAttr;
  }

  return undefined;
}
