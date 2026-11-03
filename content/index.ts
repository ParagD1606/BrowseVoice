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

let indicatorElement: HTMLElement | null = null;
let agentActive = false;

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
      showActiveIndicator(message.statusText || "Active");
      sendResponse({ ok: true });
      return true;
    }

    case "BV_DEACTIVATE_AGENT": {
      hideActiveIndicator();
      sendResponse({ ok: true });
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
          sendResponse({ ok: true, result, freshSnapshot });
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
