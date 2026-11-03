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
  llmModel: (import.meta.env.VITE_LLM_MODEL as string) || "gemini-2.0-flash",
};

export const App: React.FC = () => {
  // Agent state
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [statusText, setStatusText] = useState<string>("Ready / तैयार");
  const [transcript, setTranscript] = useState<string>("");
  const [activeTabTitle, setActiveTabTitle] = useState<string>("");
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
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
        setSettings({ ...DEFAULT_SETTINGS, ...result.browseVoiceSettings });
      } else {
        chrome.storage.local.set({ browseVoiceSettings: DEFAULT_SETTINGS });
      }
    });

    // Detect active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id) {
        setActiveTabId(tab.id);
        setActiveTabTitle(tab.title || "Web Page");
      }
    });

    // Listen for tab activation changes
    const onTabActivated = (activeInfo: chrome.tabs.TabActiveInfo) => {
      setActiveTabId(activeInfo.tabId);
      chrome.tabs.get(activeInfo.tabId, (t) => {
        if (t?.title) setActiveTabTitle(t.title);
      });
    };

    chrome.tabs.onActivated.addListener(onTabActivated);
    return () => {
      chrome.tabs.onActivated.removeListener(onTabActivated);
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
          <span className="brand-icon">🎙️</span>
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
            ⏹ Ruko / Stop
          </button>
          <button
            className="btn-icon"
            onClick={() => setSettingsOpen(true)}
            title="Settings / सेटिंग्स"
          >
            ⚙️
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
          <span className="status-info">{activeTabTitle.slice(0, 22)}...</span>
        </div>

        {/* Safety Confirmation Alert Box */}
        {pendingConfirmationAction && (
          <div className="confirmation-box">
            <div className="confirmation-header">
              <span>⚠️</span>
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
        <div className="mic-section">
          <button
            className={`mic-button ${status === "listening" ? "recording" : ""}`}
            onClick={toggleRecording}
            title="Tap to speak in Hindi/Indian Languages"
          >
            {status === "listening" ? "🔴" : "🎙️"}
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
        </div>

        {/* Step Execution Timeline */}
        <div className="step-log-section">
          <div className="section-title">Execution Steps ({steps.length}/15)</div>
          {steps.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: "12px", fontStyle: "italic" }}>
              No steps executed yet. Speak a command to begin.
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
                      <span>🔊</span>
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
                    <option value="gemini-2.0-flash">gemini-2.0-flash (Recommended)</option>
                    <option value="gemini-1.5-flash">gemini-1.5-flash</option>
                    <option value="gemini-1.5-pro">gemini-1.5-pro</option>
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
