/**
 * Action Executor for Browse Voice Content Script.
 *
 * Executes planner actions against live DOM elements:
 * - click(id)
 * - type(id, text)
 * - select(id, value)
 * - scroll(direction, amount)
 * - navigate(url)
 *
 * Then waits for the page to settle before capturing the next observation.
 */

import { getElementById } from "./observer";
import { isAllowedNavigationUrl, type PlannerAction } from "../lib/schema";
import { detectSensitiveField } from "../lib/safety";

export interface ExecutionResult {
  success: boolean;
  action: PlannerAction;
  error?: string;
  settled: boolean;
  waitedMs: number;
}

/**
 * Temporarily highlights an element to give visual feedback to the user.
 */
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

/**
 * Waits for dynamic page mutations, network activities, and AJAX renders to settle.
 */
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
      attributeFilter: ["class", "style", "aria-busy", "disabled"],
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

        // Dispatch realistic user mouse events
        el.focus();
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        el.click();

        const settle = await waitForPageSettle();
        return {
          success: true,
          action,
          settled: settle.settled,
          waitedMs: settle.waitedMs,
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

        // Safety enforcement: NEVER type into sensitive fields
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

        flashElementHighlight(el);
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus();

        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.value = action.text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: action.text }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          el.innerText = action.text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: action.text }));
        }

        const settle = await waitForPageSettle(600);
        return {
          success: true,
          action,
          settled: settle.settled,
          waitedMs: settle.waitedMs,
        };
      }

      case "select": {
        const el = getElementById(action.id);
        if (!el || !(el instanceof HTMLSelectElement)) {
          return {
            success: false,
            action,
            error: `Element ID [${action.id}] is not a valid <select> dropdown.`,
            settled: true,
            waitedMs: 0,
          };
        }

        flashElementHighlight(el);
        el.scrollIntoView({ behavior: "smooth", block: "center" });

        // Match option by value or text
        let matched = false;
        for (let i = 0; i < el.options.length; i++) {
          const opt = el.options[i];
          if (
            opt.value.toLowerCase() === action.value.toLowerCase() ||
            opt.text.toLowerCase().includes(action.value.toLowerCase())
          ) {
            el.selectedIndex = i;
            matched = true;
            break;
          }
        }

        if (!matched && el.options.length > 0) {
          el.value = action.value;
        }

        el.dispatchEvent(new Event("change", { bubbles: true }));
        const settle = await waitForPageSettle(600);
        return {
          success: true,
          action,
          settled: settle.settled,
          waitedMs: settle.waitedMs,
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
        };
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
        };
      }

      case "ask_user":
      case "done":
        return {
          success: true,
          action,
          settled: true,
          waitedMs: 0,
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
