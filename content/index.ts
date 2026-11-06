/**
 * Browse Voice Content Script Entry Point.
 *
 * Coordinates:
 * - On-page "Agent is Active" indicator
 * - Page observation requests (snapshots)
 * - Safe action execution
 */

import { capturePageSnapshot } from "./observer";
import { executeAction } from "./executor";
import type { PlannerAction } from "../lib/schema";
import { cleanSnippetLines, cleanSnippetText } from "../lib/snips";

let indicatorElement: HTMLElement | null = null;
let agentActive = false;
let lastStoppedSession = 0;

function isAgentSessionAllowed(sessionId: unknown): boolean {
  if (typeof sessionId !== "number" || !Number.isFinite(sessionId)) return true;
  return sessionId > lastStoppedSession;
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
  const positioned: Array<{ top: number; left: number; order: number; text: string }> = [];
  const selectedInteractive = new Set<HTMLElement>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  let order = 0;

  while (node) {
    const textNode = node;
    const parent = textNode.parentElement;
    if (parent && !parent.closest("#browse-voice-snipper")) {
      const style = getComputedStyle(parent);
      if (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0") {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const matchingRect = Array.from(range.getClientRects()).find((box) =>
          box.width > 0 && box.height > 0 &&
          box.right > rect.x && box.left < rect.x + rect.width &&
          box.bottom > rect.y && box.top < rect.y + rect.height
        );
        if (matchingRect) {
          const text = cleanSnippetText(textNode.textContent || "");
          if (text) positioned.push({ top: matchingRect.top, left: matchingRect.left, order: order++, text });
          const interactive = parent.closest<HTMLElement>("button, a, input, select, textarea, [role]");
          if (interactive) selectedInteractive.add(interactive);
        }
        range.detach();
      }
    }
    node = walker.nextNode();
  }

  positioned.sort((a, b) => a.top - b.top || a.left - b.left || a.order - b.order);
  const text = cleanSnippetLines(positioned.map((item) => item.text));
  const elements = Array.from(selectedInteractive)
    .map((el) => {
      const label = cleanSnippetText(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText || "");
      return label ? `${el.tagName.toLowerCase()}: ${label.slice(0, 160)}` : "";
    })
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
      if (!isAgentSessionAllowed(message.sessionId)) {
        sendResponse({ ok: false, active: false, error: "This Browse Voice session has been stopped." });
        return true;
      }
      showActiveIndicator(message.statusText || "Active");
      sendResponse({ ok: true });
      return true;
    }

    case "BV_DEACTIVATE_AGENT": {
      if (typeof message.sessionId === "number" && Number.isFinite(message.sessionId)) {
        lastStoppedSession = Math.max(lastStoppedSession, message.sessionId);
      }
      hideActiveIndicator();
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
      if (!isAgentSessionAllowed(message.sessionId)) {
        sendResponse({ ok: false, error: "This Browse Voice session has been stopped." });
        return true;
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
      if (!isAgentSessionAllowed(message.sessionId)) {
        sendResponse({ ok: false, error: "This Browse Voice session has been stopped." });
        return true;
      }

      showActiveIndicator(`Running: ${action.action}`);

      executeAction(action)
        .then((result) => {
          // Immediately capture fresh post-action observation
          const freshSnapshot = capturePageSnapshot();
          sendResponse({ ok: result.success, result, error: result.error, freshSnapshot });
        })
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : "Execution failed.",
          });
        });

      return true; // Keep channel open for async response
    }

    default:
      return false;
  }
});
