/**
 * Browse Voice - Chrome Side Panel Agent Controller (React 19)
 *
 * Implements the full Phase 1 agent loop:
 * 1. User speaks -> Gnani Prisma streams transcript to panel.
 * 2. On end of utterance -> observer returns page snapshot.
 * 3. Planner receives: user request, snapshot, last 5 steps -> returns ONE action.
 * 4. Safety inspection (sensitive fields blocked, confirmation gated for submit/pay).
 * 5. Executor runs action in tab, waits for settle, re-observes.
 * 6. Gnani Timbre speaks one short sentence about the action.
 * 7. Repeats until done(), ask_user(), "ruko"/"stop", or max 15 steps.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  speakWithTimbre,
  stopAllSpeech,
  GnaniPrismaWebSocketClient,
  SUPPORTED_INDIAN_LANGUAGES,
  type GnaniConfig,
} from "../lib/gnani";
import {
  createPlanner,
  type PlannerProvider,
  type StepLogEntry,
  type LLMConfig,
} from "../lib/planner";
import {
  inspectActionSafety,
  isStopCommand,
  isConfirmationCommand,
  type PageSnapshot,
} from "../lib/safety";
import type { PlannerAction } from "../lib/schema";
import { MicrophoneSession } from "./mic";

type AgentStatus =
  | "idle"
  | "listening"
  | "thinking"
  | "executing"
  | "speaking"
  | "confirmation"
  | "stopped";

interface SettingsState {
  gnaniApiKey: string;
  languageCode: string;
  /** "gemini" = Google AI Studio, "openai-compatible" = any OpenAI-spec API, "mock" = offline demo */
  llmProvider: "mock" | "openai-compatible" | "gemini";
  llmApiKey: string;
  llmEndpoint: string;
  llmModel: string;
}

const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const RETIRED_GEMINI_MODELS = new Set([
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
]);

const DEFAULT_SETTINGS: SettingsState = {
  gnaniApiKey: (import.meta.env.VITE_GNANI_API_KEY as string) || "",
  languageCode: (import.meta.env.VITE_LANGUAGE_CODE as string) || "hi-IN",
  llmProvider:
    (import.meta.env.VITE_LLM_PROVIDER as "mock" | "openai-compatible" | "gemini") ||
    (import.meta.env.VITE_GEMINI_API_KEY
      ? "gemini"
      : import.meta.env.VITE_LLM_API_KEY
        ? "openai-compatible"
        : "mock"),
  // Unified API key field: Gemini key takes priority, fallback to generic LLM key
  llmApiKey:
    (import.meta.env.VITE_GEMINI_API_KEY as string) ||
    (import.meta.env.VITE_LLM_API_KEY as string) ||
    "",
  llmEndpoint: (import.meta.env.VITE_LLM_ENDPOINT as string) || "https://api.openai.com/v1",
  llmModel: (import.meta.env.VITE_LLM_MODEL as string) || DEFAULT_GEMINI_MODEL,
};

function migrateRetiredGeminiModel(settings: SettingsState): SettingsState {
  if (settings.llmProvider === "gemini" && RETIRED_GEMINI_MODELS.has(settings.llmModel)) {
    return { ...settings, llmModel: DEFAULT_GEMINI_MODEL };
  }
  return settings;
}

export const App: React.FC = () => {
  // Agent state
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [statusText, setStatusText] = useState<string>("Ready / तैयार");
  const [transcript, setTranscript] = useState<string>("");
  const [activeTabTitle, setActiveTabTitle] = useState<string>("");
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [activeTabUrl, setActiveTabUrl] = useState<string>("");
  const [steps, setSteps] = useState<StepLogEntry[]>([]);
  const [currentPrompt, setCurrentPrompt] = useState<string>("");
  const [pendingConfirmationAction, setPendingConfirmationAction] = useState<PlannerAction | null>(null);
  const [confirmationMessage, setConfirmationMessage] = useState<string>("");

  // Settings modal
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);

  // Refs for tracking active objects
  const micSessionRef = useRef<MicrophoneSession>(new MicrophoneSession());
  const gnaniWsRef = useRef<GnaniPrismaWebSocketClient | null>(null);
  const isStoppedRef = useRef<boolean>(false);
  const stepsRef = useRef<StepLogEntry[]>([]);
  stepsRef.current = steps;

  // Load saved settings from chrome.storage.local
  useEffect(() => {
    chrome.storage.local.get("browseVoiceSettings", (result) => {
      if (result.browseVoiceSettings) {
        const savedSettings = result.browseVoiceSettings as Partial<SettingsState>;
        const mergedSettings = { ...DEFAULT_SETTINGS, ...savedSettings };
        const migratedSettings = migrateRetiredGeminiModel(mergedSettings);
        setSettings(migratedSettings);
        if (migratedSettings.llmModel !== savedSettings.llmModel) {
          chrome.storage.local.set({ browseVoiceSettings: migratedSettings });
        }
      } else {
        const initialSettings = migrateRetiredGeminiModel(DEFAULT_SETTINGS);
        setSettings(initialSettings);
        chrome.storage.local.set({ browseVoiceSettings: initialSettings });
      }
    });

    // Detect active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id) {
        setActiveTabId(tab.id);
        setActiveTabTitle(tab.title || "Web Page");
        setActiveTabUrl(tab.url || "");
      }
    });

    // Listen for tab activation changes
    const onTabActivated = (activeInfo: chrome.tabs.TabActiveInfo) => {
      setActiveTabId(activeInfo.tabId);
      chrome.tabs.get(activeInfo.tabId, (t) => {
        if (t?.title) setActiveTabTitle(t.title);
        if (t?.url !== undefined) setActiveTabUrl(t.url || "");
      });
    };

    // Also update URL when tab updates (e.g. navigation within same tab)
    const onTabUpdated = (tabId: number, _info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (tab.active) {
        setActiveTabId(tabId);
        setActiveTabTitle(tab.title || "Web Page");
        setActiveTabUrl(tab.url || "");
      }
    };

    chrome.tabs.onActivated.addListener(onTabActivated);
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onTabActivated);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
    };
  }, []);

  const saveSettings = (newSettings: SettingsState) => {
    setSettings(newSettings);
    chrome.storage.local.set({ browseVoiceSettings: newSettings });
    setSettingsOpen(false);
  };

  /**
   * Emergency Stop ("ruko" / "stop" or Stop button).
   * Mandatory Rule: Cancels speech and all pending actions immediately.
   */
  const handleEmergencyStop = useCallback(() => {
    isStoppedRef.current = true;
    micSessionRef.current.stop();
    gnaniWsRef.current?.disconnect();
    stopAllSpeech();

    setStatus("stopped");
    setStatusText("Stopped / रोक दिया गया");
    setPendingConfirmationAction(null);

    // Notify tab content script to remove indicator
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { type: "BV_DEACTIVATE_AGENT" }).catch(() => {});
    }
  }, [activeTabId]);

  /**
   * Query snapshot from content script
   */
  const fetchPageSnapshot = async (tabId: number): Promise<PageSnapshot> => {
    const response = await chrome.tabs.sendMessage(tabId, { type: "BV_GET_SNAPSHOT" });
    if (!response || !response.ok || !response.snapshot) {
      throw new Error(response?.error || "Failed to retrieve page snapshot from tab.");
    }
    return response.snapshot as PageSnapshot;
  };

  /**
   * Helper to speak using Gnani Timbre with Hindi / Indic language support
   */
  const speakStatus = async (text: string) => {
    if (isStoppedRef.current || !text) return;
    setStatus("speaking");
    setStatusText(text);

    const gnaniConfig: GnaniConfig = {
      apiKey: settings.gnaniApiKey,
      languageCode: settings.languageCode,
      ttsVoice: "Nalini",
      ttsModel: "timbre-v2.5",
    };

    await speakWithTimbre(text, gnaniConfig);
    if (!isStoppedRef.current) {
      setStatus("idle");
    }
  };

  /**
   * Checks whether the current tab URL is a restricted Chrome-internal page
   * where content scripts cannot be injected.
   */
  const isRestrictedPage = (url: string | undefined): boolean => {
    if (!url) return true;
    return (
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("about:") ||
      url.startsWith("edge://") ||
      url === "chrome://newtab/" ||
      url === "about:blank"
    );
  };

  /**
   * Tries to resolve a plain "open X" / "navigate to X" intent directly
   * without needing Gemini, for use when on a restricted page.
   * Returns a URL string or null.
   */
  const resolveDirectNavigationIntent = (request: string): string | null => {
    const r = request.toLowerCase().trim();

    // Patterns: "open X", "go to X", "navigate to X", "X kholna", "X kholo"
    const patterns = [
      /^(?:open|go\s+to|navigate\s+to|take\s+me\s+to|visit)\s+(.+)$/i,
      /^(.+?)\s+(?:kholo|kholna|khollo|open\s+karo|open\s+kar)$/i,
    ];

    let siteName: string | null = null;
    for (const pat of patterns) {
      const m = r.match(pat);
      if (m) { siteName = m[1].trim(); break; }
    }

    if (!siteName) return null;

    // If it already looks like a URL, use it directly
    if (/^https?:\/\//i.test(siteName)) return siteName;
    if (/\.[a-z]{2,}(\/|$)/i.test(siteName)) return `https://${siteName}`;

    // Common site name → URL mapping
    const siteMap: Record<string, string> = {
      leetcode: "https://leetcode.com",
      youtube: "https://youtube.com",
      google: "https://google.com",
      gmail: "https://mail.google.com",
      github: "https://github.com",
      stackoverflow: "https://stackoverflow.com",
      "stack overflow": "https://stackoverflow.com",
      twitter: "https://twitter.com",
      x: "https://x.com",
      facebook: "https://facebook.com",
      instagram: "https://instagram.com",
      linkedin: "https://linkedin.com",
      amazon: "https://amazon.in",
      flipkart: "https://flipkart.com",
      netflix: "https://netflix.com",
      spotify: "https://spotify.com",
      reddit: "https://reddit.com",
      whatsapp: "https://web.whatsapp.com",
      maps: "https://maps.google.com",
      "google maps": "https://maps.google.com",
      drive: "https://drive.google.com",
      "google drive": "https://drive.google.com",
      docs: "https://docs.google.com",
      sheets: "https://sheets.google.com",
      irctc: "https://irctc.co.in",
      paytm: "https://paytm.com",
      swiggy: "https://swiggy.com",
      zomato: "https://zomato.com",
      chatgpt: "https://chatgpt.com",
      "chat gpt": "https://chatgpt.com",
      gemini: "https://gemini.google.com",
      notion: "https://notion.so",
      figma: "https://figma.com",
      canva: "https://canva.com",
    };

    const normalized = siteName.toLowerCase().replace(/\s+/g, " ");
    if (siteMap[normalized]) return siteMap[normalized];

    // Fallback: treat as domain
    return `https://${siteName.replace(/\s+/g, "")}.com`;
  };

  /**
   * Core Agent Execution Loop
   */
  const runAgentLoop = async (initialRequest: string) => {
    if (!activeTabId) {
      alert("No active browser tab found.");
      return;
    }

    isStoppedRef.current = false;
    setSteps([]);
    setStatus("thinking");
    setStatusText("Analyzing page / पेज की जाँच हो रही है...");

    // --- Check if we're on a restricted page (chrome://, new tab, etc.) ---
    const tabInfo = await chrome.tabs.get(activeTabId);
    if (isRestrictedPage(tabInfo.url)) {
      // Try to resolve navigation intent directly (no LLM needed)
      const directUrl = resolveDirectNavigationIntent(initialRequest);
      if (directUrl) {
        setStatus("executing");
        setStatusText(`Opening ${directUrl}...`);
        const navAction: PlannerAction = {
          action: "navigate",
          url: directUrl,
          rationale: `${directUrl} खोला जा रहा है।`,
        };
        setSteps([{
          stepNumber: 1,
          action: navAction,
          status: "success",
          spokenSummary: navAction.rationale,
          timestamp: Date.now(),
        }]);
        await chrome.tabs.update(activeTabId, { url: directUrl });
        setStatus("idle");
        setStatusText("Navigated / पेज खुल रहा है");
        return;
      }
      // Can't do anything else on restricted pages
      setStatus("idle");
      setStatusText("⚠️ Please go to a normal webpage first");
      alert(
        "Browse Voice cannot control Chrome's built-in pages (new tab, chrome://settings, etc.).\n\n" +
        "Please navigate to any website (e.g. google.com) and then give your command."
      );
      return;
    }

    // 1. Activate on-page visual indicator
    try {
      await chrome.tabs.sendMessage(activeTabId, {
        type: "BV_ACTIVATE_AGENT",
        statusText: "Processing",
      });
    } catch {
      // Content script may need injection
      await chrome.runtime.sendMessage({
        type: "BV_ENSURE_TAB_CONNECTED",
        tabId: activeTabId,
      });
    }

    const planner: PlannerProvider = createPlanner({
      provider: settings.llmProvider,
      apiKey: settings.llmApiKey,
      endpoint: settings.llmEndpoint,
      model: settings.llmModel,
    });

    let currentSnapshot = await fetchPageSnapshot(activeTabId);
    let stepCount = 0;
    const MAX_STEPS = 15;

    while (stepCount < MAX_STEPS) {
      if (isStoppedRef.current) break;
      stepCount++;

      setStatus("thinking");
      setStatusText(`Step ${stepCount}: Planning next action...`);

      // 2. Query Planner
      let action: PlannerAction;
      try {
        action = await planner.plan({
          userRequest: initialRequest,
          snapshot: currentSnapshot,
          history: stepsRef.current.slice(-5),
        });
      } catch (planErr) {
        const errMsg = planErr instanceof Error ? planErr.message : "Planning error.";
        await speakStatus(`योजना बनाने में त्रुटि: ${errMsg}`);
        break;
      }

      if (isStoppedRef.current) break;

      // 3. Inspect Action Safety
      const safety = inspectActionSafety(action, currentSnapshot);

      // SENSITIVE FIELD BLOCKED
      if (!safety.permitted) {
        const speech = safety.safetyAlertSpeech || "यह फील्ड संवेदनशील है। कृपया इसे खुद भरें।";
        const entry: StepLogEntry = {
          stepNumber: stepCount,
          action,
          status: "blocked",
          spokenSummary: speech,
          details: safety.reason,
          timestamp: Date.now(),
        };
        setSteps((prev) => [...prev, entry]);
        await speakStatus(speech);
        break;
      }

      // SUBMIT / PAYMENT CONFIRMATION GATING
      if (safety.requiresConfirmation) {
        setStatus("confirmation");
        const confirmSpeech = safety.safetyAlertSpeech || "क्या आप भुगतान की पुष्टि करना चाहते हैं? हाँ कहें।";
        setStatusText("Waiting for confirmation / पुष्टि की प्रतीक्षा");
        setPendingConfirmationAction(action);
        setConfirmationMessage(confirmSpeech);

        const entry: StepLogEntry = {
          stepNumber: stepCount,
          action,
          status: "confirmation_required",
          spokenSummary: confirmSpeech,
          details: safety.reason,
          timestamp: Date.now(),
        };
        setSteps((prev) => [...prev, entry]);

        await speakStatus(confirmSpeech);
        // Wait for user to say "haan" / "yes" or click confirm button
        return; // Pause loop until confirmation event
      }

      // Check for DONE action
      if (action.action === "done") {
        const entry: StepLogEntry = {
          stepNumber: stepCount,
          action,
          status: "success",
          spokenSummary: action.summary,
          timestamp: Date.now(),
        };
        setSteps((prev) => [...prev, entry]);
        await speakStatus(action.summary);
        setStatus("idle");
        setStatusText("Completed / पूरा हुआ");
        break;
      }

      // Check for ASK_USER action
      if (action.action === "ask_user") {
        const entry: StepLogEntry = {
          stepNumber: stepCount,
          action,
          status: "success",
          spokenSummary: action.question,
          timestamp: Date.now(),
        };
        setSteps((prev) => [...prev, entry]);
        await speakStatus(action.question);
        setStatus("idle");
        setStatusText("Awaiting response / उत्तर की प्रतीक्षा");
        break;
      }

      // 4. Execute Action in Tab
      setStatus("executing");
      setStatusText(`Step ${stepCount}: Executing ${action.action}...`);

      const execResponse = await chrome.tabs.sendMessage(activeTabId, {
        type: "BV_EXECUTE_ACTION",
        action,
      });

      if (!execResponse?.ok) {
        const err = execResponse?.error || "Action execution failed.";
        setSteps((prev) => [
          ...prev,
          {
            stepNumber: stepCount,
            action,
            status: "failed",
            details: err,
            timestamp: Date.now(),
          },
        ]);
        await speakStatus(`कार्रवाई विफल: ${err}`);
        break;
      }

      // Record successful step
      const rationaleText = action.rationale || `Executed ${action.action}`;
      setSteps((prev) => [
        ...prev,
        {
          stepNumber: stepCount,
          action,
          status: "success",
          spokenSummary: rationaleText,
          timestamp: Date.now(),
        },
      ]);

      // 5. Timbre speaks short sentence about what it is doing
      await speakStatus(rationaleText);

      // Re-observe
      if (execResponse.freshSnapshot) {
        currentSnapshot = execResponse.freshSnapshot;
      } else {
        currentSnapshot = await fetchPageSnapshot(activeTabId);
      }
    }

    if (stepCount >= MAX_STEPS) {
      await speakStatus("अधिकतम 15 कदम पूरे हो गए हैं। कार्य रोक दिया गया।");
    }
  };

  /**
   * Resumes the loop after the user gives confirmation for submit/payment
   */
  const confirmAndResumeAction = async () => {
    if (!pendingConfirmationAction || !activeTabId) return;
    const actionToRun = pendingConfirmationAction;
    setPendingConfirmationAction(null);
    setConfirmationMessage("");

    setStatus("executing");
    setStatusText("Executing confirmed action...");

    const execResponse = await chrome.tabs.sendMessage(activeTabId, {
      type: "BV_EXECUTE_ACTION",
      action: actionToRun,
    });

    if (execResponse?.ok) {
      setSteps((prev) => [
        ...prev,
        {
          stepNumber: prev.length + 1,
          action: actionToRun,
          status: "success",
          spokenSummary: "पुष्टि प्राप्त हुई। भुगतान सबमिट हो गया है।",
          timestamp: Date.now(),
        },
      ]);
      await speakStatus("भुगतान सबमिट हो गया है। रसीद स्क्रीन पर उपलब्ध है।");
      setStatus("idle");
      setStatusText("Completed / कार्य पूरा हुआ");
    }
  };

  /**
   * Toggle Voice Dictation / Recording
   */
  const toggleRecording = async () => {
    if (micSessionRef.current.isActive()) {
      // User tapped stop recording
      micSessionRef.current.stop();
      gnaniWsRef.current?.disconnect();
      setStatus("idle");
      setStatusText("Ready / तैयार");

      // If transcript was captured, kick off the loop
      if (transcript.trim()) {
        const text = transcript.trim();
        // Check for stop word
        if (isStopCommand(text)) {
          handleEmergencyStop();
          return;
        }
        // Check for confirmation
        if (pendingConfirmationAction && isConfirmationCommand(text)) {
          await confirmAndResumeAction();
          return;
        }
        await runAgentLoop(text);
      }
    } else {
      // Start recording
      setTranscript("");
      setStatus("listening");
      setStatusText("Listening / सुन रहे हैं... ('रुको' कहने पर रुक जाएगा)");

      try {
        // 1. If Gnani API key configured, connect Gnani Prisma WebSocket
        if (settings.gnaniApiKey) {
          gnaniWsRef.current = new GnaniPrismaWebSocketClient(
            {
              apiKey: settings.gnaniApiKey,
              languageCode: settings.languageCode,
              sttModel: "prisma-v3.0",
            },
            (text) => {
              setTranscript(text);
              if (isStopCommand(text)) {
                handleEmergencyStop();
              }
            },
            (err) => console.warn("Prisma WS error:", err)
          );
          await gnaniWsRef.current.connect().catch((e) => console.warn("Prisma connect fallback:", e));
        }

        // 2. Start microphone audio capture in side panel
        await micSessionRef.current.start(
          (pcmChunk) => {
            gnaniWsRef.current?.sendAudioChunk(pcmChunk);
          },
          (text, isFinal) => {
            setTranscript(text);
            if (isStopCommand(text)) {
              handleEmergencyStop();
              return;
            }
            if (isFinal) {
              // End of utterance detected
              micSessionRef.current.stop();
              gnaniWsRef.current?.disconnect();
              if (pendingConfirmationAction && isConfirmationCommand(text)) {
                confirmAndResumeAction();
              } else {
                runAgentLoop(text);
              }
            }
          },
          settings.languageCode
        );
      } catch (err) {
        setStatus("idle");
        setStatusText("Microphone access error");
        alert(`Microphone permission error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPrompt.trim()) return;
    const prompt = currentPrompt.trim();
    setCurrentPrompt("");
    setTranscript(prompt);

    if (isStopCommand(prompt)) {
      handleEmergencyStop();
      return;
    }

    if (pendingConfirmationAction && isConfirmationCommand(prompt)) {
      confirmAndResumeAction();
      return;
    }

    runAgentLoop(prompt);
  };

  return (
    <>
      {/* Header with Brand & Emergency Stop */}
      <header className="panel-header">
        <div className="brand-wrapper">
          <span className="brand-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8"/></svg></span>
          <div>
            <div className="brand-title">Browse Voice</div>
            <span className="brand-badge">{settings.languageCode}</span>
          </div>
        </div>

        <div className="header-actions">
          <button
            className="btn-stop"
            onClick={handleEmergencyStop}
            title="Emergency Stop / आपातकालीन रोक (रुको)"
          >
            <span className="stop-square" /> Ruko / Stop
          </button>
          <button
            className="btn-icon"
            onClick={() => setSettingsOpen(true)}
            title="Settings / सेटिंग्स"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.6.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.6-.9l-1.7.7-1.4-2.4L7.5 15a8 8 0 0 1 0-1.9L6.1 12l1.4-2.4 1.7.7a8 8 0 0 1 1.6-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.6.9l1.7-.7 1.4 2.4-1.4 1.1a8 8 0 0 1-.1 1.9Z"/></svg>
          </button>
        </div>
      </header>

      {/* Main Body */}
      <div className="panel-body">
        {/* Status Card */}
        <div className="status-card">
          <div className="status-indicator">
            <span className={`status-dot ${status}`} />
            <span className="status-label">{statusText}</span>
          </div>
          <span className="status-info" title={activeTabTitle}>{activeTabTitle ? activeTabTitle.slice(0, 22) : "No active tab"}{activeTabTitle.length > 22 ? "…" : ""}</span>
        </div>

        {/* Restricted Page Warning Banner */}
        {activeTabUrl && isRestrictedPage(activeTabUrl) && (
          <div className="restricted-banner" role="status">
            <span className="restricted-icon" aria-hidden="true">!</span>
            <div><strong>Restricted page</strong><span className="restricted-copy">Chrome blocks extensions here. You can still say <em>“open YouTube”</em> or <em>“open LeetCode”</em> to navigate away.</span></div>
          </div>
        )}

        {/* Safety Confirmation Alert Box */}
        {pendingConfirmationAction && (
          <div className="confirmation-box">
            <div className="confirmation-header">
              <span className="alert-mark" aria-hidden="true">!</span>
              <span>पुष्टि आवश्यक (Confirmation Needed)</span>
            </div>
            <p className="confirmation-text">{confirmationMessage}</p>
            <div className="confirmation-actions">
              <button className="btn-confirm-yes" onClick={confirmAndResumeAction}>
                ✓ Haan / Yes (पुष्टि करें)
              </button>
              <button
                className="btn-confirm-no"
                onClick={() => {
                  setPendingConfirmationAction(null);
                  setStatus("idle");
                  setStatusText("Cancelled / रद्द किया गया");
                }}
              >
                ✕ Cancel / रद्द करें
              </button>
            </div>
          </div>
        )}

        {/* Microphone Voice Control Card */}
        <section className="mic-section" aria-label="Voice controls">
          <div className="voice-kicker">VOICE CONTROL</div>
          <button
            className={`mic-button ${status === "listening" ? "recording" : ""}`}
            onClick={toggleRecording}
            title="Tap to speak in Hindi/Indian Languages"
            aria-label={status === "listening" ? "Stop listening" : "Start voice input"}
          >
            {status === "listening" ? <span className="recording-mark" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8"/></svg>}
          </button>
          <div className="mic-help">
            {status === "listening"
              ? "Listening... Tap to stop or say 'रुको' to cancel"
              : "Tap mic to speak (e.g. 'बिजली बिल देखो', 'bill bharo')"}
          </div>

          {/* Live Transcript View */}
          <div className="transcript-card">
            <div className="transcript-header">Live Transcript</div>
            <div className="transcript-text">
              {transcript || <span className="transcript-empty">Your voice will appear here...</span>}
            </div>
          </div>

          {/* Manual Text Fallback */}
          <form className="send-row" onSubmit={handleManualSubmit}>
            <input
              type="text"
              className="input-text"
              placeholder="Or type command here..."
              value={currentPrompt}
              onChange={(e) => setCurrentPrompt(e.target.value)}
            />
            <button type="submit" className="btn-primary">
              Send
            </button>
          </form>
        </section>

        {/* Step Execution Timeline */}
        <div className="step-log-section">
          <div className="steps-heading"><div><div className="section-title">ACTIVITY</div><div className="steps-title">Execution steps</div></div><span className="steps-count">{steps.length} / 15</span></div>
          {steps.length === 0 ? (
            <div className="empty-steps">
              <span className="empty-line" />Your actions will appear here
            </div>
          ) : (
            <div className="step-list">
              {steps.map((step) => (
                <div key={step.stepNumber} className={`step-card ${step.status}`}>
                  <div className="step-card-header">
                    <span className="step-badge">Step {step.stepNumber}</span>
                    <span className="step-action-tag">{step.action.action.toUpperCase()}</span>
                  </div>
                  {step.action.rationale && (
                    <div className="step-rationale">{step.action.rationale}</div>
                  )}
                  {step.spokenSummary && (
                    <div className="step-speech">
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4Zm12-1a5 5 0 0 1 0 6m2-9a9 9 0 0 1 0 12"/></svg>
                      <span>{step.spokenSummary}</span>
                    </div>
                  )}
                  {step.details && (
                    <div style={{ fontSize: "11px", color: "var(--accent-red)" }}>
                      {step.details}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Settings / सेटिंग्स</span>
              <button
                className="btn-icon"
                onClick={() => setSettingsOpen(false)}
                style={{ border: "none" }}
              >
                ✕
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">Language / भाषा</label>
              <select
                className="form-select"
                value={settings.languageCode}
                onChange={(e) => setSettings({ ...settings, languageCode: e.target.value })}
              >
                {SUPPORTED_INDIAN_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label} ({lang.code})
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Gnani AI API Key</label>
              <input
                type="password"
                className="form-input"
                placeholder="Enter Gnani API Key"
                value={settings.gnaniApiKey}
                onChange={(e) => setSettings({ ...settings, gnaniApiKey: e.target.value })}
              />
              <span className="form-help">
                Required for Gnani Prisma STT and Timbre TTS. Stored securely in chrome.storage.local.
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">Planner Provider</label>
              <select
                className="form-select"
                value={settings.llmProvider}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    llmProvider: e.target.value as "mock" | "openai-compatible" | "gemini",
                  })
                }
              >
                <option value="mock">Rule-Based Mock Planner (Offline Demo)</option>
                <option value="gemini">Google Gemini (AI Studio)</option>
                <option value="openai-compatible">OpenAI-Compatible LLM</option>
              </select>
            </div>

            {/* Gemini fields: only API key needed (endpoint is automatic) */}
            {settings.llmProvider === "gemini" && (
              <>
                <div className="form-group">
                  <label className="form-label">Gemini API Key (Google AI Studio)</label>
                  <input
                    type="password"
                    className="form-input"
                    placeholder="AIza..."
                    value={settings.llmApiKey}
                    onChange={(e) => setSettings({ ...settings, llmApiKey: e.target.value })}
                  />
                  <span className="form-help">
                    Get your free key at{" "}
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                      aistudio.google.com/apikey
                    </a>
                  </span>
                </div>

                <div className="form-group">
                  <label className="form-label">Gemini Model</label>
                  <select
                    className="form-select"
                    value={settings.llmModel}
                    onChange={(e) => setSettings({ ...settings, llmModel: e.target.value })}
                  >
                    <option value="gemini-3.8-flash">gemini-3.8-flash (Recommended)</option>
                  </select>
                </div>
              </>
            )}

            {settings.llmProvider === "openai-compatible" && (
              <>
                <div className="form-group">
                  <label className="form-label">LLM API Key</label>
                  <input
                    type="password"
                    className="form-input"
                    placeholder="sk-..."
                    value={settings.llmApiKey}
                    onChange={(e) => setSettings({ ...settings, llmApiKey: e.target.value })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">LLM Base Endpoint</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="https://api.openai.com/v1"
                    value={settings.llmEndpoint}
                    onChange={(e) => setSettings({ ...settings, llmEndpoint: e.target.value })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">LLM Model Name</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="gpt-4o-mini or deepseek-chat"
                    value={settings.llmModel}
                    onChange={(e) => setSettings({ ...settings, llmModel: e.target.value })}
                  />
                </div>
              </>
            )}

            <button
              className="btn-primary"
              style={{ marginTop: "8px" }}
              onClick={() => saveSettings(settings)}
            >
              Save Settings
            </button>
          </div>
        </div>
      )}
    </>
  );
};
