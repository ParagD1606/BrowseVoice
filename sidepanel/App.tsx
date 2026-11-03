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
  type PlannerProvider,
  type StepLogEntry,
  type LLMConfig,
  type SnipContext,
} from "../lib/planner";
import {
  inspectActionSafety,
  isStopCommand,
  isConfirmationCommand,
  type PageSnapshot,
} from "../lib/safety";
import { validatePlannerAction, type PlannerAction } from "../lib/schema";
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

function collectFormFields(snapshot: PageSnapshot): { fields: FormFieldDescriptor[]; manualCount: number } {
  const occurrenceByIdentity = new Map<string, number>();
  let manualCount = 0;
  const fields: FormFieldDescriptor[] = [];
  const radioGroups = new Map<string, { field: FormFieldDescriptor; labels: string[] }>();
  for (const element of snapshot.interactiveElements) {
    if (!["input", "textarea", "select"].includes(element.tag)) continue;
    const type = (element.type || "text").toLowerCase();
    if (element.tag === "input" && ["button", "submit", "reset", "hidden", "image"].includes(type)) continue;
    if (element.tag === "input" && type === "file") { manualCount += 1; continue; }
    if (element.isSensitive) {
      manualCount += 1;
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
  return { fields, manualCount };
}

function findFormField(snapshot: PageSnapshot, descriptor: FormFieldDescriptor, answer?: string) {
  if (descriptor.kind === "radio") {
    const answerText = (answer || "").trim().toLowerCase();
    const optionIndex = /^\d+$/.test(answerText) ? Number(answerText) - 1 : -1;
    const selectedLabel = optionIndex >= 0
      ? descriptor.options?.[optionIndex]
      : descriptor.options?.find((option) => option.toLowerCase() === answerText || option.toLowerCase().includes(answerText));
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

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

function isSelectionCommand(text: string): boolean {
  const value = text.toLowerCase().trim();
  return /(?:select|snip|capture|screenshot|crop|highlight).*(?:area|this|that|section|part|region)?|(?:yeh|yah|is|this)\s+(?:select|snip|capture|screenshot)|area\s+(?:select|snip)|select\s+karo/.test(value);
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
  const [statusText, setStatusText] = useState<string>("Ready / तैयार");
  const [showMicPermissionHelp, setShowMicPermissionHelp] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [activeTabTitle, setActiveTabTitle] = useState<string>("");
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [activeTabUrl, setActiveTabUrl] = useState<string>("");
  const [steps, setSteps] = useState<StepLogEntry[]>([]);
  const [currentPrompt, setCurrentPrompt] = useState<string>("");
  const [pendingConfirmationAction, setPendingConfirmationAction] = useState<PlannerAction | null>(null);
  const [confirmationMessage, setConfirmationMessage] = useState<string>("");
  const [snips, setSnips] = useState<SnipContext[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  // Settings modal
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);

  // Refs for tracking active objects
  const micSessionRef = useRef<MicrophoneSession>(new MicrophoneSession());
  const gnaniWsRef = useRef<GnaniPrismaWebSocketClient | null>(null);
  const isStoppedRef = useRef<boolean>(false);
  const stepsRef = useRef<StepLogEntry[]>([]);
  const taskGoalRef = useRef<string | null>(null);
  const conversationRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const awaitingUserReplyRef = useRef(false);
  const formFillRef = useRef<FormFillSession | null>(null);
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
    taskGoalRef.current = null;
    conversationRef.current = [];
    awaitingUserReplyRef.current = false;
    formFillRef.current = null;

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

  const askNextFormField = async () => {
    const session = formFillRef.current;
    const field = session?.fields[session.index];
    if (!session || !field) return;
    const question = field.kind === "select"
      ? `Which option should I choose for ${field.label}? ${field.options?.join(", ") || ""}`
      : field.kind === "checkbox"
        ? `Should I check ${field.label}? Please answer yes or no.`
        : field.kind === "radio"
          ? `Which option should I choose for ${field.label}? ${field.options?.join(", ") || ""}`
          : `What should I enter for ${field.label}?`;
    setStatus("idle");
    setStatusText(`Field ${session.index + 1} of ${session.fields.length}: ${field.label}`);
    await speakStatus(question);
    setStatusText(`Reply with a value for ${field.label}`);
  };

  const submitFormFieldAnswer = async (answer: string) => {
    const session = formFillRef.current;
    const field = session?.fields[session.index];
    if (!session || !field) return false;
    const value = answer.trim();
    if (!value) {
      setStatusText(`Please answer for ${field.label} before continuing.`);
      return true;
    }

    setStatus("thinking");
    setStatusText(`Filling ${field.label}...`);
    try {
      const freshSnapshot = await fetchPageSnapshot(session.tabId);
      const checkboxChoice = field.kind === "checkbox" ? parseYesNo(value) : null;
      if (field.kind === "checkbox" && checkboxChoice === null) {
        setStatus("idle");
        setStatusText(`Please answer yes or no for ${field.label}.`);
        return true;
      }

      const element = findFormField(freshSnapshot, field, field.kind === "radio" ? value : undefined);
      if (!element && field.kind === "radio") {
        setStatus("idle");
        setStatusText(`Choose one of these options for ${field.label}: ${field.options?.join(", ") || ""}`);
        return true;
      }
      if (!element) throw new Error(`I can no longer find the ${field.label} field. Check the page and try again.`);
      let selectedValue = value;
      if (field.kind === "select") {
        const match = field.options?.find((option) => option.toLowerCase() === value.toLowerCase() || option.toLowerCase().includes(value.toLowerCase()));
        if (field.options?.length && !match) {
          setStatus("idle");
          setStatusText(`Choose one of these options for ${field.label}: ${field.options.join(", ")}`);
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
        const safety = inspectActionSafety(validation.action, freshSnapshot);
        if (!safety.permitted) throw new Error(safety.reason || "Safety blocked this field.");
        if (safety.requiresConfirmation) {
          session.skippedManualCount += 1;
          await speakStatus(`I left ${field.label} unchanged because it needs a separate confirmation. I will continue to the next field.`);
        } else {
          response = await chrome.tabs.sendMessage(session.tabId, {
            type: "BV_EXECUTE_ACTION",
            action: validation.action,
          });
          if (!response?.ok) throw new Error(response?.error || `Could not fill ${field.label}.`);

          const stepNumber = stepsRef.current.length + 1;
          setSteps((previous) => [...previous, {
            stepNumber,
            action: validation.action,
            status: "success",
            spokenSummary: `Filled ${field.label}.`,
            timestamp: Date.now(),
          }]);
        }
      }
      session.completed.add(field.fingerprint);

      const updatedSnapshot = (response?.freshSnapshot || await fetchPageSnapshot(session.tabId)) as PageSnapshot;
      const refreshed = collectFormFields(updatedSnapshot);
      session.skippedManualCount = Math.max(session.skippedManualCount, refreshed.manualCount);
      session.fields = refreshed.fields.filter((candidateField) => !session.completed.has(candidateField.fingerprint));
      session.index = 0;

      if (session.fields.length === 0) {
        const skippedMessage = session.skippedManualCount > 0
          ? "The supported fields are filled. Fill any sensitive, file, or protected fields yourself, then review the form. I did not submit it."
          : "The visible fields are filled. Please review the form. I did not submit it.";
        formFillRef.current = null;
        taskGoalRef.current = null;
        conversationRef.current = [];
        awaitingUserReplyRef.current = false;
        await speakStatus(skippedMessage);
        setStatus("idle");
        setStatusText("Form filled. Review before submitting.");
      } else {
        await askNextFormField();
      }
    } catch (error) {
      setStatus("idle");
      setStatusText(error instanceof Error ? error.message : "I could not fill that field.");
    }
    return true;
  };

  const handleUserRequest = async (text: string) => {
    if (formFillRef.current && await submitFormFieldAnswer(text)) return;
    await runAgentLoop(text);
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

  const selectArea = async () => {
    if (!activeTabId) {
      alert("No active browser tab found.");
      return;
    }

    setStatus("thinking");
    setStatusText("Select an area on the page / पेज का हिस्सा चुनें...");

    try {
      let selectionResponse: { ok?: boolean; selection?: { rect: { x: number; y: number; width: number; height: number }; viewportWidth: number; text: string; elements: string[]; title: string; url: string }; error?: string };
      try {
        selectionResponse = await chrome.tabs.sendMessage(activeTabId, { type: "BV_START_SNIP_SELECTION" });
      } catch {
        await chrome.runtime.sendMessage({ type: "BV_ENSURE_TAB_CONNECTED", tabId: activeTabId });
        selectionResponse = await chrome.tabs.sendMessage(activeTabId, { type: "BV_START_SNIP_SELECTION" });
      }

      if (!selectionResponse?.ok || !selectionResponse.selection) {
        if (selectionResponse?.error === "Selection cancelled.") {
          setStatus("idle");
          setStatusText("Ready / तैयार");
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
      setStatusText("Snip added / चयन जुड़ गया");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Selection failed.";
      if (message !== "Selection cancelled." && message !== "Selection was too small.") {
        setStatusText(message);
        alert(message);
      } else {
        setStatus("idle");
        setStatusText("Ready / तैयार");
      }
    }
  };

  const answerFromSnips = async (question: string) => {
    if (snips.length === 0) return;
    const userMessage: ChatMessage = { id: `user-${Date.now()}`, role: "user", text: question };
    const conversation = chatMessages.slice(-8).map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`).join("\n");
    setChatMessages((previous) => [...previous, userMessage]);
    setStatus("thinking");
    setStatusText("Reading selected area / चुने हुए हिस्से को पढ़ रहे हैं...");
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
      setStatusText("Answer ready / जवाब तैयार");
      await speakStatus(answer.text.slice(0, 500));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not answer from the selected area.";
      setChatMessages((previous) => [...previous, { id: `assistant-${Date.now()}`, role: "assistant", text: message }]);
      setStatus("idle");
      setStatusText("Could not answer / जवाब नहीं मिल सका");
    }
  };

  /**
   * Core Agent Execution Loop
   */
  const runAgentLoop = async (initialRequest: string) => {
    if (snips.length > 0) {
      await answerFromSnips(initialRequest);
      return;
    }
    if (!activeTabId) {
      alert("No active browser tab found.");
      return;
    }

    isStoppedRef.current = false;
    setSteps([]);
    setStatus("thinking");
    setStatusText("Analyzing page / पेज की जाँच हो रही है...");

    // A reply to ask_user continues the original task. New commands start a clean context.
    const isFollowUp = awaitingUserReplyRef.current && taskGoalRef.current !== null;
    if (!isFollowUp) {
      taskGoalRef.current = initialRequest;
      conversationRef.current = [{ role: "user" as const, content: initialRequest }];
    } else {
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
    const formFillIntent = /\b(fill|complete|populate|enter details|register|sign up|apply for|bhar(?:o|na|do|de))\b|फॉर्म|फ़ॉर्म|भर(?:ो|ना|ें)/i.test(taskGoal);
    if (!formFillRef.current && formFillIntent) {
      const { fields, manualCount } = collectFormFields(currentSnapshot);
      if (fields.length > 0) {
        formFillRef.current = {
          tabId: activeTabId,
          goal: taskGoal,
          fields,
          index: 0,
          completed: new Set(),
          skippedManualCount: manualCount,
        };
        if (manualCount > 0) {
          await speakStatus("I will leave sensitive and file fields for you to handle manually. I will ask about every other visible field one at a time.");
        }
        await askNextFormField();
        return;
      }
    }

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
          userRequest: taskGoal,
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
        conversationRef.current = [...conversationRef.current, { role: "assistant" as const, content: action.summary }].slice(-6);
        await speakStatus(action.summary);
        setStatus("idle");
        setStatusText("Completed / पूरा हुआ");
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
      conversationRef.current = [...conversationRef.current, { role: "assistant" as const, content: rationaleText }].slice(-6);
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
        if (isSelectionCommand(text)) {
          await selectArea();
          return;
        }
        // Check for confirmation
        if (pendingConfirmationAction && isConfirmationCommand(text)) {
          await confirmAndResumeAction();
          return;
        }
        await handleUserRequest(text);
      }
    } else {
      // Start recording
      setShowMicPermissionHelp(false);
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
              if (isSelectionCommand(text)) {
                selectArea();
              } else if (pendingConfirmationAction && isConfirmationCommand(text)) {
                confirmAndResumeAction();
              } else {
                handleUserRequest(text);
              }
            }
          },
          settings.languageCode
        );
      } catch (err) {
        setStatus("idle");
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorName = err instanceof DOMException ? err.name : "";
        if (errorName === "NotAllowedError" || errorMessage.includes("Permission dismissed")) {
          setStatusText("Approve microphone access in the new tab");
          setShowMicPermissionHelp(true);
        } else {
          setStatusText("Microphone access error");
          alert(`Microphone error: ${errorMessage}`);
        }
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

    if (isSelectionCommand(prompt)) {
      selectArea();
      return;
    }

    if (pendingConfirmationAction && isConfirmationCommand(prompt)) {
      confirmAndResumeAction();
      return;
    }

    void handleUserRequest(prompt);
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
          <div className="voice-toolbar">
            <div className="voice-kicker">VOICE CONTROL</div>
            <button className="select-area-button" type="button" onClick={selectArea}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 8h8v8H8z"/></svg>
              Select area
            </button>
          </div>
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
          {showMicPermissionHelp && (
            <div className="mic-permission-help">
              <span>Chrome needs microphone approval in a regular tab.</span>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  chrome.tabs.create({
                    url: chrome.runtime.getURL("sidepanel/mic-permission.html"),
                  });
                }}
              >
                Grant microphone access
              </button>
              <span>Allow access there, close that tab, then tap the microphone again.</span>
            </div>
          )}

          {/* Live Transcript View */}
          <div className="transcript-card">
            <div className="transcript-header">Live Transcript</div>
            <div className="transcript-text">
              {transcript || <span className="transcript-empty">Your voice will appear here...</span>}
            </div>
          </div>

          {snips.length > 0 && (
            <div className="snip-context" aria-label="Selected page areas">
              <div className="snip-context-header">
                <span>Selected context</span>
                <span>{snips.length}/4</span>
              </div>
              <div className="snip-chip-list">
                {snips.map((snip, index) => (
                  <div className="snip-chip" key={snip.id}>
                    <img src={snip.imageDataUrl} alt={`Selected area ${index + 1}`} />
                    <span>Area {index + 1}</span>
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

          {chatMessages.length > 0 && (
            <div className="chat-thread" aria-label="Snip conversation">
              {chatMessages.map((message) => (
                <div className={`chat-message ${message.role}`} key={message.id}>
                  <span className="chat-role">{message.role === "user" ? "You" : "Browse Voice"}</span>
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
