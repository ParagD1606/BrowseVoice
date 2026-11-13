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
  answerAboutSnips,
  convertFormAnswerToEnglish,
  decomposeRequest,
  fallbackToSingleTask,
  type StepLogEntry,
  type SnipContext,
} from "../lib/planner";
import {
  inspectActionSafety,
  isStopCommand,
  isConfirmationCommand,
  type PageSnapshot,
} from "../lib/safety";
import { validatePlannerAction, type PlannerAction } from "../lib/schema";
import type { SubTask } from "../lib/schema";
import { getPlannerRetryAfterMs, isPlannerRateLimitError } from "../lib/planner";
import { MicrophoneSession } from "./mic";
import {
  askSiteQuestion,
  getSiteIndexProgress,
  startSiteIndexing,
  type SiteChatHistoryEntry,
  type SiteIndexProgress,
  type SiteIndexStatus,
} from "../lib/site-chat";
import { requestSiteSafety, type SiteSafetyResult } from "../lib/site-safety";
import {
  createTaskRunnerContext,
  resumeAgentTask,
  runAgentTask,
  stopAgentTask,
  stopAgentTasks,
  type TaskRunnerContext,
  type TaskRunnerResult,
  type TaskRunnerStatus,
} from "./taskRunner";
import {
  resolveLanguage,
  getUiTranslation,
  UI_TRANSLATIONS,
  ACTION_SPEECH,
  FORM_QUESTION_COPY,
  ACTION_TAG_TRANSLATIONS,
  type SupportedLanguageCode,
  type InterfaceLanguage,
} from "../lib/i18n";

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
  /** Planner API used for browser actions. */
  llmProvider: "mock" | "openai-compatible" | "huggingface" | "gemini";
  llmApiKey: string;
  llmEndpoint: string;
  llmModel: string;
  siteChatEndpoint: string;
  siteChatApiKey: string;
  siteChatMaxPages: number;
  taskConcurrency: number;
  focusCompletedTab: boolean;
}

interface FormFieldDescriptor {
  fingerprint: string;
  identity: string;
  occurrence: number;
  label: string;
  tag: string;
  type?: string;
  kind: "text" | "select" | "checkbox" | "radio";
  name?: string;
  options?: string[];
}

interface FormFillSession {
  tabId: number;
  goal: string;
  fields: FormFieldDescriptor[];
  index: number;
  completed: Set<string>;
  skippedManualCount: number;
}

function collectFormFields(snapshot: PageSnapshot): { fields: FormFieldDescriptor[]; manualFields: Array<{ id: number; label: string; reason: string }> } {
  const occurrenceByIdentity = new Map<string, number>();
  const manualFields: Array<{ id: number; label: string; reason: string }> = [];
  const fields: FormFieldDescriptor[] = [];
  const radioGroups = new Map<string, { field: FormFieldDescriptor; labels: string[] }>();
  for (const element of snapshot.interactiveElements) {
    if (!["input", "textarea", "select"].includes(element.tag)) continue;
    const type = (element.type || "text").toLowerCase();
    if (element.tag === "input" && ["button", "submit", "reset", "hidden", "image"].includes(type)) continue;
    if (element.tag === "input" && type === "file") {
      manualFields.push({ id: element.id, label: element.label || "File upload", reason: "Choose this file yourself" });
      continue;
    }
    if (element.isSensitive) {
      manualFields.push({ id: element.id, label: element.label || element.placeholder || element.name || "Sensitive field", reason: "Fill manually for your security" });
      continue;
    }

    const label = element.label.trim() || element.placeholder?.trim() || element.name?.trim() || `${element.tag} field`;
    if (element.tag === "input" && type === "radio") {
      const groupName = element.name || label;
      const identity = JSON.stringify(["radio", groupName]);
      const existingGroup = radioGroups.get(identity);
      if (existingGroup) {
        if (!existingGroup.labels.includes(label)) existingGroup.labels.push(label);
      } else {
        const occurrence = occurrenceByIdentity.get(identity) || 0;
        occurrenceByIdentity.set(identity, occurrence + 1);
        const field: FormFieldDescriptor = {
          fingerprint: `${identity}#${occurrence}`, identity, occurrence,
          label: groupName.replace(/[_-]+/g, " "), tag: element.tag, type,
          kind: "radio", name: element.name, options: [label],
        };
        radioGroups.set(identity, { field, labels: field.options! });
        fields.push(field);
      }
      continue;
    }

    const identity = JSON.stringify([element.tag, element.type || "", label, element.name || "", element.placeholder || ""]);
    const occurrence = occurrenceByIdentity.get(identity) || 0;
    occurrenceByIdentity.set(identity, occurrence + 1);
    const kind = element.tag === "select" ? "select" : type === "checkbox" ? "checkbox" : "text";
    fields.push({ fingerprint: `${identity}#${occurrence}`, identity, occurrence, label, tag: element.tag, type: element.type, kind, name: element.name, options: kind === "select" ? element.options || [] : undefined });
  }
  return { fields, manualFields };
}

function findFormField(snapshot: PageSnapshot, descriptor: FormFieldDescriptor, answer?: string) {
  if (descriptor.kind === "radio") {
    const selectedLabel = matchOption(descriptor.options || [], answer || "");
    if (!selectedLabel) return undefined;
    return snapshot.interactiveElements.find((element) =>
      element.tag === "input" && element.type?.toLowerCase() === "radio" && element.name === descriptor.name
      && element.label.trim().toLowerCase() === selectedLabel.toLowerCase() && !element.isSensitive,
    );
  }
  const matches = snapshot.interactiveElements.filter((element) => {
    const label = element.label.trim() || element.placeholder?.trim() || element.name?.trim() || `${element.tag} field`;
    const identity = JSON.stringify([element.tag, element.type || "", label, element.name || "", element.placeholder || ""]);
    return identity === descriptor.identity && !element.isSensitive;
  });
  return matches[descriptor.occurrence];
}

function parseYesNo(value: string): boolean | null {
  const answer = value.trim();
  if (/^(yes|y|yeah|haan|ha|check|tick|true)(?:\b|$)/i.test(answer) || /^(हाँ|हां)(?:\s|$|[,!.])/u.test(answer)) return true;
  if (/^(no|n|nope|nahin|nahi|leave unchecked|false)(?:\b|$)/i.test(answer) || /^(नहीं|नहि)(?:\s|$|[,!.])/u.test(answer)) return false;
  return null;
}

function toEnglishDigits(value: string): string {
  return value.replace(/[०-९]/g, (digit) => String("०१२३४५६७८९".indexOf(digit)));
}

function matchOption(options: string[], answer: string): string | undefined {
  const normalized = answer.trim().toLowerCase();
  const ordinal = new Map<string, number>([
    ["पहला", 0], ["पहली", 0], ["एक", 0], ["दूसरा", 1], ["दूसरी", 1], ["दो", 1],
    ["तीसरा", 2], ["तीसरी", 2], ["तीन", 2], ["चौथा", 3], ["चौथी", 3], ["चार", 3],
  ]).get(normalized);
  if (ordinal !== undefined) return options[ordinal];
  const numericIndex = /^\d+$/.test(normalized) ? Number(normalized) - 1 : -1;
  if (numericIndex >= 0) return options[numericIndex];
  return options.find((option) => option.toLowerCase() === normalized || option.toLowerCase().includes(normalized));
}

const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const HUGGINGFACE_ENDPOINT = "https://router.huggingface.co/v1";
const DEFAULT_HUGGINGFACE_MODEL = "openai/gpt-oss-20b:deepinfra";
const RETIRED_GEMINI_MODELS = new Set([
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
]);

const DEFAULT_SETTINGS: SettingsState = {
  gnaniApiKey: (import.meta.env.VITE_GNANI_API_KEY as string) || "",
  languageCode: (import.meta.env.VITE_LANGUAGE_CODE as string) || "en-IN",
  llmProvider:
    (import.meta.env.VITE_LLM_PROVIDER as "mock" | "openai-compatible" | "huggingface" | "gemini") ||
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
  llmEndpoint: (import.meta.env.VITE_LLM_PROVIDER === "huggingface"
    ? HUGGINGFACE_ENDPOINT
    : (import.meta.env.VITE_LLM_ENDPOINT as string) || "https://api.openai.com/v1"),
  llmModel: (import.meta.env.VITE_LLM_MODEL as string) ||
    (import.meta.env.VITE_LLM_PROVIDER === "huggingface" ? DEFAULT_HUGGINGFACE_MODEL : DEFAULT_GEMINI_MODEL),
  siteChatEndpoint: (import.meta.env.VITE_SITE_CHAT_ENDPOINT as string) || "",
  siteChatApiKey: (import.meta.env.VITE_SITE_CHAT_API_KEY as string) || "",
  siteChatMaxPages: Number(import.meta.env.VITE_SITE_CHAT_MAX_PAGES || 25),
  taskConcurrency: 3,
  focusCompletedTab: false,
};

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface TaskCardState {
  id: string;
  label: string;
  tabId: number | null;
  tabTitle: string;
  faviconUrl?: string;
  status: TaskRunnerStatus;
  currentStep: string;
  steps: StepLogEntry[];
  confirmationMessage?: string;
  summary?: string;
  error?: string;
}

interface SiteChatState {
  status: SiteIndexStatus | "idle";
  startUrl: string;
  siteId: string;
  jobId: string;
  pagesIndexed: number;
  totalPages?: number;
  message: string;
}

const resolveSpeechLanguage = resolveLanguage;

function isSelectionCommand(text: string): boolean {
  const value = text.toLowerCase().trim();
  return /(?:select|snip|capture|screenshot|crop|highlight).*(?:area|this|that|section|part|region)?|(?:yeh|yah|is|this)\s+(?:select|snip|capture|screenshot)|area\s+(?:select|snip)|select\s+karo/.test(value);
}

function localizedActionSpeech(action: PlannerAction, snapshot: PageSnapshot, languageCode: string): string {
  const lang = resolveLanguage(languageCode);
  const speech = ACTION_SPEECH[lang] || ACTION_SPEECH["en-IN"];
  if (action.action === "navigate") return speech.opened;
  if (action.action === "scroll") return speech.scrolled.replace("%s", action.direction);
  if (action.action === "click" || action.action === "type" || action.action === "select") {
    const target = snapshot.interactiveElements.find((element) => element.id === action.id);
    const label = target?.label?.trim() || "field";
    if (action.action === "click") return speech.clicked.replace("%s", label);
    if (action.action === "select") return speech.selected.replace("%s", label);
    return speech.filled.replace("%s", label);
  }
  return action.action === "done" ? action.summary : action.action === "ask_user" ? action.question : "";
}

function localizedFormQuestion(field: FormFieldDescriptor, languageCode: string): string {
  const lang = resolveLanguage(languageCode);
  const copy = FORM_QUESTION_COPY[lang] || FORM_QUESTION_COPY["en-IN"];
  const label = field.label.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (field.kind === "checkbox") return copy.checkbox.replace("%s", label);
  if (field.kind === "select" || field.kind === "radio") {
    return copy.select.replace("%s", label).replace("%s", field.options?.filter(Boolean).join(", ") || "");
  }
  return copy.generic.replace("%s", label);
}

function cropCapturedImage(dataUrl: string, rect: { x: number; y: number; width: number; height: number }, viewportWidth: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = image.width / Math.max(viewportWidth, 1);
      const sx = Math.max(0, Math.round(rect.x * scale));
      const sy = Math.max(0, Math.round(rect.y * scale));
      const sw = Math.min(image.width - sx, Math.max(1, Math.round(rect.width * scale)));
      const sh = Math.min(image.height - sy, Math.max(1, Math.round(rect.height * scale)));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const context = canvas.getContext("2d");
      if (!context) { reject(new Error("Could not prepare the selected image.")); return; }
      context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error("Could not process the selected image."));
    image.src = dataUrl;
  });
}

function migrateRetiredGeminiModel(settings: SettingsState): SettingsState {
  if (settings.llmProvider === "gemini" && RETIRED_GEMINI_MODELS.has(settings.llmModel)) {
    return { ...settings, llmModel: DEFAULT_GEMINI_MODEL };
  }
  return settings;
}

export const App: React.FC = () => {
  // Agent state
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [statusText, setStatusText] = useState<string>("Ready");
  const [voiceSessionActive, setVoiceSessionActive] = useState(false);
  const [showMicPermissionHelp, setShowMicPermissionHelp] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [activeTabTitle, setActiveTabTitle] = useState<string>("");
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [activeTabUrl, setActiveTabUrl] = useState<string>("");
  const [steps, setSteps] = useState<StepLogEntry[]>([]);
  const [currentPrompt, setCurrentPrompt] = useState<string>("");
  const [pendingConfirmationAction, setPendingConfirmationAction] = useState<PlannerAction | null>(null);
  const [confirmationMessage, setConfirmationMessage] = useState<string>("");
  const [taskCards, setTaskCards] = useState<TaskCardState[]>([]);
  const [activeConfirmationTaskId, setActiveConfirmationTaskId] = useState<string | null>(null);
  const [snips, setSnips] = useState<SnipContext[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [siteChatMessages, setSiteChatMessages] = useState<ChatMessage[]>([]);
  const [siteSafety, setSiteSafety] = useState<SiteSafetyResult | null>(null);
  const [siteSafetyLoading, setSiteSafetyLoading] = useState(false);
  const [siteChat, setSiteChat] = useState<SiteChatState>({
    status: "idle",
    startUrl: "",
    siteId: "",
    jobId: "",
    pagesIndexed: 0,
    message: "",
  });

  // Settings modal
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const translate = (english: string, hindiFallback?: string) => {
    const language = resolveLanguage(settings.languageCode, taskGoalRef.current || transcript);
    return getUiTranslation(english, language, hindiFallback);
  };

  // Refs for tracking active objects
  const micSessionRef = useRef<MicrophoneSession>(new MicrophoneSession());
  const gnaniWsRef = useRef<GnaniPrismaWebSocketClient | null>(null);
  const isStoppedRef = useRef<boolean>(false);
  const stepsRef = useRef<StepLogEntry[]>([]);
  const taskGoalRef = useRef<string | null>(null);
  const conversationRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const awaitingUserReplyRef = useRef(false);
  const formFillRef = useRef<FormFillSession | null>(null);
  const voiceSessionActiveRef = useRef(false);
  const voiceTurnProcessingRef = useRef(false);
  const requestQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedRequestKeysRef = useRef(new Set<string>());
  const requestQueueGenerationRef = useRef(0);
  const taskContextsRef = useRef(new Map<string, TaskRunnerContext>());
  const taskViewsRef = useRef(new Map<string, TaskCardState>());
  const confirmationQueueRef = useRef<string[]>([]);
  const taskRunGenerationRef = useRef(0);
  const activeTaskIdsRef = useRef<string[]>([]);
  const summarySpokenGenerationRef = useRef(0);
  const decompositionNoticeRef = useRef<string | null>(null);
  const ttsQueueRef = useRef<Promise<void>>(Promise.resolve());
  const voiceListenGenerationRef = useRef(0);
  const voiceTurnHandlerRef = useRef<(text: string) => Promise<void>>(async () => {});
  const startVoiceListeningRef = useRef<() => Promise<void>>(async () => {});
  const siteIndexPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const siteChatRef = useRef<SiteChatState>(siteChat);
  const siteChatRunRef = useRef(0);
  const siteChatTabRef = useRef<number | null>(null);
  const siteSafetyRunRef = useRef(0);
  stepsRef.current = steps;
  siteChatRef.current = siteChat;

  const publishTaskCard = (taskId: string, patch: Partial<TaskCardState>) => {
    const current = taskViewsRef.current.get(taskId);
    if (!current) return;
    const next = { ...current, ...patch };
    taskViewsRef.current.set(taskId, next);
    setTaskCards(Array.from(taskViewsRef.current.values()));
  };

  const showNextConfirmation = () => {
    const next = confirmationQueueRef.current[0] || null;
    setActiveConfirmationTaskId(next);
    const context = next ? taskContextsRef.current.get(next) : null;
    setPendingConfirmationAction(context?.pendingConfirmation?.action || null);
    setConfirmationMessage(context?.pendingConfirmation?.message || "");
  };

  const enqueueConfirmation = (taskId: string) => {
    if (taskId && !confirmationQueueRef.current.includes(taskId)) confirmationQueueRef.current.push(taskId);
    showNextConfirmation();
  };

  const advanceConfirmationQueue = () => {
    confirmationQueueRef.current = confirmationQueueRef.current.slice(1);
    showNextConfirmation();
  };

  const resetSiteChatSession = () => {
    if (siteIndexPollRef.current) clearTimeout(siteIndexPollRef.current);
    siteIndexPollRef.current = null;
    siteChatRunRef.current += 1;
    siteChatTabRef.current = null;
    setSiteChat({ status: "idle", startUrl: "", siteId: "", jobId: "", pagesIndexed: 0, message: "" });
    setSiteChatMessages([]);
  };

  const resetSiteSafety = () => {
    siteSafetyRunRef.current += 1;
    setSiteSafety(null);
    setSiteSafetyLoading(false);
  };

  // Load saved settings from chrome.storage.local
  useEffect(() => {
    chrome.storage.local.get("browseVoiceSettings", (result) => {
      if (result.browseVoiceSettings) {
        const savedSettings = result.browseVoiceSettings as Partial<SettingsState>;
        const mergedSettings = { ...DEFAULT_SETTINGS, ...savedSettings };
        const migratedSettings = migrateRetiredGeminiModel(mergedSettings);
        setSettings(migratedSettings);
        setStatusText(UI_TRANSLATIONS.Ready?.[migratedSettings.languageCode as InterfaceLanguage] || "Ready");
        if (migratedSettings.llmModel !== savedSettings.llmModel) {
          chrome.storage.local.set({ browseVoiceSettings: migratedSettings });
        }
      } else {
        const initialSettings = migrateRetiredGeminiModel(DEFAULT_SETTINGS);
        setSettings(initialSettings);
        setStatusText(UI_TRANSLATIONS.Ready?.[initialSettings.languageCode as InterfaceLanguage] || "Ready");
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
    const onTabActivated = (activeInfo: chrome.tabs.OnActivatedInfo) => {
      if (siteChatRef.current.status !== "idle" && siteChatTabRef.current !== null && siteChatTabRef.current !== activeInfo.tabId) {
        resetSiteChatSession();
      }
      setActiveTabId(activeInfo.tabId);
      resetSiteSafety();
      chrome.tabs.get(activeInfo.tabId, (t) => {
        if (t?.title) setActiveTabTitle(t.title);
        if (t?.url !== undefined) setActiveTabUrl(t.url || "");
      });
    };

    // Also update URL when tab updates (e.g. navigation within same tab)
    const onTabUpdated = (tabId: number, _info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (tab.active) {
        if (siteChatRef.current.status !== "idle" && siteChatTabRef.current === tabId && tab.url && tab.url !== siteChatRef.current.startUrl) {
          resetSiteChatSession();
        }
        setActiveTabId(tabId);
        setActiveTabTitle(tab.title || "Web Page");
        setActiveTabUrl(tab.url || "");
        resetSiteSafety();
      }
    };

    const onTabRemoved = (tabId: number) => {
      for (const [taskId, context] of taskContextsRef.current.entries()) {
        if (context.tabId !== tabId) continue;
        stopAgentTask(context);
        publishTaskCard(taskId, { status: "failed", error: "The controlled tab was closed.", currentStep: "Tab closed" });
        taskContextsRef.current.delete(taskId);
      }
      if (activeTabId === tabId) {
        setActiveTabId(null);
        setActiveTabTitle("");
        setActiveTabUrl("");
      }
    };

    chrome.tabs.onActivated.addListener(onTabActivated);
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onRemoved.addListener(onTabRemoved);
    return () => {
      chrome.tabs.onActivated.removeListener(onTabActivated);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      chrome.tabs.onRemoved.removeListener(onTabRemoved);
    };
  }, [activeTabId]);

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
    requestQueueGenerationRef.current += 1;
    taskRunGenerationRef.current += 1;
    stopAgentTasks(taskContextsRef.current.values());
    taskContextsRef.current.clear();
    confirmationQueueRef.current = [];
    setActiveConfirmationTaskId(null);
    setPendingConfirmationAction(null);
    setConfirmationMessage("");
    setTaskCards((previous) => previous.map((task) => ({ ...task, status: "stopped", currentStep: translate("Stopped", "रोक दिया गया") })));
    micSessionRef.current.stop();
    gnaniWsRef.current?.disconnect();
    stopAllSpeech();
    siteChatRunRef.current += 1;
    siteChatTabRef.current = null;
    if (siteIndexPollRef.current) {
      clearTimeout(siteIndexPollRef.current);
      siteIndexPollRef.current = null;
    }
    voiceSessionActiveRef.current = false;
    setVoiceSessionActive(false);
    voiceListenGenerationRef.current += 1;

    setStatus("stopped");
    setStatusText(translate("Stopped", "रोक दिया गया"));
    taskGoalRef.current = null;
    conversationRef.current = [];
    awaitingUserReplyRef.current = false;
    formFillRef.current = null;

    // Notify every controlled tab to remove its indicator.
    for (const task of taskViewsRef.current.values()) {
      if (task.tabId !== null) chrome.tabs.sendMessage(task.tabId, { type: "BV_DEACTIVATE_AGENT" }).catch(() => {});
    }
  }, [activeTabId, translate]);

  const sendTabMessage = async <T,>(tabId: number, message: Record<string, unknown>): Promise<T> => {
    try {
      return await chrome.tabs.sendMessage(tabId, message) as T;
    } catch (firstError) {
      // Navigation can destroy the content-script port. Ask the service worker
      // to inject the listener into the current document before retrying once.
      const connection = await chrome.runtime.sendMessage({ type: "BV_ENSURE_TAB_CONNECTED", tabId }).catch(() => null);
      if (!connection?.ok) {
        const errorText = firstError instanceof Error ? firstError.message : "The page changed before Browse Voice could connect.";
        throw new Error(/receiving end|message channel|back.forward cache|bfcache/i.test(errorText)
          ? "The page changed before Browse Voice could respond. Please try again."
          : errorText);
      }
      try {
        return await chrome.tabs.sendMessage(tabId, message) as T;
      } catch (secondError) {
        const errorText = secondError instanceof Error ? secondError.message : "The page changed before Browse Voice could respond.";
        throw new Error(/receiving end|message channel|back.forward cache|bfcache/i.test(errorText)
          ? "The page changed before Browse Voice could respond. Please try again."
          : errorText);
      }
    }
  };

  /**
   * Query snapshot from content script
   */
  const fetchPageSnapshot = async (tabId: number): Promise<PageSnapshot> => {
    const response = await sendTabMessage<{ ok?: boolean; snapshot?: PageSnapshot; error?: string }>(tabId, { type: "BV_GET_SNAPSHOT" });
    if (!response || !response.ok || !response.snapshot) {
      throw new Error(response?.error || "Failed to retrieve page snapshot from tab.");
    }
    return response.snapshot as PageSnapshot;
  };

  /**
   * Helper to speak using Gnani Timbre with Hindi / Indic language support
   */
  const speakStatus = async (text: string, languageCode = resolveSpeechLanguage(settings.languageCode, taskGoalRef.current || transcript)) => {
    if (isStoppedRef.current || !text) return;
    const queuedSpeech = ttsQueueRef.current.catch(() => {}).then(async () => {
      if (isStoppedRef.current) return;
      setStatus("speaking");
      setStatusText(text);

      const gnaniConfig: GnaniConfig = {
        apiKey: settings.gnaniApiKey,
        languageCode,
        ttsVoice: "Nalini",
        ttsModel: "timbre-v2.5",
      };

      await speakWithTimbre(text, gnaniConfig);
      if (!isStoppedRef.current) setStatus("idle");
    });
    ttsQueueRef.current = queuedSpeech.catch(() => {});
    await queuedSpeech;
  };

  const askNextFormField = async () => {
    const session = formFillRef.current;
    const field = session?.fields[session.index];
    if (!session || !field) return;
    const question = localizedFormQuestion(field, resolveSpeechLanguage(settings.languageCode, taskGoalRef.current || ""));
    setStatus("idle");
    setStatusText(`${translate("Field", "फ़ील्ड")} ${session.index + 1} / ${session.fields.length}: ${field.label}`);
    await speakStatus(question);
    setStatusText(`${translate("Reply with a value for", "इसके लिए जानकारी दें")}: ${field.label}`);
  };

  const submitFormFieldAnswer = async (answer: string) => {
    const session = formFillRef.current;
    const field = session?.fields[session.index];
    if (!session || !field) return false;
    let value = toEnglishDigits(answer.trim());
    if (!value) {
      setStatusText(`${translate("Please answer for:", "कृपया इसके लिए उत्तर दें:")} ${field.label}`);
      return true;
    }

    setStatus("thinking");
    setStatusText(`${translate("Filling", "भर रहे हैं:")} ${field.label}...`);
    try {
      const freshSnapshot = await fetchPageSnapshot(session.tabId);
      const checkboxChoice = field.kind === "checkbox" ? parseYesNo(value) : null;
      if (field.kind === "checkbox" && checkboxChoice === null) {
        setStatus("idle");
        setStatusText(`${translate("Please answer yes or no for:", "कृपया इसके लिए हाँ या नहीं में उत्तर दें:")} ${field.label}.`);
        return true;
      }

      const element = findFormField(freshSnapshot, field, field.kind === "radio" ? value : undefined);
      if (!element && field.kind === "radio") {
        setStatus("idle");
        setStatusText(`${translate("Choose one of these options for", "इसके लिए इनमें से एक विकल्प चुनें")} ${field.label}: ${field.options?.join(", ") || ""}`);
        return true;
      }
      if (!element) throw new Error(translate("I can no longer find that field. Check the page and try again.", "मुझे वह फ़ील्ड नहीं मिल रहा है। पेज जाँचें और पुनः प्रयास करें।"));

      if (field.kind === "text" && /\p{Script=Devanagari}/u.test(value)) {
        const normalizedField = `${field.label} ${field.name || ""} ${field.type || ""}`.toLowerCase();
        if (/email|e-mail|url|website|website address/.test(normalizedField)) {
          setStatus("idle");
          setStatusText(translate("Please type this in English characters so the email or link is correct.", "यह जानकारी अंग्रेज़ी अक्षरों में टाइप करें, ताकि ईमेल या लिंक सही रहे।"));
          return true;
        }
        const conversionMode = field.type === "date" || /\b(date|dob|birth)\b/.test(normalizedField)
          ? "date"
          : /\b(first.?name|given.?name|last.?name|surname|family.?name|full.?name|name)\b/.test(normalizedField)
            ? "transliterate"
            : "translate";
        try {
          value = await convertFormAnswerToEnglish({
            provider: settings.llmProvider,
            apiKey: settings.llmApiKey,
            endpoint: settings.llmEndpoint,
            model: settings.llmModel,
          }, value, conversionMode);
          if (/\p{Script=Devanagari}/u.test(value)) {
            throw new Error("The converted value still contains Devanagari text.");
          }
        } catch (conversionError) {
          console.warn("Hindi form answer conversion failed:", conversionError);
          setStatus("idle");
          setStatusText(translate("I could not convert that to English. Please type your answer in English characters and send.", "मैं इसे अंग्रेज़ी में नहीं बदल पाया। कृपया जवाब अंग्रेज़ी अक्षरों में टाइप करें और फिर भेजें।"));
          return true;
        }
      }
      let selectedValue = value;
      if (field.kind === "select") {
        const match = matchOption(field.options || [], value);
        if (field.options?.length && !match) {
          setStatus("idle");
          setStatusText(`${translate("Choose one of these options for", "इसके लिए इनमें से एक विकल्प चुनें")} ${field.label}: ${field.options.join(", ")}`);
          return true;
        }
        selectedValue = match || value;
      }
      let candidate: PlannerAction | null;
      if (field.kind === "checkbox") {
        candidate = element.checked === checkboxChoice ? null : { action: "click", id: element.id, rationale: `${checkboxChoice ? "Checked" : "Unchecked"} ${field.label}.` };
      } else if (field.kind === "radio") {
        candidate = element.checked ? null : { action: "click", id: element.id, rationale: `Selected ${value} for ${field.label}.` };
      } else if (field.kind === "select") {
        candidate = { action: "select", id: element.id, value: selectedValue };
      } else {
        candidate = { action: "type", id: element.id, text: value };
      }

      let response: { ok: boolean; error?: string; freshSnapshot?: PageSnapshot } | null = null;
      if (candidate) {
        const validation = validatePlannerAction(candidate);
        if (!validation.valid) throw new Error(validation.error);
        const safety = inspectActionSafety(validation.action, freshSnapshot, resolveSpeechLanguage(settings.languageCode, taskGoalRef.current || transcript));
        if (!safety.permitted) throw new Error(safety.reason || "Safety blocked this field.");
        if (safety.requiresConfirmation) {
          session.skippedManualCount += 1;
          const leftMsg = translate(
            "I left %s unchanged because it needs a separate confirmation. I will continue to the next field.",
            "मैंने %s को नहीं बदला क्योंकि इसके लिए अलग से पुष्टि चाहिए। मैं अगले फ़ील्ड पर आगे बढ़ रहा हूँ।"
          ).replace("%s", field.label);
          await speakStatus(leftMsg);
        } else {
          response = await sendTabMessage<{ ok: boolean; error?: string; freshSnapshot?: PageSnapshot }>(session.tabId, {
            type: "BV_EXECUTE_ACTION",
            action: validation.action,
          });
          if (!response?.ok) throw new Error(response?.error || `Could not fill ${field.label}.`);

          const stepNumber = stepsRef.current.length + 1;
          const fieldOutcome = localizedActionSpeech(validation.action, freshSnapshot, resolveSpeechLanguage(settings.languageCode, taskGoalRef.current || transcript));
          setSteps((previous) => [...previous, {
            stepNumber,
            action: validation.action,
            status: "success",
            spokenSummary: fieldOutcome,
            timestamp: Date.now(),
          }]);
          await speakStatus(fieldOutcome);
        }
      }
      session.completed.add(field.fingerprint);

      const updatedSnapshot = (response?.freshSnapshot || await fetchPageSnapshot(session.tabId)) as PageSnapshot;
      const refreshed = collectFormFields(updatedSnapshot);
      session.skippedManualCount = Math.max(session.skippedManualCount, refreshed.manualFields.length);
      session.fields = refreshed.fields.filter((candidateField) => !session.completed.has(candidateField.fingerprint));
      session.index = 0;

      if (session.fields.length === 0) {
        const skippedMessage = session.skippedManualCount > 0
          ? translate(
              "The supported fields are filled. Fill any sensitive, file, or protected fields yourself, then review the form. I did not submit it.",
              "समर्थित फ़ील्ड भर दिए गए हैं। संवेदनशील, फ़ाइल या सुरक्षित फ़ील्ड स्वयं भरें, फिर फ़ॉर्म की समीक्षा करें। मैंने इसे सबमिट नहीं किया है।"
            )
          : translate(
              "The visible fields are filled. Please review the form. I did not submit it.",
              "दिखाई देने वाले फ़ील्ड भर दिए गए हैं। कृपया फ़ॉर्म की समीक्षा करें। मैंने इसे सबमिट नहीं किया है।"
            );
        formFillRef.current = null;
        taskGoalRef.current = null;
        conversationRef.current = [];
        awaitingUserReplyRef.current = false;
        await speakStatus(skippedMessage);
        setStatus("idle");
        setStatusText(translate("Form filled. Review before submitting.", "फॉर्म भर दिया गया है। सबमिट करने से पहले जांचें।"));
      } else {
        await askNextFormField();
      }
    } catch (error) {
      setStatus("idle");
      setStatusText(error instanceof Error ? error.message : translate("I could not fill that field.", "मैं यह फील्ड नहीं भर सका।"));
    }
    return true;
  };

  const handleUserRequest = async (text: string) => {
    if (formFillRef.current && await submitFormFieldAnswer(text)) return;
    if (siteChatRef.current.status === "ready" && siteChatRef.current.siteId) {
      await answerFromSite(text);
      return;
    }
    await runAgentLoop(text);
  };

  const handleUserRequestSafely = async (text: string) => {
    const requestKey = text.trim().toLocaleLowerCase().replace(/\s+/g, " ");
    if (!requestKey || queuedRequestKeysRef.current.has(requestKey)) return;
    queuedRequestKeysRef.current.add(requestKey);
    const generation = requestQueueGenerationRef.current;
    const queuedRun = requestQueueRef.current.then(async () => {
      if (generation !== requestQueueGenerationRef.current) {
        queuedRequestKeysRef.current.delete(requestKey);
        return;
      }
      try {
        await handleUserRequest(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Browse Voice could not complete that request.";
        setStatus("idle");
        setStatusText(message);
      } finally {
        queuedRequestKeysRef.current.delete(requestKey);
      }
    });
    requestQueueRef.current = queuedRun.catch(() => {
      queuedRequestKeysRef.current.delete(requestKey);
    });
    await queuedRun;
  };

  /**
   * Checks whether the current tab URL is a restricted Chrome-internal page
   * where content scripts cannot be injected.
   */
  const isRestrictedPage = (url: string | undefined): boolean => {
    if (!url) return true;
    return (
      !/^https?:\/\//i.test(url) ||
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

    // Unknown site names are intentionally left to the planner; never invent a
    // navigation target from untrusted speech.
    return null;
  };

  const selectArea = async () => {
    if (!activeTabId) {
      alert("No active browser tab found.");
      return;
    }

    setStatus("thinking");
    setStatusText(translate("Select an area on the page...", "पेज पर क्षेत्र चुनें..."));

    try {
      let selectionResponse: { ok?: boolean; selection?: { rect: { x: number; y: number; width: number; height: number }; viewportWidth: number; text: string; elements: string[]; title: string; url: string }; error?: string };
      selectionResponse = await sendTabMessage<{ ok?: boolean; selection?: { rect: { x: number; y: number; width: number; height: number }; viewportWidth: number; text: string; elements: string[]; title: string; url: string }; error?: string }>(activeTabId, { type: "BV_START_SNIP_SELECTION" });

      if (!selectionResponse?.ok || !selectionResponse.selection) {
        if (selectionResponse?.error === "Selection cancelled.") {
          setStatus("idle");
          setStatusText(translate("Ready", "तैयार"));
          return;
        }
        throw new Error(selectionResponse?.error || "Selection could not be completed.");
      }

      const capture = await chrome.runtime.sendMessage({
        type: "BV_CAPTURE_VISIBLE_TAB",
        windowId: (await chrome.tabs.get(activeTabId)).windowId,
      });
      if (!capture?.ok || !capture.dataUrl) throw new Error(capture?.error || "Could not capture the selected page.");

      const croppedImage = await cropCapturedImage(capture.dataUrl, selectionResponse.selection.rect, selectionResponse.selection.viewportWidth);
      const newSnip: SnipContext = {
        id: `snip-${Date.now()}`,
        imageDataUrl: croppedImage,
        text: selectionResponse.selection.text,
        elements: selectionResponse.selection.elements,
        title: selectionResponse.selection.title,
        url: selectionResponse.selection.url,
      };
      setSnips((previous) => [...previous, newSnip].slice(-4));
      setStatus("idle");
      setStatusText(translate("Selected area added", "चयनित क्षेत्र जोड़ दिया गया है"));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Selection failed.";
      if (message !== "Selection cancelled." && message !== "Selection was too small.") {
        setStatusText(message);
        alert(message);
      } else {
        setStatus("idle");
        setStatusText(translate("Ready", "तैयार"));
      }
    }
  };

  const siteChatConfig = () => ({
    endpoint: settings.siteChatEndpoint,
    apiKey: settings.siteChatApiKey,
    maxPages: settings.siteChatMaxPages,
  });

  const updateSiteIndexProgress = (progress: SiteIndexProgress) => {
    setSiteChat((previous) => ({
      ...previous,
      status: progress.status,
      siteId: progress.siteId || previous.siteId,
      jobId: progress.jobId || previous.jobId,
      pagesIndexed: progress.pagesIndexed ?? previous.pagesIndexed,
      totalPages: progress.totalPages ?? previous.totalPages,
      message: progress.error || progress.message || previous.message,
    }));
  };

  const pollSiteIndex = async (jobId: string, knownSiteId = "", runId = siteChatRunRef.current): Promise<void> => {
    if (runId !== siteChatRunRef.current) return;
    try {
      const progress = await getSiteIndexProgress(siteChatConfig(), jobId);
      if (runId !== siteChatRunRef.current) return;
      updateSiteIndexProgress(progress);

      if (progress.status === "ready") {
        if (!progress.siteId && !knownSiteId && !siteChatRef.current.siteId) {
          setSiteChat((previous) => ({ ...previous, status: "failed", message: "Indexing finished without a site ID." }));
          setStatus("idle");
          setStatusText(translate("Site index is incomplete", "साइट इंडेक्स अधूरा है"));
          return;
        }
        setStatus("idle");
        setStatusText(translate("Site ready", "साइट तैयार है"));
        return;
      }
      if (progress.status === "failed") {
        setStatus("idle");
        setStatusText(progress.error || progress.message || translate("Site indexing failed", "साइट इंडेक्सिंग विफल रही"));
        return;
      }

      setStatus("executing");
      setStatusText(`${translate("Indexing site...", "साइट इंडेक्स हो रही है...")} ${progress.pagesIndexed || 0}${progress.totalPages ? `/${progress.totalPages}` : ""} ${translate("pages", "पेज")}`);
      siteIndexPollRef.current = setTimeout(() => {
        void pollSiteIndex(jobId, knownSiteId || progress.siteId || siteChatRef.current.siteId, runId);
      }, 1200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not check site indexing progress.";
      setSiteChat((previous) => ({ ...previous, status: "failed", message }));
      setStatus("idle");
      setStatusText(translate("Site indexing failed", "साइट इंडेक्सिंग विफल रही"));
    }
  };

  const startSiteChat = async () => {
    if (!activeTabUrl || isRestrictedPage(activeTabUrl)) {
      setStatus("idle");
      setStatusText(translate("Open a normal website first", "पहले सामान्य वेबसाइट खोलें"));
      return;
    }
    if (!settings.siteChatEndpoint.trim()) {
      setStatus("idle");
      setStatusText(translate("Add the Site knowledge API endpoint in Settings", "सेटिंग्स में साइट नॉलेज API endpoint जोड़ें"));
      setSettingsOpen(true);
      return;
    }
    if (siteChatRef.current.status === "queued" || siteChatRef.current.status === "crawling" || siteChatRef.current.status === "processing") return;

    if (siteIndexPollRef.current) clearTimeout(siteIndexPollRef.current);
    resetSiteSafety();
    const runId = ++siteChatRunRef.current;
    siteChatTabRef.current = activeTabId;
    setSnips([]);
    setSiteChatMessages([]);
    setSiteChat({
      status: "queued",
      startUrl: activeTabUrl,
      siteId: "",
      jobId: "",
      pagesIndexed: 0,
      message: "Starting crawler...",
    });
    setStatus("executing");
    setStatusText(translate("Starting site crawler...", "साइट क्रॉलर शुरू हो रहा है..."));

    try {
      const started = await startSiteIndexing(siteChatConfig(), activeTabUrl);
      setSiteChat((previous) => ({
        ...previous,
        status: started.status,
        siteId: started.siteId || "",
        jobId: started.jobId,
        pagesIndexed: started.pagesIndexed || 0,
        totalPages: started.totalPages,
        message: started.message || "Crawler is building the site knowledge base.",
      }));
      if (started.status === "ready" && started.siteId) {
        setStatus("idle");
        setStatusText(translate("Site ready", "साइट तैयार है"));
      } else {
        await pollSiteIndex(started.jobId, started.siteId || "", runId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start site indexing.";
      setSiteChat((previous) => ({ ...previous, status: "failed", message }));
      setStatus("idle");
      setStatusText(translate("Could not start site chat", "साइट चैट शुरू नहीं हो सकी"));
    }
  };

  const checkCurrentSiteSafety = async () => {
    if (!activeTabUrl || isRestrictedPage(activeTabUrl)) {
      setStatus("idle");
      setStatusText(translate("Open a normal website first", "पहले सामान्य वेबसाइट खोलें"));
      return;
    }
    if (!settings.siteChatEndpoint.trim()) {
      setStatus("idle");
      setStatusText(translate("Add the Site knowledge API endpoint in Settings", "सेटिंग्स में साइट नॉलेज API endpoint जोड़ें"));
      setSettingsOpen(true);
      return;
    }
    const runId = ++siteSafetyRunRef.current;
    setSiteSafetyLoading(true);
    setStatus("thinking");
    setStatusText(translate("Checking site safety...", "साइट सुरक्षा जांच रहे हैं..."));
    try {
      const result = await requestSiteSafety({ endpoint: settings.siteChatEndpoint, apiKey: settings.siteChatApiKey }, activeTabUrl);
      if (runId !== siteSafetyRunRef.current) return;
      setSiteSafety(result);
      setStatus("idle");
      setStatusText(translate("Safety check complete", "सुरक्षा जांच पूरी हुई"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not check site safety.";
      setStatus("idle");
      setStatusText(message);
    } finally {
      if (runId === siteSafetyRunRef.current) setSiteSafetyLoading(false);
    }
  };

  const clearSiteChat = () => {
    resetSiteChatSession();
    setStatusText(translate("Ready", "तैयार"));
  };

  const answerFromSite = async (question: string) => {
    const currentSite = siteChatRef.current;
    if (currentSite.status !== "ready" || !currentSite.siteId) return;
    const userMessage: ChatMessage = { id: `site-user-${Date.now()}`, role: "user", text: question };
    const history: SiteChatHistoryEntry[] = siteChatMessages.slice(-8).map((message) => ({
      role: message.role,
      content: message.text,
    }));
    setSiteChatMessages((previous) => [...previous, userMessage]);
    setStatus("thinking");
    setStatusText(translate("Searching site knowledge...", "साइट नॉलेज खोज रहे हैं..."));
    try {
      const response = await askSiteQuestion(siteChatConfig(), currentSite.siteId, question, history);
      const sourceText = response.sources?.length
        ? `\n\nSources: ${response.sources.slice(0, 3).map((source) => source.title || source.url).filter(Boolean).join(" • ")}`
        : "";
      const answer = `${response.answer}${sourceText}`;
      setSiteChatMessages((previous) => [...previous, { id: `site-assistant-${Date.now()}`, role: "assistant", text: answer }]);
      setStatus("idle");
      setStatusText(translate("Answer ready", "जवाब तैयार है"));
      await speakStatus(response.answer.slice(0, 500));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not answer from this site.";
      setSiteChatMessages((previous) => [...previous, { id: `site-assistant-${Date.now()}`, role: "assistant", text: message }]);
      setStatus("idle");
      setStatusText(translate("Could not answer", "जवाब नहीं मिल सका"));
    }
  };

  const answerFromSnips = async (question: string) => {
    if (snips.length === 0) return;
    const userMessage: ChatMessage = { id: `user-${Date.now()}`, role: "user", text: question };
    const conversation = chatMessages.slice(-8).map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`).join("\n");
    setChatMessages((previous) => [...previous, userMessage]);
    setStatus("thinking");
    setStatusText(translate("Reading selected area...", "चयनित क्षेत्र पढ़ रहे हैं..."));
    try {
      const answer = await answerAboutSnips(
        {
          provider: settings.llmProvider,
          apiKey: settings.llmApiKey,
          endpoint: settings.llmEndpoint,
          model: settings.llmModel,
        },
        conversation ? `Conversation so far:\n${conversation}\nCurrent question: ${question}` : question,
        snips,
      );
      setChatMessages((previous) => [...previous, { id: `assistant-${Date.now()}`, role: "assistant", text: answer.text }]);
      setStatus("idle");
      setStatusText(translate("Answer ready", "जवाब तैयार है"));
      await speakStatus(answer.text.slice(0, 500));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not answer from the selected area.";
      setChatMessages((previous) => [...previous, { id: `assistant-${Date.now()}`, role: "assistant", text: message }]);
      setStatus("idle");
      setStatusText(translate("Could not answer", "जवाब नहीं मिल सका"));
    }
  };

  const waitForTabLoad = async (tabId: number, timeoutMs = 15_000): Promise<chrome.tabs.Tab> => {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, loadedTab?: chrome.tabs.Tab) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        if (error) reject(error); else resolve(loadedTab || tab);
      };
      const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, updatedTab: chrome.tabs.Tab) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") finish(undefined, updatedTab);
      };
      const onRemoved = (removedTabId: number) => {
        if (removedTabId === tabId) finish(new Error("The controlled tab was closed."));
      };
      const timer = setTimeout(() => finish(new Error("Timed out waiting for the tab to load.")), timeoutMs);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
    });
  };

  const decomposeWithRetry = async (request: string): Promise<SubTask[]> => {
    const config = { provider: settings.llmProvider, apiKey: settings.llmApiKey, endpoint: settings.llmEndpoint, model: settings.llmModel } as const;
    decompositionNoticeRef.current = null;
    const useSingleTaskFallback = () => {
      decompositionNoticeRef.current = translate("I couldn't split that command, so I will run it as one task.", "मैं इस कमांड को अलग नहीं कर पाया, इसलिए इसे एक काम की तरह चला रहा हूँ।");
      return fallbackToSingleTask(request);
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await decomposeRequest(config, request);
      } catch (error) {
        if (!isPlannerRateLimitError(error)) return useSingleTaskFallback();
        if (attempt >= 2) return useSingleTaskFallback();
        const retryAfterMs = Math.max(250, getPlannerRetryAfterMs(error) ?? 500 * (2 ** attempt));
        setStatusText(`${translate("Rate limited, retrying", "रेट लिमिट है, फिर कोशिश कर रहे हैं")} (${attempt + 1}/2)`);
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      }
    }
    return useSingleTaskFallback();
  };

  const maybeSpeakCombinedSummary = async () => {
    if (summarySpokenGenerationRef.current === taskRunGenerationRef.current || activeTaskIdsRef.current.length === 0) return;
    const cards = activeTaskIdsRef.current.map((id) => taskViewsRef.current.get(id)).filter(Boolean) as TaskCardState[];
    if (cards.length !== activeTaskIdsRef.current.length || cards.some((card) => ["queued", "running", "waiting_confirmation"].includes(card.status))) return;
    summarySpokenGenerationRef.current = taskRunGenerationRef.current;
    const completed = cards.filter((card) => card.status === "done").map((card) => `${card.label}: ${card.summary || "completed"}`);
    const failed = cards.filter((card) => card.status !== "done").map((card) => `${card.label}: ${card.error || card.currentStep || "not completed"}`);
    const summary = [...completed, ...failed].join(". ");
    if (settings.focusCompletedTab) {
      const firstCompleted = cards.find((card) => card.status === "done" && card.tabId !== null);
      if (firstCompleted?.tabId !== null && firstCompleted?.tabId !== undefined) {
        await chrome.tabs.update(firstCompleted.tabId, { active: true });
      }
    }
    if (summary) await speakStatus(summary);
    setStatus("idle");
    setStatusText(translate("All tasks finished", "सभी काम पूरे हो गए"));
  };

  const runTaskForCard = async (task: SubTask, tabId: number): Promise<TaskRunnerResult> => {
    const planner = createPlanner({ provider: settings.llmProvider, apiKey: settings.llmApiKey, endpoint: settings.llmEndpoint, model: settings.llmModel });
    const context = createTaskRunnerContext({
      tabId,
      goal: task.goal,
      planner,
      languageCode: resolveSpeechLanguage(settings.languageCode, task.goal),
      sendTabMessage,
      callbacks: {
        onStatus: (taskStatus, text) => {
          publishTaskCard(task.id, { status: taskStatus, currentStep: text, ...(taskStatus === "done" ? { summary: text } : {}) });
          if (taskStatus === "waiting_confirmation") enqueueConfirmation(task.id);
        },
        onStep: (entry) => {
          const current = taskViewsRef.current.get(task.id);
          publishTaskCard(task.id, { steps: [...(current?.steps || []), entry], currentStep: entry.spokenSummary || entry.action.action });
          if (task.id === activeTaskIdsRef.current[0]) {
            stepsRef.current = [...(current?.steps || []), entry];
            setSteps(stepsRef.current);
          }
        },
        onPrompt: async (text, kind) => {
          if (kind === "confirmation" || kind === "blocked") await speakStatus(text);
        },
        onRateLimited: (attempt) => publishTaskCard(task.id, { currentStep: `${translate("Rate limited, retrying", "रेट लिमिट है, फिर कोशिश कर रहे हैं")} (${attempt}/2)` }),
      },
    });
    taskContextsRef.current.set(task.id, context);
    const formFillIntent = /\b(fill|complete|populate|enter details|register|sign up|apply for|bhar(?:o|na|do|de))\b|फॉर्म|फ़ॉर्म|भर(?:ो|ना|ें)/i.test(task.goal);
    if (activeTaskIdsRef.current.length === 1 && formFillIntent && !formFillRef.current) {
      try {
        const snapshot = await fetchPageSnapshot(tabId);
        const { fields, manualFields } = collectFormFields(snapshot);
        if (manualFields.length > 0) await sendTabMessage(tabId, { type: "BV_HIGHLIGHT_MANUAL_FIELDS", fields: manualFields });
        if (fields.length > 0) {
          formFillRef.current = { tabId, goal: task.goal, fields, index: 0, completed: new Set(), skippedManualCount: manualFields.length };
          publishTaskCard(task.id, { status: "waiting_confirmation", currentStep: translate("Waiting for form details", "फ़ॉर्म विवरण की प्रतीक्षा") });
          if (manualFields.length > 0) await speakStatus(translate("I will leave sensitive and file fields for you to handle manually.", "संवेदनशील और फ़ाइल फ़ील्ड को आपके लिए छोड़ दिया गया है ताकि आप उन्हें स्वयं भर सकें।"));
          await askNextFormField();
          return { status: "waiting_confirmation", context };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : translate("Could not inspect the form.", "फ़ॉर्म का निरीक्षण नहीं किया जा सका।");
        publishTaskCard(task.id, { status: "failed", error: message, currentStep: message });
        return { status: "failed", error: message, context };
      }
    }
    const result = await runAgentTask(context);
    if (result.status === "waiting_confirmation") {
      publishTaskCard(task.id, { status: "waiting_confirmation", confirmationMessage: context.pendingConfirmation?.message || context.pendingQuestion || translate("Waiting for your response", "आपके जवाब की प्रतीक्षा है") });
    } else {
      publishTaskCard(task.id, { status: result.status, summary: result.summary, error: result.error });
    }
    await maybeSpeakCombinedSummary();
    return result;
  };

  const runTasksWithLimit = async (tasks: Array<{ task: SubTask; tabId: number }>) => {
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < tasks.length) {
        if (isStoppedRef.current) return;
        const index = nextIndex++;
        const item = tasks[index];
        await runTaskForCard(item.task, item.tabId);
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(settings.taskConcurrency, tasks.length) }, () => worker()));
  };

  // Keep the multi-tab orchestration separate from the legacy single-tab loop
  // below. This lets existing form-follow-up behavior remain available while
  // all new commands use isolated task runners.
  const runParallelTask = async (initialRequest: string, resumeExistingTask = false) => {
    if (!resumeExistingTask && snips.length > 0) {
      await answerFromSnips(initialRequest);
      return;
    }
    if (!activeTabId) {
      alert("No active browser tab found.");
      return;
    }

    isStoppedRef.current = false;
    if (!resumeExistingTask) {
      formFillRef.current = null;
      taskGoalRef.current = null;
      conversationRef.current = [];
      awaitingUserReplyRef.current = false;
    }
    const tasks = await decomposeWithRetry(initialRequest);
    if (isStoppedRef.current) return;
    const generation = ++taskRunGenerationRef.current;
    summarySpokenGenerationRef.current = 0;
    taskViewsRef.current.clear();
    taskContextsRef.current.clear();
    confirmationQueueRef.current = [];
    setActiveConfirmationTaskId(null);
    setPendingConfirmationAction(null);
    setConfirmationMessage("");
    activeTaskIdsRef.current = tasks.map((task) => task.id);
    const queuedTasks = tasks.map((task) => ({ id: task.id, label: task.label, tabId: null, tabTitle: "", status: "queued" as const, currentStep: translate("Queued", "कतार में"), steps: [] }));
    setTaskCards(queuedTasks);
    taskViewsRef.current = new Map(queuedTasks.map((task) => [task.id, task]));
    setSteps([]);
    setStatus("thinking");
    setStatusText(decompositionNoticeRef.current || (tasks.length > 1 ? translate("Opening task tabs...", "काम के टैब खोल रहे हैं...") : translate("Analyzing page...", "पेज का विश्लेषण हो रहा है...")));

    const tabAssignments: Array<{ task: SubTask; tabId: number }> = [];
    try {
      if (tasks.length === 1) {
        const task = tasks[0];
        const tabInfo = await chrome.tabs.get(activeTabId);
        const tabId = activeTabId;
        if (task.startUrl && (isRestrictedPage(tabInfo.url) || /\b(?:open|go|navigate|visit|kholo|खोलो)\b/i.test(initialRequest))) {
          await chrome.tabs.update(tabId, { url: task.startUrl });
          await waitForTabLoad(tabId);
        } else if (isRestrictedPage(tabInfo.url)) {
          const directUrl = resolveDirectNavigationIntent(initialRequest);
          if (!directUrl) throw new Error("Please open a normal webpage before starting this task.");
          await chrome.tabs.update(tabId, { url: directUrl });
          await waitForTabLoad(tabId);
        }
        tabAssignments.push({ task, tabId });
      } else {
        for (const task of tasks) {
          const tab = await chrome.tabs.create({ url: task.startUrl || "https://www.google.com", active: false });
          if (!tab.id) throw new Error(`Could not create a tab for ${task.label}.`);
          await waitForTabLoad(tab.id);
          const connected = await chrome.runtime.sendMessage({ type: "BV_ENSURE_TAB_CONNECTED", tabId: tab.id });
          if (!connected?.ok) throw new Error(`Could not connect Browse Voice to the ${task.label} tab.`);
          tabAssignments.push({ task, tabId: tab.id });
          publishTaskCard(task.id, { tabId: tab.id, tabTitle: tab.title || task.label, faviconUrl: tab.favIconUrl });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not prepare task tabs.";
      setStatus("idle");
      setStatusText(message);
      for (const task of tasks.filter((item) => !tabAssignments.some((assigned) => assigned.task.id === item.id))) publishTaskCard(task.id, { status: "failed", error: message, currentStep: message });
      return;
    }

    if (generation !== taskRunGenerationRef.current) return;
    for (const assignment of tabAssignments) {
      const tab = await chrome.tabs.get(assignment.tabId);
      publishTaskCard(assignment.task.id, { tabId: assignment.tabId, tabTitle: tab.title || assignment.task.label, faviconUrl: tab.favIconUrl });
    }
    await runTasksWithLimit(tabAssignments);
    await maybeSpeakCombinedSummary();
  };

  const startTaskRun = async (initialRequest: string, resumeExistingTask = false) => {
    return runParallelTask(initialRequest, resumeExistingTask);
    /* Legacy single-tab loop retained below for reference during the merge.
    if (!resumeExistingTask && snips.length > 0) {
      await answerFromSnips(initialRequest);
      return;
    }
    if (!activeTabId) {
      alert("No active browser tab found.");
      return;
    }

    isStoppedRef.current = false;
    if (!resumeExistingTask) setSteps([]);
    setStatus("thinking");
    setStatusText(translate("Analyzing page...", "पेज का विश्लेषण हो रहा है..."));

    // A reply to ask_user continues the original task. New commands start a clean context.
    const isFollowUp = (resumeExistingTask || awaitingUserReplyRef.current) && taskGoalRef.current !== null;
    if (!isFollowUp) {
      taskGoalRef.current = initialRequest;
      conversationRef.current = [{ role: "user" as const, content: initialRequest }];
    } else if (!resumeExistingTask) {
      conversationRef.current = [...conversationRef.current, { role: "user" as const, content: initialRequest }].slice(-6);
    }
    const taskGoal = taskGoalRef.current || initialRequest;
    awaitingUserReplyRef.current = false;

    // --- Check if we're on a restricted page (chrome://, new tab, etc.) ---
    const tabInfo = await chrome.tabs.get(activeTabId);
    if (isRestrictedPage(tabInfo.url)) {
      // Try to resolve navigation intent directly (no LLM needed)
      const directUrl = resolveDirectNavigationIntent(initialRequest);
      if (directUrl) {
        setStatus("executing");
        setStatusText(`${translate("Opening", "खोल रहे हैं")} ${directUrl}...`);
        const navAction: PlannerAction = {
          action: "navigate",
          url: directUrl,
          rationale: ACTION_SPEECH[resolveSpeechLanguage(settings.languageCode, initialRequest)]?.opened || ACTION_SPEECH["en-IN"].opened,
        };
        setSteps([{
          stepNumber: 1,
          action: navAction,
          status: "success",
          spokenSummary: navAction.rationale,
          timestamp: Date.now(),
        }]);
        await chrome.tabs.update(activeTabId, { url: directUrl });
        await speakStatus(navAction.rationale || "Opened the requested page.");
        setStatus("idle");
        setStatusText(translate("Navigated", "पेज खुल गया है"));
        return;
      }
      // Can't do anything else on restricted pages
      setStatus("idle");
      setStatusText(translate("⚠️ Please go to a normal webpage first", "⚠️ पहले सामान्य वेबपेज खोलें"));
      alert(
        "Browse Voice cannot control Chrome's built-in pages (new tab, chrome://settings, etc.).\n\n" +
        "Please navigate to any website (e.g. google.com) and then give your command."
      );
      return;
    }

    // 1. Activate on-page visual indicator
    await sendTabMessage(activeTabId, {
      type: "BV_ACTIVATE_AGENT",
      statusText: "Processing",
    });

    const planner: PlannerProvider = createPlanner({
      provider: settings.llmProvider,
      apiKey: settings.llmApiKey,
      endpoint: settings.llmEndpoint,
      model: settings.llmModel,
    });

    let currentSnapshot = await fetchPageSnapshot(activeTabId);
    const formFillIntent = /\b(fill|complete|populate|enter details|register|sign up|apply for|bhar(?:o|na|do|de))\b|फॉर्म|फ़ॉर्म|भर(?:ो|ना|ें)/i.test(taskGoal);
    if (!formFillRef.current && formFillIntent) {
      const { fields, manualFields } = collectFormFields(currentSnapshot);
      if (manualFields.length > 0) {
        await sendTabMessage(activeTabId, { type: "BV_HIGHLIGHT_MANUAL_FIELDS", fields: manualFields });
      }
      if (fields.length > 0) {
        formFillRef.current = {
          tabId: activeTabId,
          goal: taskGoal,
          fields,
          index: 0,
          completed: new Set(),
          skippedManualCount: manualFields.length,
        };
        if (manualFields.length > 0) {
          await speakStatus("I will leave sensitive and file fields for you to handle manually. I will ask about every other visible field one at a time.");
        }
        await askNextFormField();
        return;
      }
    }

    let stepCount = resumeExistingTask ? stepsRef.current.length : 0;
    const MAX_STEPS = 15;
    let refreshedAfterStaleElement = false;
    let lastSuccessfulRepeatableAction: string | null = null;
    let lastSkippedRepeatedAction: string | null = null;

    while (stepCount < MAX_STEPS) {
      if (isStoppedRef.current) break;
      stepCount++;

      setStatus("thinking");
        setStatusText(`${translate("Step", "स्टेप")} ${stepCount}: ${translate("Planning next action...", "अगली कार्रवाई की योजना बन रही है...")}`);

      // 2. Query Planner
      let action: PlannerAction;
      try {
        action = await planner.plan({
          userRequest: taskGoal,
          languageCode: resolveSpeechLanguage(settings.languageCode, taskGoal),
          snapshot: currentSnapshot,
          history: stepsRef.current.slice(-5),
          conversation: conversationRef.current,
        });
      } catch (planErr) {
        const errMsg = planErr instanceof Error ? planErr.message : "Planning error.";
        await speakStatus(`योजना बनाने में त्रुटि: ${errMsg}`);
        if (isFollowUp) awaitingUserReplyRef.current = true;
        break;
      }

      if (isStoppedRef.current) break;

      // A model may confuse opening the payment page with finishing payment.
      // Never accept that completion unless the visible snapshot contains a receipt.
      if (action.action === "done" && isPaymentIntent(taskGoal) && !hasPaymentReceipt(currentSnapshot.summary)) {
        const continueToPayment = currentSnapshot.interactiveElements.find((element) =>
          (element.tag === "button" || element.role === "button") &&
          /continue.{0,30}payment|proceed.{0,20}pay|भुगतान.{0,20}(?:आगे|जारी)/i.test(element.label),
        );

        if (continueToPayment && !hasVisiblePaymentForm(currentSnapshot)) {
          action = {
            action: "click",
            id: continueToPayment.id,
            rationale: "Opening the payment page; payment is not complete yet.",
          };
        } else {
          action = {
            action: "ask_user",
            question: hasVisiblePaymentForm(currentSnapshot)
              ? "भुगतान फ़ॉर्म खुला है। कार्ड, UPI या अन्य गोपनीय जानकारी आप स्वयं भरें। भुगतान करना हो तो राशि जाँचकर पुष्टि करें।"
              : "अभी भुगतान की रसीद दिखाई नहीं दे रही है, इसलिए मैं भुगतान पूरा होने की पुष्टि नहीं कर सकता। क्या आप चाहेंगे कि मैं अगला कदम जारी रखूँ?",
            rationale: "भुगतान की पुष्टि के लिए रसीद दिखाई देनी चाहिए।",
          };
        }
      }

      const repeatableActionKey = getRepeatableActionKey(action);
      if (repeatableActionKey && repeatableActionKey === lastSuccessfulRepeatableAction) {
        const duplicateNotice = ({
          "hi-IN": "यह कार्रवाई पहले ही पूरी हो चुकी है। मैं इसे दोबारा नहीं करूँगा।",
          "ta-IN": "இந்தச் செயலை ஏற்கனவே செய்துவிட்டேன். மீண்டும் செய்யமாட்டேன்.",
          "te-IN": "ఈ చర్య ఇప్పటికే పూర్తయింది. దీన్ని మళ్లీ చేయను.",
          "kn-IN": "ಈ ಕ್ರಿಯೆಯನ್ನು ಈಗಾಗಲೇ ಮಾಡಿದ್ದೇನೆ. ಮತ್ತೆ ಮಾಡುವುದಿಲ್ಲ.",
          "mr-IN": "ही कृती आधीच पूर्ण झाली आहे. मी ती पुन्हा करणार नाही.",
          "gu-IN": "આ ક્રિયા પહેલેથી થઈ ગઈ છે. હું તેને ફરીથી નહીં કરું.",
          "bn-IN": "এই কাজটি আগেই করা হয়েছে। আমি এটি আবার করব না।",
          "pa-IN": "ਇਹ ਕਾਰਵਾਈ ਪਹਿਲਾਂ ਹੀ ਹੋ ਚੁੱਕੀ ਹੈ। ਮੈਂ ਇਸਨੂੰ ਦੁਬਾਰਾ ਨਹੀਂ ਕਰਾਂਗਾ।",
          "ml-IN": "ഈ പ്രവർത്തനം ഇതിനകം പൂർത്തിയായി. ഇത് വീണ്ടും ചെയ്യില്ല.",
        } as Record<string, string>)[resolveSpeechLanguage(settings.languageCode, taskGoal)] || "That action is already complete. I will not repeat it.";
        if (repeatableActionKey === lastSkippedRepeatedAction) {
          await speakStatus(duplicateNotice);
          break;
        }
        lastSkippedRepeatedAction = repeatableActionKey;
        conversationRef.current = [...conversationRef.current, { role: "assistant" as const, content: duplicateNotice }].slice(-6);
        await speakStatus(duplicateNotice);
        currentSnapshot = await fetchPageSnapshot(activeTabId);
        continue;
      }

      // 3. Inspect Action Safety
      const safety = inspectActionSafety(action, currentSnapshot);

      // SENSITIVE FIELD BLOCKED
      if (!safety.permitted) {
        const speech = safety.safetyAlertSpeech || "This field contains sensitive information. Please fill it manually.";
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
        const confirmSpeech = safety.safetyAlertSpeech || "Do you want to confirm this action? Say yes to continue.";
        setStatusText(translate("Waiting for confirmation", "पुष्टि की प्रतीक्षा है"));
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
        conversationRef.current = [...conversationRef.current, { role: "assistant" as const, content: action.summary }].slice(-6);
        await speakStatus(action.summary);
        setStatus("idle");
        setStatusText(translate("Completed", "पूरा हुआ"));
        taskGoalRef.current = null;
        conversationRef.current = [];
        awaitingUserReplyRef.current = false;
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
        conversationRef.current = [...conversationRef.current, { role: "assistant" as const, content: action.question }].slice(-6);
        awaitingUserReplyRef.current = true;
        await speakStatus(action.question);
        setStatus("idle");
        setStatusText(translate("Awaiting response", "जवाब की प्रतीक्षा है"));
        break;
      }

      // 4. Execute Action in Tab
      setStatus("executing");
      setStatusText(`${translate("Step", "स्टेप")} ${stepCount}: ${translate("Executing", "कार्रवाई हो रही है")} ${action.action}...`);

      const execResponse = await sendTabMessage<{ ok?: boolean; error?: string; freshSnapshot?: PageSnapshot }>(activeTabId, {
        type: "BV_EXECUTE_ACTION",
        action,
      });

      if (!execResponse?.ok) {
        const err = execResponse?.error || "Action execution failed.";
        if (/element id \[\d+\] was not found in the current page/i.test(err) && !refreshedAfterStaleElement) {
          refreshedAfterStaleElement = true;
          setStatus("thinking");
          setStatusText(translate("Page changed; refreshing before retrying...", "पेज बदल गया है; दोबारा कोशिश करने से पहले रीफ़्रेश कर रहे हैं..."));
          try {
            currentSnapshot = await fetchPageSnapshot(activeTabId);
            stepCount -= 1;
            continue;
          } catch {
            // Fall through and report the original action failure if the page cannot be refreshed.
          }
        }
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
          const failurePrefix = ({
            "hi-IN": "कार्रवाई पूरी नहीं हुई:", "ta-IN": "செயல் தோல்வியடைந்தது:", "te-IN": "చర్య విఫలమైంది:",
            "kn-IN": "ಕ್ರಿಯೆ ವಿಫಲವಾಗಿದೆ:", "mr-IN": "कृती अयशस्वी झाली:", "gu-IN": "ક્રિયા નિષ્ફળ ગઈ:",
            "bn-IN": "কাজটি ব্যর্থ হয়েছে:", "pa-IN": "ਕਾਰਵਾਈ ਅਸਫਲ ਰਹੀ:", "ml-IN": "പ്രവർത്തനം പരാജയപ്പെട്ടു:",
          } as Record<string, string>)[resolveSpeechLanguage(settings.languageCode, taskGoal)] || "Action failed:";
          await speakStatus(`${failurePrefix} ${err}`);
        break;
      }

      lastSuccessfulRepeatableAction = repeatableActionKey;
      lastSkippedRepeatedAction = null;

      // Record successful step
      const outcomeSpeech = getActionOutcomeSpeech(action, currentSnapshot);
      conversationRef.current = [...conversationRef.current, { role: "assistant" as const, content: outcomeSpeech }].slice(-6);
      setSteps((prev) => [
        ...prev,
        {
          stepNumber: stepCount,
          action,
          status: "success",
          spokenSummary: outcomeSpeech,
          timestamp: Date.now(),
        },
      ]);

      // Speak the result after the page action has completed.
      await speakStatus(outcomeSpeech);

      // Re-observe
      if (execResponse.freshSnapshot) {
        currentSnapshot = execResponse.freshSnapshot;
      } else {
        currentSnapshot = await fetchPageSnapshot(activeTabId);
      }
    }

    if (stepCount >= MAX_STEPS) {
      await speakStatus("The maximum of 15 steps has been reached. The task was stopped.");
    }
  };

    */
  };
  /**
   * Resumes the loop after the user gives confirmation for submit/payment
   */
  /* const confirmAndResumeAction = async () => {
    if (!pendingConfirmationAction || !activeTabId) return;
    const actionToRun = pendingConfirmationAction;
    setPendingConfirmationAction(null);
    setConfirmationMessage("");

    setStatus("executing");
      setStatusText(translate("Executing confirmed action...", "पुष्टि की गई कार्रवाई हो रही है..."));

    let execResponse: { ok?: boolean; error?: string; result?: { success?: boolean; error?: string }; freshSnapshot?: PageSnapshot } | undefined;
    try {
      execResponse = await sendTabMessage(activeTabId, {
        type: "BV_EXECUTE_ACTION",
        action: actionToRun,
      });
    } catch (error) {
      execResponse = { ok: false, error: error instanceof Error ? error.message : "The confirmed action could not be completed." };
    }

    if (!execResponse?.ok || execResponse.result?.success === false) {
      const error = execResponse?.error || execResponse?.result?.error || "The page did not complete the confirmed action.";
      setSteps((previous) => [...previous, {
        stepNumber: previous.length + 1,
        action: actionToRun,
        status: "failed",
        details: error,
        timestamp: Date.now(),
      }]);
      await speakStatus(`कार्रवाई पूरी नहीं हुई: ${error}`);
      setStatus("idle");
      setStatusText(translate("Action could not be completed", "कार्रवाई पूरी नहीं हो सकी"));
      awaitingUserReplyRef.current = true;
      return;
    }

    const freshSnapshot = execResponse.freshSnapshot || await fetchPageSnapshot(activeTabId);
    const paymentReceiptVisible = hasPaymentReceipt(freshSnapshot.summary);
    const paymentLanguage = resolveSpeechLanguage(settings.languageCode, taskGoalRef.current || transcript);
    const paymentConfirmations: Record<string, { receipt: string; continued: string }> = {
      "en-IN": { receipt: "The payment receipt is visible. Payment is confirmed.", continued: "The confirmed action is complete. I am checking the next step." },
      "hi-IN": { receipt: "भुगतान की रसीद दिखाई दे रही है। भुगतान की पुष्टि हो गई है।", continued: "पुष्टि की गई कार्रवाई पूरी हुई। अब अगला कदम जाँच रहा हूँ।" },
      "ta-IN": { receipt: "கட்டண ரசீது தெரிகிறது. கட்டணம் உறுதிப்படுத்தப்பட்டது.", continued: "உறுதிப்படுத்திய செயல் முடிந்தது. அடுத்த படியைச் சரிபார்க்கிறேன்." },
      "te-IN": { receipt: "చెల్లింపు రసీదు కనిపిస్తోంది. చెల్లింపు నిర్ధారించబడింది.", continued: "ధృవీకరించిన చర్య పూర్తయింది. తదుపరి దశను చూస్తున్నాను." },
      "kn-IN": { receipt: "ಪಾವತಿ ರಸೀದಿ ಕಾಣುತ್ತಿದೆ. ಪಾವತಿ ದೃಢವಾಗಿದೆ.", continued: "ದೃಢೀಕರಿಸಿದ ಕ್ರಿಯೆ ಪೂರ್ಣಗೊಂಡಿದೆ. ಮುಂದಿನ ಹಂತವನ್ನು ಪರಿಶೀಲಿಸುತ್ತಿದ್ದೇನೆ." },
      "mr-IN": { receipt: "पेमेंटची पावती दिसत आहे. पेमेंटची पुष्टी झाली.", continued: "पुष्टी केलेली कृती पूर्ण झाली. पुढील टप्पा तपासत आहे." },
      "gu-IN": { receipt: "ચુકવણીની રસીદ દેખાય છે. ચુકવણીની પુષ્ટિ થઈ છે.", continued: "પુષ્ટિ કરેલી ક્રિયા પૂર્ણ થઈ. હવે આગળનું પગલું તપાસું છું." },
      "bn-IN": { receipt: "পেমেন্টের রসিদ দেখা যাচ্ছে। পেমেন্ট নিশ্চিত হয়েছে।", continued: "নিশ্চিত করা কাজটি শেষ হয়েছে। পরের ধাপ দেখছি।" },
      "pa-IN": { receipt: "ਭੁਗਤਾਨ ਦੀ ਰਸੀਦ ਦਿਖ ਰਹੀ ਹੈ। ਭੁਗਤਾਨ ਦੀ ਪੁਸ਼ਟੀ ਹੋ ਗਈ ਹੈ।", continued: "ਪੁਸ਼ਟੀ ਕੀਤੀ ਕਾਰਵਾਈ ਪੂਰੀ ਹੋ ਗਈ। ਹੁਣ ਅਗਲਾ ਕਦਮ ਦੇਖ ਰਿਹਾ ਹਾਂ।" },
      "ml-IN": { receipt: "പണമടച്ച രസീത് കാണുന്നു. പണമടച്ചത് സ്ഥിരീകരിച്ചു.", continued: "സ്ഥിരീകരിച്ച നടപടി പൂർത്തിയായി. അടുത്ത ഘട്ടം പരിശോധിക്കുന്നു." },
    };
    const confirmationCopy = paymentConfirmations[paymentLanguage] || paymentConfirmations["en-IN"];
    const actionSummary = paymentReceiptVisible ? confirmationCopy.receipt : confirmationCopy.continued;
    const nextStep: StepLogEntry = {
      stepNumber: stepsRef.current.length + 1,
      action: actionToRun,
      status: "success",
      spokenSummary: actionSummary,
      timestamp: Date.now(),
    };
    const nextSteps = [...stepsRef.current, nextStep];
    stepsRef.current = nextSteps;
    setSteps(nextSteps);

    if (paymentReceiptVisible) {
      await speakStatus(actionSummary);
      setStatus("idle");
      setStatusText(translate("Payment receipt confirmed", "भुगतान की रसीद की पुष्टि हुई"));
      taskGoalRef.current = null;
      conversationRef.current = [];
      awaitingUserReplyRef.current = false;
    }
    conversationRef.current = [...conversationRef.current, {
      role: "assistant" as const,
      content: "The confirmed action ran, but no payment receipt is visible yet. Continue by inspecting the current page; do not report payment as complete.",
    }].slice(-6);
    setStatus("thinking");
    setStatusText(translate("Checking the next step...", "अगला कदम देख रहे हैं..."));
    awaitingUserReplyRef.current = true;
    await runAgentLoop("", true);
  }; */

  const runAgentLoop = async (initialRequest: string, resumeExistingTask = false) => startTaskRun(initialRequest, resumeExistingTask);

  const confirmTask = async (confirmed: boolean, answer?: string) => {
    const taskId = activeConfirmationTaskId || confirmationQueueRef.current[0];
    if (!taskId) return;
    const context = taskContextsRef.current.get(taskId);
    if (!context) { advanceConfirmationQueue(); return; }
    advanceConfirmationQueue();
    setPendingConfirmationAction(null);
    setConfirmationMessage("");
    const result = await resumeAgentTask(context, confirmed, answer);
    if (result.status === "waiting_confirmation") enqueueConfirmation(taskId);
    else publishTaskCard(taskId, { status: result.status, summary: result.summary, error: result.error });
    await maybeSpeakCombinedSummary();
  };

  const startVoiceListening = async () => {
    if (!voiceSessionActiveRef.current || micSessionRef.current.isActive()) return;
    const generation = ++voiceListenGenerationRef.current;
    setShowMicPermissionHelp(false);
    setTranscript("");
    setStatus("listening");
    setStatusText(translate("Listening... Say stop or tap to end.", "सुन रहे हैं... रोकने के लिए stop कहें या टैप करें।"));

    try {
      if (settings.gnaniApiKey) {
        const speechLanguage = settings.languageCode;
        gnaniWsRef.current = new GnaniPrismaWebSocketClient(
          { apiKey: settings.gnaniApiKey, languageCode: speechLanguage, sttModel: "prisma-v3.0" },
          (text) => {
            if (generation === voiceListenGenerationRef.current && voiceSessionActiveRef.current) setTranscript(text);
          },
          (err) => console.warn("Prisma WS error:", err),
        );
        await gnaniWsRef.current.connect().catch((error) => console.warn("Prisma connect fallback:", error));
      }

      await micSessionRef.current.start(
        (pcmChunk) => {
          if (generation === voiceListenGenerationRef.current) gnaniWsRef.current?.sendAudioChunk(pcmChunk);
        },
        (text, isFinal) => {
          if (generation !== voiceListenGenerationRef.current || !voiceSessionActiveRef.current) return;
          setTranscript(text);
          if (isStopCommand(text)) {
            handleEmergencyStop();
            return;
          }
          if (isFinal && !voiceTurnProcessingRef.current) {
            micSessionRef.current.stop();
            gnaniWsRef.current?.disconnect();
            void voiceTurnHandlerRef.current(text);
          }
        },
        settings.languageCode,
      );
    } catch (error) {
      voiceSessionActiveRef.current = false;
      setVoiceSessionActive(false);
      micSessionRef.current.stop();
      gnaniWsRef.current?.disconnect();
      setStatus("idle");
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof DOMException ? error.name : "";
      if (errorName === "NotAllowedError" || errorMessage.includes("Permission dismissed")) {
        setStatusText(translate("Approve microphone access in the new tab", "नए टैब में माइक की अनुमति दें"));
        setShowMicPermissionHelp(true);
      } else {
        setStatusText(translate("Microphone access error", "माइक की अनुमति में त्रुटि"));
        alert(`Microphone error: ${errorMessage}`);
      }
    }
  };

  const processVoiceTurn = async (text: string) => {
    if (voiceTurnProcessingRef.current) return;
    voiceTurnProcessingRef.current = true;
    voiceListenGenerationRef.current += 1;
    micSessionRef.current.stop();
    gnaniWsRef.current?.disconnect();
    try {
      if (isStopCommand(text)) {
        handleEmergencyStop();
        return;
      }
      if (activeConfirmationTaskId) {
        const taskContext = taskContextsRef.current.get(activeConfirmationTaskId);
        if (taskContext?.pendingQuestion) {
          await confirmTask(true, text);
        } else if (isConfirmationCommand(text)) {
          await confirmTask(true, text);
        } else {
          await confirmTask(false, text);
        }
      } else {
        await handleUserRequestSafely(text);
      }
    } catch (error) {
      setStatus("idle");
      setStatusText(error instanceof Error ? error.message : translate("I could not process that reply.", "मैं उस जवाब को प्रोसेस नहीं कर सका।"));
    } finally {
      voiceTurnProcessingRef.current = false;
      if (voiceSessionActiveRef.current && !micSessionRef.current.isActive()) {
        void startVoiceListeningRef.current();
      }
    }
  };

  voiceTurnHandlerRef.current = processVoiceTurn;
  startVoiceListeningRef.current = startVoiceListening;

  /** One tap starts voice conversation mode; another tap ends it. */
  const toggleRecording = async () => {
    if (voiceSessionActiveRef.current) {
      const partialTranscript = transcript.trim();
      voiceSessionActiveRef.current = false;
      setVoiceSessionActive(false);
      voiceListenGenerationRef.current += 1;
      micSessionRef.current.stop();
      gnaniWsRef.current?.disconnect();
      if (partialTranscript && !voiceTurnProcessingRef.current) {
        await processVoiceTurn(partialTranscript);
      } else if (!voiceTurnProcessingRef.current) {
        setStatus("idle");
        setStatusText(translate("Ready", "तैयार"));
      }
      return;
    }

    voiceSessionActiveRef.current = true;
    setVoiceSessionActive(true);
    await startVoiceListening();
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

    if (isSelectionCommand(prompt)) {
      selectArea();
      return;
    }

    if (activeConfirmationTaskId) {
      const taskContext = taskContextsRef.current.get(activeConfirmationTaskId);
      if (taskContext?.pendingQuestion) void confirmTask(true, prompt);
      else if (isConfirmationCommand(prompt)) void confirmTask(true, prompt);
      else void confirmTask(false, prompt);
      return;
    }

    void handleUserRequestSafely(prompt);
  };

  const runQuickPrompt = (prompt: string) => {
    setCurrentPrompt("");
    setTranscript(prompt);
    void handleUserRequestSafely(prompt);
  };

  const updateLanguage = (languageCode: string) => {
    const nextSettings = { ...settings, languageCode };
    setSettings(nextSettings);
    chrome.storage.local.set({ browseVoiceSettings: nextSettings });
    const resolvedLanguage = resolveSpeechLanguage(languageCode, taskGoalRef.current || transcript) as InterfaceLanguage;
    setStatusText(UI_TRANSLATIONS.Ready?.[resolvedLanguage] || (resolvedLanguage === "hi-IN" ? "तैयार" : "Ready"));
  };

  const taskStatusLabel = (taskStatus: TaskRunnerStatus): string => {
    const labels: Record<TaskRunnerStatus, [string, string]> = {
      queued: ["Queued", "कतार में"],
      running: ["Running", "चल रहा है"],
      waiting_confirmation: ["Waiting for confirmation", "पुष्टि की प्रतीक्षा"],
      blocked: ["Blocked", "रुका हुआ"],
      done: ["Done", "पूरा हुआ"],
      failed: ["Failed", "विफल"],
      stopped: ["Stopped", "रोक दिया गया"],
    };
    return translate(...labels[taskStatus]);
  };

  return (
    <>
      {/* Header with Brand & Emergency Stop */}
      <header className="panel-header">
        <div className="brand-wrapper">
          <span className="brand-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8"/></svg></span>
          <div>
            <div className="brand-title-row"><div className="brand-title">Browse Voice</div><span className="brand-live-dot" /></div>
            <select
              className="language-select"
              value={settings.languageCode}
              onChange={(event) => updateLanguage(event.target.value)}
              aria-label="Speech language"
              title="Speech language"
            >
              {SUPPORTED_INDIAN_LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>{language.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="header-actions">
          <button
            className="btn-stop"
            onClick={handleEmergencyStop}
            title="Stop the current task"
          >
            <span className="stop-square" /> {translate("Stop", "रोकें")}
          </button>
          <button
            className="btn-icon"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Open settings"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37a1.724 1.724 0 0 0 2.572-1.065z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </header>

      {/* Keep consequential action confirmations visible outside the scroll area. */}
      {activeConfirmationTaskId && (pendingConfirmationAction || taskContextsRef.current.get(activeConfirmationTaskId)?.pendingQuestion) && (
        <div className="confirmation-box" role="alert">
          <div className="confirmation-header">
            <span className="alert-mark" aria-hidden="true">!</span>
            <span>{translate("Confirmation required", "पुष्टि आवश्यक है")}</span>
          </div>
          <p className="confirmation-text">
            <strong>{taskViewsRef.current.get(activeConfirmationTaskId)?.label}</strong>{" · "}
            {taskViewsRef.current.get(activeConfirmationTaskId)?.tabTitle || translate("Controlled tab", "नियंत्रित टैब")}<br />
            {confirmationMessage || taskContextsRef.current.get(activeConfirmationTaskId)?.pendingQuestion}
          </p>
          <div className="confirmation-actions">
            <button className="btn-confirm-yes" onClick={() => void confirmTask(true, "yes")}>
              ✓ {translate("Confirm", "पुष्टि करें")}
            </button>
            <button
              className="btn-confirm-no"
              onClick={() => void confirmTask(false, "no")}
            >
              ✕ {translate("Cancel", "रद्द करें")}
            </button>
          </div>
        </div>
      )}

      {/* Main Body */}
      <div className="panel-body">
        {/* Status Card */}
        <div className="status-card">
          <div className="status-indicator">
            <span className={`status-dot ${status}`} />
            <span className="status-label">{statusText}</span>
          </div>
          <div className="status-engine" title={activeTabTitle || "Current browser tab"}>
            <span className="engine-dot" />
            <span>{settings.llmProvider === "mock" ? "Offline engine" : `${settings.llmModel || "AI"} engine`}</span>
          </div>
        </div>

        {taskCards.length > 0 && (
          <section className="task-list-section" aria-label="Parallel tasks">
            <div className="steps-heading">
              <div><div className="section-title">{translate("PARALLEL TASKS", "समानांतर काम")}</div><div className="steps-title">{translate("Task tabs", "काम के टैब")}</div></div>
              <span className="steps-count">{taskCards.length}</span>
            </div>
            <div className="task-card-list">
              {taskCards.map((task) => (
                <article className={`task-card ${task.status}`} key={task.id}>
                  <div className="task-card-header">
                    <div className="task-card-identity">
                      {task.faviconUrl ? <img src={task.faviconUrl} alt="" className="task-favicon" /> : <span className="task-favicon-placeholder" aria-hidden="true">↗</span>}
                      <div><strong>{task.label}</strong><span>{task.tabTitle || translate("Preparing tab...", "टैब तैयार हो रहा है...")}</span></div>
                    </div>
                    <button
                      type="button"
                      className="task-stop-button"
                      disabled={["done", "failed", "stopped"].includes(task.status)}
                      onClick={() => {
                        const context = taskContextsRef.current.get(task.id);
                        if (context) stopAgentTask(context);
                        publishTaskCard(task.id, { status: "stopped", currentStep: translate("Stopped", "रोक दिया गया") });
                      }}
                    >{translate("Stop", "रोकें")}</button>
                  </div>
                  <div className="task-status-row"><span className={`task-status-dot ${task.status}`} /><span>{taskStatusLabel(task.status)}</span></div>
                  <div className="task-current-step">{task.currentStep}</div>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Restricted Page Warning Banner */}
        {activeTabUrl && isRestrictedPage(activeTabUrl) && (
          <div className="restricted-banner" role="status">
            <span className="restricted-icon" aria-hidden="true">!</span>
            <div><strong>{translate("Restricted page", "प्रतिबंधित पेज")}</strong><span className="restricted-copy">{translate("Chrome blocks extensions here. You can still say", "Chrome यहां extensions को block करता है। आप कह सकते हैं")} <em>“open YouTube”</em> {translate("or", "या")} <em>“open LeetCode”</em> {translate("to navigate away.", "दूसरे पेज पर जाने के लिए।")}</span></div>
          </div>
        )}

        {/* Microphone Voice Control Card */}
        <section className="mic-section" aria-label="Voice controls">
          <div className="voice-toolbar">
            <div className="voice-kicker">{translate("VOICE CONTROL", "वॉइस कंट्रोल")}</div>
            <div className="voice-toolbar-actions">
              <button className="select-area-button" type="button" onClick={selectArea}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 8h8v8H8z"/></svg>
                {translate("Select area", "क्षेत्र चुनें")}
              </button>
              <button
                className="site-safety-button"
                type="button"
                onClick={() => void checkCurrentSiteSafety()}
                disabled={siteSafetyLoading}
                title="Check this site for security and phishing risk signals"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.4 2.9 8.4 7 10 4.1-1.6 7-5.6 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg>
                {siteSafetyLoading ? translate("Checking…", "जांच हो रही है…") : translate("Check site", "साइट जांचें")}
              </button>
              <button
                className="site-chat-button"
                type="button"
                onClick={() => void startSiteChat()}
                disabled={siteChat.status === "queued" || siteChat.status === "crawling" || siteChat.status === "processing"}
                title="Crawl this website and chat with its indexed knowledge"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2 2.2 3 4.9 3 8s-1 5.8-3 8c-2-2.2-3-4.9-3-8s1-5.8 3-8Z"/></svg>
                {siteChat.status === "queued" || siteChat.status === "crawling" || siteChat.status === "processing" ? translate("Indexing…", "इंडेक्स हो रहा है…") : translate("Chat with site", "साइट से चैट करें")}
              </button>
            </div>
          </div>
          <button
            className={`mic-button ${voiceSessionActive ? "recording" : ""}`}
            onClick={toggleRecording}
            title={voiceSessionActive ? translate("Tap to end voice conversation", "वॉइस बातचीत समाप्त करने के लिए टैप करें") : translate("Tap to start a voice conversation", "वॉइस बातचीत शुरू करने के लिए टैप करें")}
            aria-label={status === "listening" ? translate("Stop listening", "सुनना बंद करें") : translate("Start voice input", "वॉइस इनपुट शुरू करें")}
          >
            {status === "listening" ? <span className="recording-mark" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8"/></svg>}
          </button>
          <div className="mic-prompt-title">{voiceSessionActive ? translate("Listening…", "सुन रहे हैं…") : translate("Tap mic to speak", "बोलने के लिए माइक दबाएं")}</div>
          <div className="mic-help">
            {voiceSessionActive
              ? status === "listening"
                ? translate("Listening... I will listen again after each reply. Say 'stop' or tap to end.", "सुन रहे हैं... हर जवाब के बाद मैं फिर सुनूँगा। रोकने के लिए 'stop' कहें या टैप करें।")
                : translate("Voice conversation active. I will listen again when I finish this turn. Tap to end.", "वॉइस बातचीत सक्रिय है। यह काम पूरा होने पर मैं फिर सुनूँगा। समाप्त करने के लिए टैप करें।")
              : translate("Speak naturally or try a quick prompt", "स्वाभाविक रूप से बोलें या कोई quick prompt चुनें")}
          </div>
          {!voiceSessionActive && (
            <div className="quick-prompts" aria-label="Quick prompts">
              <button type="button" onClick={() => runQuickPrompt("Check electricity bill")}>{translate("Check electricity bill", "बिजली का बिल देखें")}</button>
              <button type="button" onClick={() => runQuickPrompt("Pay utility bill")}>{translate("Pay utility bill", "बिजली का बिल भरें")}</button>
              <button type="button" onClick={() => runQuickPrompt("Download payment receipt")}>{translate("Download payment receipt", "भुगतान रसीद डाउनलोड करें")}</button>
            </div>
          )}
          {showMicPermissionHelp && (
            <div className="mic-permission-help">
              <span>{translate("Chrome needs microphone approval in a regular tab.", "Chrome को सामान्य टैब में माइक की अनुमति चाहिए।")}</span>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  chrome.tabs.create({
                    url: chrome.runtime.getURL("sidepanel/mic-permission.html"),
                  });
                }}
              >
                {translate("Grant microphone access", "माइक की अनुमति दें")}
              </button>
              <span>{translate("Allow access there, close that tab, then tap the microphone again.", "वहां अनुमति दें, टैब बंद करें और फिर माइक दबाएं।")}</span>
            </div>
          )}

          {/* Live Transcript View */}
          <div className="transcript-card">
            <div className="transcript-header">{translate("Live Transcript", "लाइव ट्रांसक्रिप्ट")}</div>
            <div className="transcript-text">
              {transcript || <span className="transcript-empty">{translate("Your voice will appear here...", "आपकी आवाज़ यहां दिखाई देगी...")}</span>}
            </div>
          </div>

          {snips.length > 0 && (
            <div className="snip-context" aria-label="Selected page areas">
              <div className="snip-context-header">
                <span>{translate("Selected context", "चयनित संदर्भ")}</span>
                <span>{snips.length}/4</span>
              </div>
              <div className="snip-chip-list">
                {snips.map((snip, index) => (
                  <div className="snip-chip" key={snip.id}>
                    <img src={snip.imageDataUrl} alt={`Selected area ${index + 1}`} />
                    <span>{translate("Area", "क्षेत्र")} {index + 1}</span>
                    <button
                      type="button"
                      aria-label={`Remove selected area ${index + 1}`}
                      onClick={() => setSnips((previous) => previous.filter((item) => item.id !== snip.id))}
                    >×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {siteChat.status !== "idle" && (
            <div className={`site-chat-card ${siteChat.status}`} aria-label="Site chat status">
              <div className="site-chat-card-header">
                <div>
                  <div className="site-chat-kicker">{translate("SITE KNOWLEDGE", "साइट नॉलेज")}</div>
                  <strong>{siteChat.startUrl ? new URL(siteChat.startUrl).hostname : "Current website"}</strong>
                </div>
                <button type="button" className="site-chat-clear" onClick={clearSiteChat}>{translate("Clear", "साफ़ करें")}</button>
              </div>
              <div className="site-chat-progress">
                <span className="site-chat-dot" />
                <span>
                  {siteChat.status === "ready"
                    ? translate("Indexed and ready for questions", "इंडेक्स तैयार है, आप सवाल पूछ सकते हैं")
                    : siteChat.status === "failed"
                      ? siteChat.message || translate("Indexing failed", "इंडेक्सिंग विफल रही")
                      : `${siteChat.message || translate("Crawler is working", "क्रॉलर काम कर रहा है")}${siteChat.pagesIndexed > 0 ? ` · ${siteChat.pagesIndexed}${siteChat.totalPages ? `/${siteChat.totalPages}` : ""} ${translate("pages", "पेज")}` : ""}`}
                </span>
              </div>
            </div>
          )}

          {siteSafety && (
            <div className={`site-safety-card ${siteSafety.verdict}`} aria-label="Site safety result">
              <div className="site-safety-card-header">
                <div>
                  <div className="site-chat-kicker">{translate("SITE SAFETY", "साइट सुरक्षा")}</div>
                  <strong>
                    {siteSafety.verdict === "low-risk"
                      ? translate("Low risk", "कम जोखिम")
                      : siteSafety.verdict === "caution"
                        ? translate("Use caution", "सावधानी बरतें")
                        : siteSafety.verdict === "high-risk"
                          ? translate("High risk", "उच्च जोखिम")
                          : translate("Unknown", "अज्ञात")}
                  </strong>
                </div>
                <span className="site-safety-score">{siteSafety.score}/100</span>
              </div>
              <p className="site-safety-summary">{siteSafety.summary}</p>
              {siteSafety.reasons.length > 0 && (
                <div className="site-safety-reasons">
                  {siteSafety.reasons.slice(0, 5).map((reason, index) => (
                    <div className="site-safety-reason" key={`${reason.title}-${index}`}>
                      <span className={`safety-severity ${reason.severity}`} aria-hidden="true" />
                      <div><strong>{reason.title}</strong><span>{reason.detail}</span></div>
                    </div>
                  ))}
                </div>
              )}
              <div className="site-safety-disclaimer">
                {translate("This is a risk assessment, not proof that a site is fake or legitimate.", "यह जोखिम आकलन है; इससे साइट के नकली या वैध होने का पक्का प्रमाण नहीं मिलता।")}
              </div>
            </div>
          )}

          {chatMessages.length > 0 && (
            <div className="chat-thread" aria-label="Snip conversation">
              {chatMessages.map((message) => (
                <div className={`chat-message ${message.role}`} key={message.id}>
                  <span className="chat-role">{message.role === "user" ? translate("You", "आप") : "Browse Voice"}</span>
                  <p>{message.text}</p>
                </div>
              ))}
            </div>
          )}

          {siteChatMessages.length > 0 && (
            <div className="chat-thread site-chat-thread" aria-label="Site conversation">
              {siteChatMessages.map((message) => (
                <div className={`chat-message ${message.role}`} key={message.id}>
                  <span className="chat-role">{message.role === "user" ? translate("You", "आप") : translate("Site knowledge", "साइट नॉलेज")}</span>
                  <p>{message.text}</p>
                </div>
              ))}
            </div>
          )}

          {/* Manual Text Fallback */}
          <form className="send-row" onSubmit={handleManualSubmit}>
            <input
              type="text"
              className="input-text"
              placeholder={translate("Or type a command here...", "या यहां कमांड लिखें...")}
              value={currentPrompt}
              onChange={(e) => setCurrentPrompt(e.target.value)}
            />
            <button type="submit" className="btn-primary">
              {translate("Send", "भेजें")}
            </button>
          </form>
        </section>

        {/* Step Execution Timeline */}
        <div className="step-log-section">
          <div className="steps-heading"><div><div className="section-title">{translate("ACTIVITY", "गतिविधि")}</div><div className="steps-title">{translate("Execution steps", "एक्जीक्यूशन स्टेप्स")}</div></div><span className="steps-count">{steps.length} / 15</span></div>
          {steps.length === 0 ? (
            <div className="empty-steps">
              <span className="empty-steps-icon" aria-hidden="true">ϟ</span>
              <div><strong>{translate("Your actions will appear here", "आपकी कार्रवाइयां यहां दिखाई देंगी")}</strong><span>{translate("Automated web clicks, fills, and navigation will stream live", "वेब क्लिक, फिल और नेविगेशन यहां दिखाई देंगे")}</span></div>
            </div>
          ) : (
            <div className="step-list">
              {steps.map((step) => (
                <div key={step.stepNumber} className={`step-card ${step.status}`}>
                  <div className="step-card-header">
                    <span className="step-badge">{translate("Step", "चरण")} {step.stepNumber}</span>
                    <span className="step-action-tag">{ACTION_TAG_TRANSLATIONS[resolveSpeechLanguage(settings.languageCode, taskGoalRef.current || transcript)]?.[step.action.action] || step.action.action.toUpperCase()}</span>
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

      <footer className="panel-footer">
        <span><span className="footer-live-dot" /> {translate("Secure Web Sandbox Active", "सिक्योर वेब सैंडबॉक्स सक्रिय है")}</span>
        <span className="feedback-link">{translate("Feedback", "फीडबैक")}</span>
      </footer>

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{translate("Settings", "सेटिंग्स")}</span>
              <button
                className="btn-icon"
                onClick={() => setSettingsOpen(false)}
                style={{ border: "none" }}
              >
                ✕
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">{translate("Language", "भाषा")}</label>
              <select
                className="form-select"
                value={settings.languageCode}
                onChange={(e) => updateLanguage(e.target.value)}
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
                placeholder={translate("Enter Gnani API Key", "Gnani API Key दर्ज करें")}
                value={settings.gnaniApiKey}
                onChange={(e) => setSettings({ ...settings, gnaniApiKey: e.target.value })}
              />
              <span className="form-help">
                {translate("Required for Gnani Prisma STT and Timbre TTS. Stored securely in chrome.storage.local.", "Gnani Prisma STT और Timbre TTS के लिए आवश्यक है। chrome.storage.local में सुरक्षित रूप से सेव है।")}
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">{translate("Planner Provider", "प्लानर प्रोवाइडर")}</label>
              <select
                className="form-select"
                value={settings.llmProvider}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    llmProvider: e.target.value as "mock" | "openai-compatible" | "huggingface" | "gemini",
                    ...(e.target.value === "huggingface"
                      ? { llmEndpoint: HUGGINGFACE_ENDPOINT, llmModel: DEFAULT_HUGGINGFACE_MODEL }
                      : {}),
                  })
                }
              >
                <option value="mock">{translate("Rule-Based Mock Planner (Offline Demo)", "रूल-बेस्ड मॉक प्लानर (ऑफलाइन डेमो)")}</option>
                <option value="gemini">Google Gemini (AI Studio)</option>
                <option value="huggingface">Hugging Face Inference Providers</option>
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

            {settings.llmProvider === "huggingface" && (
              <>
                <div className="form-group">
                  <label className="form-label">Hugging Face token</label>
                  <input
                    type="password"
                    className="form-input"
                    placeholder="hf_..."
                    value={settings.llmApiKey}
                    onChange={(e) => setSettings({ ...settings, llmApiKey: e.target.value })}
                  />
                  <span className="form-help">
                    Create a token with Inference Providers access at{" "}
                    <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">
                      Hugging Face settings
                    </a>
                    . It is saved in chrome.storage.local.
                  </span>
                </div>
                <div className="form-group">
                  <label className="form-label">Hugging Face model</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="organization/model:provider"
                    value={settings.llmModel}
                    onChange={(e) => setSettings({ ...settings, llmModel: e.target.value })}
                  />
                  <span className="form-help">
                    Default uses openai/gpt-oss-20b on DeepInfra. Inference usage may require HF credits.
                  </span>
                </div>
              </>
            )}

            <div className="settings-divider" />
            <div className="form-group">
              <label className="form-label">{translate("Site knowledge API endpoint", "साइट नॉलेज API endpoint")}</label>
              <input
                type="url"
                className="form-input"
                placeholder="https://your-api.example.com"
                value={settings.siteChatEndpoint}
                onChange={(e) => setSettings({ ...settings, siteChatEndpoint: e.target.value })}
              />
              <span className="form-help">
                {translate("The service crawls the current site, creates embeddings, stores them in your vector store, and answers site questions.", "यह सर्विस वर्तमान साइट को crawl करके embeddings बनाती है, vector store में सेव करती है और सवालों के जवाब देती है।")}
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">{translate("Site knowledge API key (optional)", "साइट नॉलेज API key (वैकल्पिक)")}</label>
              <input
                type="password"
                className="form-input"
                placeholder="Service API key"
                value={settings.siteChatApiKey}
                onChange={(e) => setSettings({ ...settings, siteChatApiKey: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label className="form-label">{translate("Maximum pages per site", "प्रति साइट अधिकतम पेज")}</label>
              <input
                type="number"
                className="form-input"
                min={1}
                max={250}
                value={settings.siteChatMaxPages}
                onChange={(e) => setSettings({ ...settings, siteChatMaxPages: Math.min(250, Math.max(1, Number(e.target.value) || 1)) })}
              />
            </div>

            <div className="form-group">
              <label className="form-label">{translate("Parallel task limit", "समानांतर काम की सीमा")}</label>
              <input
                type="number"
                className="form-input"
                min={1}
                max={4}
                value={settings.taskConcurrency}
                onChange={(e) => setSettings({ ...settings, taskConcurrency: Math.min(4, Math.max(1, Number(e.target.value) || 1)) })}
              />
            </div>

            <label className="settings-check-row">
              <input
                type="checkbox"
                checked={settings.focusCompletedTab}
                onChange={(e) => setSettings({ ...settings, focusCompletedTab: e.target.checked })}
              />
              <span>{translate("Focus the first completed task tab", "पहले पूरे हुए काम के टैब पर जाएं")}</span>
            </label>

            <button
              className="btn-primary"
              style={{ marginTop: "8px" }}
              onClick={() => saveSettings(settings)}
            >
              {translate("Save Settings", "सेटिंग्स सेव करें")}
            </button>
          </div>
        </div>
      )}
    </>
  );
};
