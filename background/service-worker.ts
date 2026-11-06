/**
 * Background Service Worker for Browse Voice (Manifest V3).
 *
 * Responsibilities:
 * - Side panel behavior on action icon click
 * - Tab communication and content script injection verification
 * - Dynamic declarativeNetRequest management for Gnani AI endpoints
 */

// Enable opening the side panel when the user clicks the toolbar icon
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn("Failed to set side panel behavior:", err));

chrome.runtime.onInstalled.addListener(() => {
  console.log("Browse Voice Extension installed successfully.");
});

// Forward browser lifecycle events to the side panel orchestrator. The shared
// task itself is persisted by the panel, so a suspended service worker does not
// erase coordination state.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.runtime.sendMessage({ type: "BV_AGENT_TAB_REMOVED", tabId }).catch(() => {});
});

// Helper: Ensure the content script is injected in a tab
async function ensureContentScriptInjected(tabId: number): Promise<boolean> {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "BV_PING" });
    if (ping?.ok) return true;
  } catch {
    // Content script not listening; inject programmatically
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content/overlay.css"],
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/index.js"],
    });

    return true;
  } catch (err) {
    console.warn(`Could not inject content script into tab ${tabId}:`, err);
    return false;
  }
}

// Background message routing
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "BV_GET_ACTIVE_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      sendResponse({ tab: tab || null });
    });
    return true;
  }

  if (message.type === "BV_ENSURE_TAB_CONNECTED") {
    const tabId = message.tabId as number;
    ensureContentScriptInjected(tabId).then((success) => {
      sendResponse({ ok: success });
    });
    return true;
  }

  if (message.type === "BV_CAPTURE_VISIBLE_TAB") {
    const windowId = message.windowId as number | undefined;
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }).then((dataUrl) => {
      sendResponse({ ok: true, dataUrl });
    }).catch((err) => {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : "Could not capture tab." });
    });
    return true;
  }

  return false;
});
