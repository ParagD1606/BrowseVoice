/**
 * Page Observer for Browse Voice Content Script.
 *
 * Returns a compact snapshot with interactive controls discovered from
 * native HTML, ARIA widgets, contenteditable fields, and open Shadow DOM.
 * Avoids dumping full page HTML to the LLM — only structured, visible data.
 */

import {
  detectSensitiveField,
  maskSensitiveValue,
  type FormControlKind,
  type InteractiveElement,
  type PageSnapshot,
} from "../lib/safety";
import { hasPaymentReceipt } from "../lib/payment-state";
import { classifyUserOnlyField } from "../lib/user-only";

const elementRegistry = new Map<number, HTMLElement>();

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

function resolveDescribedBy(el: HTMLElement): string {
  const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
  if (!ids.length) return "";
  return ids
    .map((id) => document.getElementById(id)?.textContent?.trim() || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function resolveLabelledBy(el: HTMLElement): string {
  const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
  if (!ids.length) return "";
  return ids
    .map((id) => document.getElementById(id)?.textContent?.trim() || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

function nearbyQuestionText(el: HTMLElement): string {
  const labelledBy = resolveLabelledBy(el);
  if (labelledBy) return labelledBy;

  const fieldset = el.closest("fieldset");
  const legend = fieldset?.querySelector("legend")?.textContent?.trim();
  if (legend) return legend.replace(/\s+/g, " ").slice(0, 160);

  const group = el.closest("[role='group'],[role='radiogroup'],[data-params],.freebirdFormviewerComponentsQuestionBaseRoot,[jsname]");
  if (group) {
    const heading = group.querySelector(
      "[role='heading'],h1,h2,h3,h4,legend,.freebirdFormviewerComponentsQuestionBaseTitle,[data-value][role='heading']",
    ) as HTMLElement | null;
    const headingText = heading?.innerText?.trim() || heading?.textContent?.trim();
    if (headingText) return headingText.replace(/\s+/g, " ").slice(0, 160);

    const aria = group.getAttribute("aria-label");
    if (aria?.trim()) return aria.trim().slice(0, 160);
  }

  let sibling: Element | null = el.previousElementSibling;
  for (let i = 0; i < 3 && sibling; i += 1, sibling = sibling.previousElementSibling) {
    const text = (sibling as HTMLElement).innerText?.trim() || sibling.textContent?.trim() || "";
    if (text && text.length <= 160 && !/^(yes|no|haan|नहीं)$/i.test(text)) {
      return text.replace(/\s+/g, " ");
    }
  }

  const parent = el.parentElement;
  if (parent) {
    const parentLabel = parent.querySelector("label,.question,.form-label") as HTMLElement | null;
    const text = parentLabel?.innerText?.trim();
    if (text) return text.replace(/\s+/g, " ").slice(0, 160);
  }

  return "";
}

function getElementLabel(el: HTMLElement): string {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  const labelledBy = resolveLabelledBy(el);
  if (labelledBy) return labelledBy;

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (labelEl && labelEl.textContent?.trim()) {
        return labelEl.textContent.trim().replace(/\s+/g, " ");
      }
    }
    const parentLabel = el.closest("label");
    if (parentLabel && parentLabel.textContent?.trim()) {
      return parentLabel.textContent.trim().replace(/\s+/g, " ").slice(0, 120);
    }
  }

  const placeholder = el.getAttribute("placeholder");
  if (placeholder && placeholder.trim()) return placeholder.trim();

  const title = el.getAttribute("title");
  if (title && title.trim()) return title.trim();

  if (el instanceof HTMLInputElement && (el.type === "button" || el.type === "submit")) {
    if (el.value && el.value.trim()) return el.value.trim();
  }

  // Prefer short option/button text for radios/checkboxes; avoid dumping large containers.
  const role = (el.getAttribute("role") || "").toLowerCase();
  if (role === "radio" || role === "checkbox" || role === "option" || role === "menuitemradio") {
    const text = el.innerText || el.textContent || "";
    if (text.trim()) return text.trim().replace(/\s+/g, " ").slice(0, 80);
  }

  const text = el.innerText || el.textContent || "";
  if (text.trim()) {
    return text.trim().replace(/\s+/g, " ").slice(0, 80);
  }

  return el.tagName.toLowerCase();
}

function inferControlKind(el: HTMLElement): FormControlKind {
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute("role") || "").toLowerCase();
  const type = el instanceof HTMLInputElement ? el.type.toLowerCase() : "";

  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  if (el.isContentEditable || role === "textbox") {
    if (tag === "input") {
      if (type === "email") return "email";
      if (type === "tel") return "tel";
      if (type === "number") return "number";
      if (type === "date" || type === "datetime-local") return "date";
      if (type === "password") return "password";
      return "text";
    }
    return el.isContentEditable ? "contenteditable" : "text";
  }
  if (role === "combobox") return "combobox";
  if (role === "listbox") return "listbox";
  if (role === "checkbox" || type === "checkbox") return "checkbox";
  if (role === "radio" || role === "menuitemradio" || type === "radio") return "radio";
  if (type === "file") return "file";
  if (type === "password") return "password";
  if (type === "email") return "email";
  if (type === "tel") return "tel";
  if (type === "number") return "number";
  if (type === "date" || type === "datetime-local") return "date";
  if (tag === "button" || role === "button" || type === "submit" || type === "button") return "button";
  if (tag === "input") return "text";
  return "other";
}

function collectOptions(el: HTMLElement): string[] | undefined {
  if (el instanceof HTMLSelectElement) {
    return Array.from(el.options).map((option) => option.text.trim()).filter(Boolean).slice(0, 40);
  }

  const role = (el.getAttribute("role") || "").toLowerCase();
  if (role === "listbox" || role === "combobox" || role === "radiogroup" || role === "group") {
    const options = Array.from(
      el.querySelectorAll<HTMLElement>("[role='option'],[role='radio'],[role='menuitemradio'],[role='checkbox']"),
    )
      .filter((option) => isElementVisible(option))
      .map((option) => getElementLabel(option))
      .filter(Boolean)
      .slice(0, 40);
    if (options.length) return options;
  }

  // Custom dropdowns often keep options in a sibling listbox / popup.
  const listboxId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
  if (listboxId) {
    const listbox = document.getElementById(listboxId);
    if (listbox) {
      const options = Array.from(listbox.querySelectorAll<HTMLElement>("[role='option']"))
        .map((option) => getElementLabel(option))
        .filter(Boolean)
        .slice(0, 40);
      if (options.length) return options;
    }
  }

  return undefined;
}

function readCheckedState(el: HTMLElement): boolean | undefined {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    return el.checked;
  }
  const ariaChecked = el.getAttribute("aria-checked");
  if (ariaChecked === "true") return true;
  if (ariaChecked === "false") return false;
  if (el.getAttribute("aria-pressed") === "true") return true;
  if (el.getAttribute("aria-pressed") === "false") return false;
  if (el.classList.contains("is-checked") || el.classList.contains("selected")) return true;
  return undefined;
}

function readCurrentValue(el: HTMLElement, controlKind: FormControlKind): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return el.value;
  }
  if (controlKind === "contenteditable" || el.isContentEditable || (el.getAttribute("role") || "").toLowerCase() === "textbox") {
    return (el.innerText || el.textContent || "").trim().slice(0, 500);
  }
  if (controlKind === "combobox" || controlKind === "listbox") {
    const selected = el.querySelector("[aria-selected='true'],[role='option'][aria-selected='true']") as HTMLElement | null;
    if (selected) return getElementLabel(selected);
    return el.getAttribute("data-value") || el.getAttribute("value") || undefined;
  }
  return undefined;
}

function isInteractable(el: HTMLElement): boolean {
  if (!isElementVisible(el)) return false;
  if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement) {
    if (el.disabled) return false;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.readOnly) return false;
  }
  return true;
}

function collectInteractiveCandidates(root: Document | ShadowRoot): HTMLElement[] {
  const selector = [
    "button",
    "a[href]",
    "input",
    "select",
    "textarea",
    "[contenteditable='true']",
    "[contenteditable='']",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='menuitemradio']",
    "[role='combobox']",
    "[role='listbox']",
    "[role='option']",
    "[role='textbox']",
    "[role='switch']",
    "[role='searchbox']",
    "[tabindex='0']",
  ].join(", ");

  const results: HTMLElement[] = [];
  const found = Array.from(root.querySelectorAll<HTMLElement>(selector));

  for (const el of found) {
    if (isElementVisible(el)) {
      results.push(el);
    }
    if (el.shadowRoot) {
      results.push(...collectInteractiveCandidates(el.shadowRoot));
    }
  }

  return results;
}

function extractPageSummary(): string {
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .filter((el) => isElementVisible(el as HTMLElement))
    .map((el) => (el as HTMLElement).innerText?.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(" | ");

  const formQuestions = Array.from(
    document.querySelectorAll(
      "legend,[role='heading'],.freebirdFormviewerComponentsQuestionBaseTitle,label",
    ),
  )
    .filter((el) => isElementVisible(el as HTMLElement))
    .map((el) => (el as HTMLElement).innerText?.trim().replace(/\s+/g, " "))
    .filter((text) => Boolean(text) && (text?.length || 0) <= 140)
    .slice(0, 12)
    .join(" · ");

  const fullBodyText = document.body?.innerText?.replace(/\s+/g, " ") || "";
  const bodyText = fullBodyText.slice(0, 500);
  const receiptEvidence = hasPaymentReceipt(fullBodyText)
    ? "Visible payment receipt or order confirmation evidence detected."
    : "";

  return [headings, formQuestions, bodyText, receiptEvidence].filter(Boolean).join(" | ").slice(0, 1200);
}

function dedupeElements(elements: HTMLElement[]): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const result: HTMLElement[] = [];
  for (const el of elements) {
    if (seen.has(el)) continue;
    // Skip option nodes that are nested inside an already-collected listbox/radiogroup
    // when we also collect the option itself for selection targeting.
    seen.add(el);
    result.push(el);
  }
  return result;
}

export function capturePageSnapshot(): PageSnapshot {
  elementRegistry.clear();
  let nextId = 1;

  const rawElements = dedupeElements(collectInteractiveCandidates(document));
  const interactiveElements: InteractiveElement[] = [];

  const pageContext = `${document.title} ${document.body?.innerText?.slice(0, 2500) || ""}`;
  for (const el of rawElements) {
    const id = nextId++;
    elementRegistry.set(id, el);
    el.setAttribute("data-browse-voice-id", String(id));

    const tag = el.tagName.toLowerCase();
    const type = el instanceof HTMLInputElement ? el.type.toLowerCase() : undefined;
    const name = el.getAttribute("name") || el.getAttribute("id") || undefined;
    const placeholder = el.getAttribute("placeholder") || undefined;
    const label = getElementLabel(el);
    const role = el.getAttribute("role") || tag;
    const controlKind = inferControlKind(el);
    const question = nearbyQuestionText(el);
    const groupName = el.getAttribute("name")
      || el.closest("[role='radiogroup'],fieldset,[role='group']")?.getAttribute("aria-label")
      || el.closest("[role='radiogroup'],fieldset")?.querySelector("legend")?.textContent?.trim()
      || undefined;
    const required = el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
    const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true"
      || (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement
        ? el.disabled
        : false);
    const readOnly = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ? el.readOnly : el.getAttribute("aria-readonly") === "true";
    const visible = isElementVisible(el);
    const interactable = isInteractable(el);
    const contentEditable = Boolean(el.isContentEditable || (el.getAttribute("role") || "").toLowerCase() === "textbox");

    const sensitivity = detectSensitiveField({
      type,
      name,
      id: el.id,
      label,
      placeholder,
      autocomplete: el.getAttribute("autocomplete") || undefined,
    });

    const description = [
      placeholder,
      resolveDescribedBy(el),
      question,
      el.closest("fieldset")?.querySelector("legend")?.textContent,
      el.closest("section,[role=dialog],form")?.getAttribute("aria-label"),
    ].filter(Boolean).join(" · ").slice(0, 180);

    const options = collectOptions(el);
    const classification = classifyUserOnlyField({
      id,
      tag,
      role,
      type,
      name,
      label,
      placeholder,
      autocomplete: el.getAttribute("autocomplete") || undefined,
      inputmode: el.getAttribute("inputmode") || undefined,
      maxlength: el instanceof HTMLInputElement ? el.maxLength : undefined,
      pattern: el instanceof HTMLInputElement ? el.pattern : undefined,
      description,
      options,
      isSensitive: sensitivity.isSensitive,
    }, `${pageContext} ${description}`);
    const isUserOnly = sensitivity.isSensitive || classification.isUserOnly;

    const rawValue = readCurrentValue(el, controlKind);
    const safeValue = maskSensitiveValue(rawValue, isUserOnly);
    const checked = readCheckedState(el);
    const selected = el instanceof HTMLSelectElement
      ? el.selectedOptions[0]?.text.trim() || undefined
      : (controlKind === "combobox" || controlKind === "listbox" ? safeValue || undefined : undefined);

    interactiveElements.push({
      id,
      tag,
      role,
      label,
      type,
      name,
      placeholder,
      value: safeValue,
      checked,
      options,
      selected,
      isSensitive: isUserOnly,
      sensitiveReason: sensitivity.reason || (classification.isUserOnly ? `User-only ${classification.category || "private"} field` : undefined),
      description,
      category: sensitivity.isSensitive ? "credential" : classification.category,
      question: question || undefined,
      controlKind,
      groupName: groupName || undefined,
      required,
      disabled,
      readOnly,
      interactable,
      visible,
      contentEditable,
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

export function getElementById(id: number): HTMLElement | undefined {
  const cached = elementRegistry.get(id);
  if (cached && cached.isConnected) return cached;

  const byAttr = document.querySelector<HTMLElement>(`[data-browse-voice-id="${id}"]`);
  if (byAttr) {
    elementRegistry.set(id, byAttr);
    return byAttr;
  }

  return undefined;
}

/** Read live value/selection/checked state for verification after execution. */
export function readElementState(id: number): {
  found: boolean;
  value?: string;
  checked?: boolean;
  selected?: string;
  label?: string;
  interactable?: boolean;
} {
  const el = getElementById(id);
  if (!el) return { found: false };
  const controlKind = inferControlKind(el);
  const value = readCurrentValue(el, controlKind);
  const checked = readCheckedState(el);
  const selected = el instanceof HTMLSelectElement
    ? el.selectedOptions[0]?.text.trim() || undefined
    : value;
  return {
    found: true,
    value,
    checked,
    selected,
    label: getElementLabel(el),
    interactable: isInteractable(el),
  };
}
