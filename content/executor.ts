/**
 * Action Executor for Browse Voice Content Script.
 *
 * Executes planner actions against live DOM elements with React-aware
 * value setting, custom dropdown / ARIA support, and post-action verification.
 */

import { getElementById, readElementState } from "./observer";
import { isAllowedNavigationUrl, type PlannerAction } from "../lib/schema";
import { detectSensitiveField } from "../lib/safety";

export interface ExecutionResult {
  success: boolean;
  action: PlannerAction;
  error?: string;
  settled: boolean;
  waitedMs: number;
  verified?: boolean;
  observedValue?: string;
}

/** Use the browser's native setter so React/Vue controlled inputs observe updates. */
export function setNativeElementValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

function flashElementHighlight(el: HTMLElement): void {
  const originalOutline = el.style.outline;
  const originalTransition = el.style.transition;

  el.style.transition = "outline 0.2s ease-in-out, box-shadow 0.2s ease-in-out";
  el.style.outline = "3px solid #ff4444";
  el.style.boxShadow = "0 0 12px rgba(255, 68, 68, 0.6)";

  setTimeout(() => {
    el.style.outline = originalOutline;
    el.style.boxShadow = "";
    el.style.transition = originalTransition;
  }, 800);
}

export async function waitForPageSettle(timeoutMs: number = 2000): Promise<{ settled: boolean; waitedMs: number }> {
  const startedAt = performance.now();
  const quietPeriodMs = 300;
  let lastMutationAt = performance.now();

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      lastMutationAt = performance.now();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ["class", "style", "aria-busy", "disabled", "aria-checked", "aria-selected", "value"],
    });

    const check = () => {
      const now = performance.now();
      const elapsed = now - startedAt;
      const isDocReady = document.readyState === "complete";
      const quiet = now - lastMutationAt >= quietPeriodMs;
      const busyElements = document.querySelectorAll('[aria-busy="true"], progress, .spinner');

      if (elapsed >= timeoutMs) {
        observer.disconnect();
        resolve({ settled: false, waitedMs: Math.round(elapsed) });
        return;
      }

      if (isDocReady && quiet && busyElements.length === 0) {
        observer.disconnect();
        resolve({ settled: true, waitedMs: Math.round(elapsed) });
        return;
      }

      setTimeout(check, 100);
    };

    setTimeout(check, 250);
  });
}

function dispatchClick(el: HTMLElement): void {
  el.focus();
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  el.click();
}

function normalizeMatch(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function valuesMatch(observed: string | undefined, expected: string): boolean {
  if (!observed) return false;
  const left = normalizeMatch(observed);
  const right = normalizeMatch(expected);
  return left === right || left.includes(right) || right.includes(left);
}

async function typeIntoElement(el: HTMLElement, text: string): Promise<void> {
  flashElementHighlight(el);
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.focus();

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    setNativeElementValue(el, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  if (el.isContentEditable || (el.getAttribute("role") || "").toLowerCase() === "textbox") {
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand?.("selectAll", false);
    document.execCommand?.("insertText", false, text);
    if ((el.innerText || "").trim() !== text.trim()) {
      el.textContent = text;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  // Combobox-like custom inputs: set text and notify listeners.
  if ("value" in el) {
    try {
      (el as HTMLInputElement).value = text;
    } catch {
      // ignore
    }
  }
  el.setAttribute("value", text);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function selectNativeOption(el: HTMLSelectElement, value: string): Promise<boolean> {
  const needle = normalizeMatch(value);
  for (let i = 0; i < el.options.length; i++) {
    const opt = el.options[i];
    if (normalizeMatch(opt.value) === needle || normalizeMatch(opt.text).includes(needle) || needle.includes(normalizeMatch(opt.text))) {
      el.selectedIndex = i;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
  }
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return valuesMatch(el.selectedOptions[0]?.text || el.value, value);
}

async function selectCustomOption(el: HTMLElement, value: string): Promise<boolean> {
  const needle = normalizeMatch(value);
  flashElementHighlight(el);
  el.scrollIntoView({ behavior: "smooth", block: "center" });

  const role = (el.getAttribute("role") || "").toLowerCase();
  const isOption = role === "option" || role === "radio" || role === "menuitemradio" || role === "checkbox";
  if (isOption) {
    dispatchClick(el);
    await waitForPageSettle(500);
    const checked = el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true";
    return checked || normalizeMatch(el.innerText || "") === needle;
  }

  // Open combobox / listbox then choose matching option.
  dispatchClick(el);
  await waitForPageSettle(700);

  const controlledId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
  const scopes: ParentNode[] = [];
  if (controlledId) {
    const controlled = document.getElementById(controlledId);
    if (controlled) scopes.push(controlled);
  }
  scopes.push(el.parentElement || document.body, document.body);

  for (const scope of scopes) {
    const options = Array.from(scope.querySelectorAll<HTMLElement>(
      "[role='option'],[role='radio'],[role='menuitemradio'],[role='checkbox'],option",
    ));
    const match = options.find((option) => {
      const label = normalizeMatch(option.getAttribute("aria-label") || option.innerText || option.textContent || "");
      return label === needle || label.includes(needle) || needle.includes(label);
    });
    if (match) {
      dispatchClick(match);
      await waitForPageSettle(500);
      return true;
    }
  }

  // Last resort: type the value into the combobox.
  await typeIntoElement(el, value);
  await waitForPageSettle(400);
  return true;
}

export function verifyActionResult(action: PlannerAction): { verified: boolean; observedValue?: string; error?: string } {
  if (action.action === "type") {
    const state = readElementState(action.id);
    if (!state.found) return { verified: false, error: `Element ID [${action.id}] disappeared after typing.` };
    const ok = valuesMatch(state.value, action.text);
    return { verified: ok, observedValue: state.value, error: ok ? undefined : "Typed value was not present after the action." };
  }

  if (action.action === "select") {
    const state = readElementState(action.id);
    if (!state.found) return { verified: false, error: `Element ID [${action.id}] disappeared after selection.` };
    const observed = state.selected || state.value || state.label || "";
    const ok = valuesMatch(observed, action.value) || state.checked === true;
    return { verified: ok, observedValue: observed, error: ok ? undefined : "Selected value was not present after the action." };
  }

  if (action.action === "click") {
    const state = readElementState(action.id);
    if (!state.found) return { verified: true, observedValue: "clicked" };
    return {
      verified: true,
      observedValue: state.checked === undefined ? state.value || state.label : (state.checked ? "checked" : "unchecked"),
    };
  }

  return { verified: true };
}

/**
 * Executes a single verified PlannerAction.
 */
export async function executeAction(action: PlannerAction): Promise<ExecutionResult> {
  const startedAt = performance.now();

  try {
    switch (action.action) {
      case "click": {
        const el = getElementById(action.id);
        if (!el) {
          return {
            success: false,
            action,
            error: `Element ID [${action.id}] was not found in the current page.`,
            settled: true,
            waitedMs: 0,
          };
        }

        flashElementHighlight(el);
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        dispatchClick(el);

        const settle = await waitForPageSettle();
        const verification = verifyActionResult(action);
        return {
          success: true,
          action,
          settled: settle.settled,
          waitedMs: settle.waitedMs,
          verified: verification.verified,
          observedValue: verification.observedValue,
        };
      }

      case "type": {
        const el = getElementById(action.id);
        if (!el) {
          return {
            success: false,
            action,
            error: `Element ID [${action.id}] was not found in the current page.`,
            settled: true,
            waitedMs: 0,
          };
        }

        const sensitivity = detectSensitiveField({
          type: el instanceof HTMLInputElement ? el.type : undefined,
          name: el.getAttribute("name") || el.id,
          id: el.id,
          label: el.getAttribute("aria-label") || undefined,
        });

        if (sensitivity.isSensitive) {
          return {
            success: false,
            action,
            error: `Safety Violation Blocked: Target element is sensitive (${sensitivity.reason}).`,
            settled: true,
            waitedMs: 0,
          };
        }

        await typeIntoElement(el, action.text);
        const settle = await waitForPageSettle(600);
        let verification = verifyActionResult(action);

        // One safe retry for stubborn React-controlled inputs.
        if (!verification.verified) {
          await typeIntoElement(el, action.text);
          await waitForPageSettle(400);
          verification = verifyActionResult(action);
        }

        return {
          success: verification.verified,
          action,
          error: verification.verified ? undefined : verification.error,
          settled: settle.settled,
          waitedMs: settle.waitedMs,
          verified: verification.verified,
          observedValue: verification.observedValue,
        };
      }

      case "select": {
        const el = getElementById(action.id);
        if (!el) {
          return {
            success: false,
            action,
            error: `Element ID [${action.id}] was not found in the current page.`,
            settled: true,
            waitedMs: 0,
          };
        }

        flashElementHighlight(el);
        el.scrollIntoView({ behavior: "smooth", block: "center" });

        let matched = false;
        if (el instanceof HTMLSelectElement) {
          matched = await selectNativeOption(el, action.value);
        } else {
          matched = await selectCustomOption(el, action.value);
        }

        const settle = await waitForPageSettle(600);
        const verification = verifyActionResult(action);
        const ok = matched && verification.verified;
        return {
          success: ok,
          action,
          error: ok ? undefined : verification.error || `Could not select "${action.value}".`,
          settled: settle.settled,
          waitedMs: settle.waitedMs,
          verified: verification.verified,
          observedValue: verification.observedValue,
        };
      }

      case "scroll": {
        const amount = action.amount || 350;
        let deltaX = 0;
        let deltaY = 0;

        if (action.direction === "up") deltaY = -amount;
        if (action.direction === "down") deltaY = amount;
        if (action.direction === "left") deltaX = -amount;
        if (action.direction === "right") deltaX = amount;

        window.scrollBy({ left: deltaX, top: deltaY, behavior: "smooth" });
        const settle = await waitForPageSettle(500);
        return {
          success: true,
          action,
          settled: settle.settled,
          waitedMs: settle.waitedMs,
          verified: true,
        };
      }

      case "press_key": {
        const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
        if (!target) {
          return { success: false, action, error: "No focused element is available for the key press.", settled: true, waitedMs: 0 };
        }
        const eventInit: KeyboardEventInit = { key: action.key, code: action.key === "Enter" ? "Enter" : undefined, bubbles: true, cancelable: true };
        target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
        target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
        target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
        const settle = await waitForPageSettle(500);
        return { success: true, action, settled: settle.settled, waitedMs: settle.waitedMs, verified: true };
      }

      case "navigate": {
        if (!isAllowedNavigationUrl(action.url)) {
          return {
            success: false,
            action,
            error: "Safety Violation Blocked: navigation only allows http(s) URLs.",
            settled: true,
            waitedMs: 0,
          };
        }
        window.location.href = action.url;
        return {
          success: true,
          action,
          settled: false,
          waitedMs: 0,
          verified: true,
        };
      }

      case "ask_user":
      case "done":
      case "handoff_to_user":
        return {
          success: true,
          action,
          settled: true,
          waitedMs: 0,
          verified: true,
        };

      default:
        return {
          success: false,
          action,
          error: "Unrecognized action.",
          settled: true,
          waitedMs: 0,
        };
    }
  } catch (err) {
    const elapsed = Math.round(performance.now() - startedAt);
    return {
      success: false,
      action,
      error: err instanceof Error ? err.message : "Execution failed.",
      settled: false,
      waitedMs: elapsed,
    };
  }
}
