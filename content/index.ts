/**
 * Browse Voice Content Script Entry Point.
 *
 * Coordinates:
 * - On-page "Agent is Active" indicator
 * - Page observation requests (snapshots)
 * - Safe action execution
 */

import { capturePageSnapshot, getElementById, readElementState } from "./observer";
import { executeAction } from "./executor";
import type { PlannerAction } from "../lib/schema";

let indicatorElement: HTMLElement | null = null;
let agentActive = false;
let manualFieldsOverlay: HTMLDivElement | null = null;
let manualFieldsUpdate: (() => void) | null = null;

function clearManualFieldHighlights(): void {
  if (manualFieldsUpdate) {
    window.removeEventListener("scroll", manualFieldsUpdate, true);
    window.removeEventListener("resize", manualFieldsUpdate);
  }
  manualFieldsUpdate = null;
  manualFieldsOverlay?.remove();
  manualFieldsOverlay = null;
}

function highlightManualFields(fields: Array<{ id: number; label?: string; reason?: string; category?: string }>): number {
  clearManualFieldHighlights();
  const targets = fields.flatMap((field) => {
    const element = getElementById(field.id);
    if (!element) return [];
    const container = element.closest("fieldset,[role=group],section,[role=dialog]") as HTMLElement | null;
    return [{ element: container || element, label: field.label?.trim() || "Field", reason: field.reason?.trim() || field.category?.trim() || "Fill this yourself" }];
  });
  if (!targets.length) return 0;

  const overlay = document.createElement("div");
  overlay.id = "browse-voice-manual-fields";
  overlay.style.cssText = "position:fixed;inset:0;z-index:2147483645;pointer-events:none;";
  const entries = targets.map(({ element, label, reason }) => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;box-sizing:border-box;border:3px solid #f59e0b;border-radius:7px;background:rgba(245,158,11,.10);box-shadow:0 0 0 2px rgba(255,255,255,.9),0 3px 14px rgba(0,0,0,.25);pointer-events:none;";
    const badge = document.createElement("div");
    badge.textContent = `✋ Fill manually · ${label} · ${reason}`;
    badge.style.cssText = "position:absolute;left:0;bottom:calc(100% + 5px);max-width:min(340px,80vw);padding:6px 9px;border-radius:6px;background:#7c2d12;color:white;font:600 12px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 2px 9px rgba(0,0,0,.35);white-space:normal;overflow-wrap:anywhere;";
    box.appendChild(badge);
    overlay.appendChild(box);
    return { element, box };
  });
  document.documentElement.appendChild(overlay);

  const update = () => {
    for (const { element, box } of entries) {
      if (!element.isConnected) { box.style.display = "none"; continue; }
      const rect = element.getBoundingClientRect();
      box.style.display = rect.width > 0 && rect.height > 0 ? "block" : "none";
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    }
  };
  manualFieldsOverlay = overlay;
  manualFieldsUpdate = update;
  window.addEventListener("scroll", update, true);
  window.addEventListener("resize", update);
  update();
  targets[0]?.element.scrollIntoView({ behavior: "smooth", block: "center" });
  return targets.length;
}

interface SnipSelectionResult {
  rect: { x: number; y: number; width: number; height: number };
  viewportWidth: number;
  text: string;
  elements: string[];
  title: string;
  url: string;
}

function getSnipText(rect: SnipSelectionResult["rect"]): { text: string; elements: string[] } {
  const selected: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("body *"));

  for (const el of candidates) {
    if (el.closest("#browse-voice-snipper")) continue;
    const box = el.getBoundingClientRect();
    const intersects = box.width > 0 && box.height > 0 &&
      box.right > rect.x && box.left < rect.x + rect.width &&
      box.bottom > rect.y && box.top < rect.y + rect.height;
    if (intersects && el.innerText?.trim()) {
      const childHasText = Array.from(el.children).some((child) =>
        (child as HTMLElement).innerText?.trim() === el.innerText?.trim()
      );
      if (!childHasText && !seen.has(el)) {
        seen.add(el);
        selected.push(el);
      }
    }
  }

  const text = selected.map((el) => el.innerText.trim().replace(/\s+/g, " ")).join("\n").slice(0, 5000);
  const elements = selected
    .filter((el) => /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.getAttribute("role"))
    .map((el) => `${el.tagName.toLowerCase()}: ${(el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 160)}`)
    .filter(Boolean)
    .slice(0, 40);

  return { text, elements };
}

function startSnipSelection(): Promise<SnipSelectionResult> {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById("browse-voice-snipper");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "browse-voice-snipper";
    const selection = document.createElement("div");
    selection.className = "bv-snip-selection";
    const hint = document.createElement("div");
    hint.className = "bv-snip-hint";
    hint.textContent = "Drag to select · Esc to cancel";
    overlay.append(selection, hint);
    document.documentElement.appendChild(overlay);

    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    let startX = 0;
    let startY = 0;
    let dragging = false;

    const cleanup = () => {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.removeEventListener("mousedown", onMouseDown);
      overlay.removeEventListener("mousemove", onMouseMove);
      overlay.removeEventListener("mouseup", onMouseUp);
      overlay.remove();
      document.documentElement.style.overflow = previousOverflow;
    };
    const finish = (result: SnipSelectionResult) => { cleanup(); resolve(result); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { cleanup(); reject(new Error("Selection cancelled.")); }
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      selection.style.cssText = `left:${startX}px;top:${startY}px;width:0;height:0;`;
      event.preventDefault();
    };
    const onMouseMove = (event: MouseEvent) => {
      if (!dragging) return;
      const x = Math.min(startX, event.clientX);
      const y = Math.min(startY, event.clientY);
      const width = Math.abs(event.clientX - startX);
      const height = Math.abs(event.clientY - startY);
      selection.style.cssText = `left:${x}px;top:${y}px;width:${width}px;height:${height}px;`;
    };
    const onMouseUp = (event: MouseEvent) => {
      if (!dragging) return;
      dragging = false;
      const rect = {
        x: Math.max(0, Math.min(startX, event.clientX)),
        y: Math.max(0, Math.min(startY, event.clientY)),
        width: Math.abs(event.clientX - startX),
        height: Math.abs(event.clientY - startY),
      };
      if (rect.width < 8 || rect.height < 8) { cleanup(); reject(new Error("Selection was too small.")); return; }
      const context = getSnipText(rect);
      finish({ rect, viewportWidth: window.innerWidth, ...context, title: document.title, url: window.location.href });
    };

    document.addEventListener("keydown", onKeyDown, true);
    overlay.addEventListener("mousedown", onMouseDown);
    overlay.addEventListener("mousemove", onMouseMove);
    overlay.addEventListener("mouseup", onMouseUp);
  });
}

/**
 * Creates or updates the floating "Agent is Active" indicator on the page.
 */
function showActiveIndicator(statusText: string = "Active"): void {
  agentActive = true;
  if (!indicatorElement) {
    indicatorElement = document.createElement("div");
    indicatorElement.id = "browse-voice-agent-indicator";

    const dot = document.createElement("span");
    dot.className = "bv-dot";

    const label = document.createElement("span");
    label.className = "bv-text";
    label.innerText = "Browse Voice";

    const status = document.createElement("span");
    status.className = "bv-status";
    status.innerText = statusText;

    indicatorElement.appendChild(dot);
    indicatorElement.appendChild(label);
    indicatorElement.appendChild(status);

    document.documentElement.appendChild(indicatorElement);
  } else {
    const status = indicatorElement.querySelector(".bv-status");
    if (status) status.textContent = statusText;
  }
}

/**
 * Removes the indicator when the agent session stops or is dismissed.
 */
function hideActiveIndicator(): void {
  agentActive = false;
  clearManualFieldHighlights();
  if (indicatorElement) {
    indicatorElement.remove();
    indicatorElement = null;
  }
}

// Listen for messages from the side panel or background service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  switch (message.type) {
    case "BV_PING": {
      sendResponse({ ok: true, active: agentActive, url: window.location.href });
      return true;
    }

    case "BV_ACTIVATE_AGENT": {
      showActiveIndicator(message.statusText || "Active");
      sendResponse({ ok: true });
      return true;
    }

    case "BV_DEACTIVATE_AGENT": {
      hideActiveIndicator();
      sendResponse({ ok: true });
      return true;
    }

    case "BV_HIGHLIGHT_MANUAL_FIELDS": {
      const fields = Array.isArray(message.fields) ? message.fields : [];
      const safeFields = fields.filter((field: unknown) =>
        !!field && typeof field === "object" && Number.isInteger((field as { id?: unknown }).id),
      ) as Array<{ id: number; label?: string; reason?: string; category?: string }>;
      const count = highlightManualFields(safeFields);
      sendResponse({ ok: true, highlighted: count });
      return true;
    }

    case "BV_CLEAR_MANUAL_FIELDS": {
      clearManualFieldHighlights();
      sendResponse({ ok: true });
      return true;
    }

    case "BV_START_SNIP_SELECTION": {
      startSnipSelection()
        .then((selection) => sendResponse({ ok: true, selection }))
        .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : "Selection cancelled." }));
      return true;
    }

    case "BV_GET_SNAPSHOT": {
      if (!agentActive) {
        showActiveIndicator("Observing");
      }
      try {
        const snapshot = capturePageSnapshot();
        sendResponse({ ok: true, snapshot });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "Snapshot failed." });
      }
      return true;
    }

    case "BV_EXECUTE_ACTION": {
      const action = message.action as PlannerAction;
      if (!action) {
        sendResponse({ ok: false, error: "Missing action in request." });
        return true;
      }

      showActiveIndicator(`Running: ${action.action}`);

      executeAction(action)
        .then((result) => {
          // Immediately capture fresh post-action observation
          const freshSnapshot = capturePageSnapshot();
          sendResponse({
            ok: result.success,
            result,
            error: result.error,
            freshSnapshot,
            verified: result.verified,
            observedValue: result.observedValue,
          });
        })
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : "Execution failed.",
          });
        });

      return true; // Keep channel open for async response
    }

    case "BV_READ_ELEMENT_STATE": {
      const id = Number(message.id);
      if (!Number.isInteger(id) || id <= 0) {
        sendResponse({ ok: false, error: "Element id is required." });
        return true;
      }
      sendResponse({ ok: true, state: readElementState(id) });
      return true;
    }

    default:
      return false;
  }
});
