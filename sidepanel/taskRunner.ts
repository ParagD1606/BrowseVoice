import {
  getPlannerRetryAfterMs,
  isPlannerRateLimitError,
  type PlannerProvider,
  type StepLogEntry,
} from "../lib/planner.ts";
import { hasPaymentReceipt, hasVisiblePaymentForm, isPaymentIntent } from "../lib/payment-state.ts";
import { inspectActionSafety, type PageSnapshot } from "../lib/safety.ts";
import { validatePlannerAction, type PlannerAction } from "../lib/schema.ts";
import {
  resolveLanguage,
  getUiTranslation,
  ACTION_SPEECH,
} from "../lib/i18n.ts";

export type TaskRunnerStatus =
  | "queued"
  | "running"
  | "waiting_confirmation"
  | "blocked"
  | "done"
  | "failed"
  | "stopped";

export interface PendingTaskConfirmation {
  action: PlannerAction;
  message: string;
  reason?: string;
  snapshot: PageSnapshot;
}

export interface TaskRunnerCallbacks {
  onStatus?: (status: TaskRunnerStatus, text: string) => void;
  onStep?: (entry: StepLogEntry) => void;
  onPrompt?: (text: string, kind: "confirmation" | "blocked" | "question") => Promise<void> | void;
  onRateLimited?: (attempt: number, retryAfterMs: number) => void;
}

export interface TaskRunnerContext {
  readonly tabId: number;
  readonly goal: string;
  readonly planner: PlannerProvider;
  readonly maxSteps: number;
  readonly controller: AbortController;
  readonly languageCode?: string;
  steps: StepLogEntry[];
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  pendingConfirmation: PendingTaskConfirmation | null;
  pendingQuestion: string | null;
  stopRequested: boolean;
  callbacks?: TaskRunnerCallbacks;
  sendTabMessage: <T>(tabId: number, message: Record<string, unknown>) => Promise<T>;
}

export interface TaskRunnerResult {
  status: TaskRunnerStatus;
  summary?: string;
  error?: string;
  context: TaskRunnerContext;
}

interface ExecutionResponse {
  ok?: boolean;
  error?: string;
  result?: { success?: boolean; error?: string };
  freshSnapshot?: PageSnapshot;
}

export function createTaskRunnerContext(
  input: Omit<TaskRunnerContext, "controller" | "steps" | "conversation" | "pendingConfirmation" | "pendingQuestion" | "stopRequested" | "maxSteps"> & { maxSteps?: number },
): TaskRunnerContext {
  return {
    ...input,
    languageCode: input.languageCode || "en-IN",
    maxSteps: input.maxSteps ?? 15,
    controller: new AbortController(),
    steps: [],
    conversation: [{ role: "user", content: input.goal }],
    pendingConfirmation: null,
    pendingQuestion: null,
    stopRequested: false,
  };
}

export function stopAgentTask(context: TaskRunnerContext): void {
  context.stopRequested = true;
  context.controller.abort();
  context.pendingConfirmation = null;
  context.pendingQuestion = null;
  const lang = resolveLanguage(context.languageCode || "en-IN", context.goal);
  context.callbacks?.onStatus?.("stopped", getUiTranslation("Task stopped", lang, "काम रोक दिया गया"));
}

export function stopAgentTasks(contexts: Iterable<TaskRunnerContext>): void {
  for (const context of contexts) stopAgentTask(context);
}

function isAborted(context: TaskRunnerContext): boolean {
  return context.stopRequested || context.controller.signal.aborted;
}

function emitStatus(context: TaskRunnerContext, status: TaskRunnerStatus, text: string): void {
  context.callbacks?.onStatus?.(status, text);
}

function appendStep(context: TaskRunnerContext, entry: StepLogEntry): void {
  context.steps.push(entry);
  context.callbacks?.onStep?.(entry);
}

function outcomeSpeech(action: PlannerAction, snapshot: PageSnapshot, languageCode: string = "en-IN"): string {
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
  return action.action === "done"
    ? action.summary
    : action.action === "ask_user"
    ? action.question
    : getUiTranslation("Action completed.", lang);
}

function repeatableActionKey(action: PlannerAction): string | null {
  if (action.action === "click") return `click:${action.id}`;
  if (action.action === "navigate") return `navigate:${action.url.trim().replace(/\/$/, "")}`;
  return null;
}

async function delayWithAbort(context: TaskRunnerContext, delayMs: number): Promise<void> {
  if (delayMs <= 0 || isAborted(context)) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    context.controller.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function planWithRetry(context: TaskRunnerContext, snapshot: PageSnapshot): Promise<PlannerAction> {
  let attempt = 0;
  while (true) {
    if (isAborted(context)) throw new Error("Task stopped.");
    try {
      return await context.planner.plan({
        userRequest: context.goal,
        languageCode: context.languageCode,
        snapshot,
        history: context.steps.slice(-5),
        conversation: context.conversation,
      });
    } catch (error) {
      if (!isPlannerRateLimitError(error) || attempt >= 2) throw error;
      attempt += 1;
      const retryAfterMs = Math.max(250, getPlannerRetryAfterMs(error) ?? 500 * (2 ** (attempt - 1)));
      context.callbacks?.onRateLimited?.(attempt, retryAfterMs);
      await delayWithAbort(context, retryAfterMs);
    }
  }
}

async function fetchSnapshot(context: TaskRunnerContext): Promise<PageSnapshot> {
  const response = await context.sendTabMessage<{ ok?: boolean; snapshot?: PageSnapshot; error?: string }>(context.tabId, { type: "BV_GET_SNAPSHOT" });
  if (!response?.ok || !response.snapshot) throw new Error(response?.error || "Failed to retrieve page snapshot from tab.");
  return response.snapshot;
}

async function executeConfirmedAction(context: TaskRunnerContext, pending: PendingTaskConfirmation): Promise<ExecutionResponse> {
  const freshSnapshot = await fetchSnapshot(context);
  const lang = resolveLanguage(context.languageCode || "en-IN", context.goal);
  const safety = inspectActionSafety(pending.action, freshSnapshot, lang);
  if (!safety.permitted) throw new Error(safety.reason || getUiTranslation("The confirmed action could not be completed.", lang));
  return context.sendTabMessage<ExecutionResponse>(context.tabId, { type: "BV_EXECUTE_ACTION", action: pending.action });
}

async function runLoop(context: TaskRunnerContext, initialSnapshot?: PageSnapshot): Promise<TaskRunnerResult> {
  const lang = resolveLanguage(context.languageCode || "en-IN", context.goal);
  let currentSnapshot = initialSnapshot || await fetchSnapshot(context);
  let lastSuccessfulRepeatableAction: string | null = null;
  let lastSkippedRepeatedAction: string | null = null;
  let refreshedAfterStaleElement = false;

  for (let stepNumber = context.steps.length + 1; stepNumber <= context.maxSteps; stepNumber += 1) {
    if (isAborted(context)) return { status: "stopped", context };
    const stepLabel = getUiTranslation("Step", lang, "चरण");
    const planningLabel = getUiTranslation("Planning next action...", lang, "अगली कार्रवाई की योजना बन रही है...");
    emitStatus(context, "running", `${stepLabel} ${stepNumber}: ${planningLabel}`);

    let action = await planWithRetry(context, currentSnapshot);
    const validation = validatePlannerAction(action);
    if (!validation.valid) throw new Error(validation.error);
    action = validation.action;

    if (action.action === "done" && isPaymentIntent(context.goal) && !hasPaymentReceipt(currentSnapshot.summary)) {
      const continueToPayment = currentSnapshot.interactiveElements.find((element) =>
        (element.tag === "button" || element.role === "button") &&
        /continue.{0,30}payment|proceed.{0,20}pay|भुगतान.{0,20}(?:आगे|जारी)/i.test(element.label),
      );
      action = continueToPayment && !hasVisiblePaymentForm(currentSnapshot)
        ? { action: "click", id: continueToPayment.id, rationale: "Opening the payment page; payment is not complete yet." }
        : { action: "ask_user", question: hasVisiblePaymentForm(currentSnapshot)
          ? "भुगतान फ़ॉर्म खुला है। कार्ड, UPI या अन्य गोपनीय जानकारी आप स्वयं भरें। भुगतान करना हो तो राशि जाँचकर पुष्टि करें।"
          : "अभी भुगतान की रसीद दिखाई नहीं दे रही है, इसलिए मैं भुगतान पूरा होने की पुष्टि नहीं कर सकता।", rationale: "भुगतान की पुष्टि के लिए रसीद दिखाई देनी चाहिए।" };
    }

    const key = repeatableActionKey(action);
    if (key && key === lastSuccessfulRepeatableAction) {
      if (key === lastSkippedRepeatedAction) {
        const message = getUiTranslation("I already completed that action, so I stopped before repeating it again.", lang);
        emitStatus(context, "failed", message);
        return { status: "failed", error: message, context };
      }
      lastSkippedRepeatedAction = key;
      const skipMessage = getUiTranslation("I already completed that exact action. I will not repeat it.", lang);
      context.conversation = [...context.conversation, { role: "assistant" as const, content: skipMessage }].slice(-6);
      currentSnapshot = await fetchSnapshot(context);
      stepNumber -= 1;
      continue;
    }

    const safety = inspectActionSafety(action, currentSnapshot, lang);
    if (!safety.permitted) {
      const message = safety.safetyAlertSpeech || getUiTranslation("This field contains sensitive information. Please fill it manually.", lang);
      appendStep(context, { stepNumber, action, status: "blocked", spokenSummary: message, details: safety.reason, timestamp: Date.now() });
      emitStatus(context, "blocked", message);
      await context.callbacks?.onPrompt?.(message, "blocked");
      return { status: "blocked", error: safety.reason, context };
    }

    if (safety.requiresConfirmation) {
      const message = safety.safetyAlertSpeech || getUiTranslation("Do you want to confirm this action? Say yes to continue.", lang);
      context.pendingConfirmation = { action, message, reason: safety.reason, snapshot: currentSnapshot };
      appendStep(context, { stepNumber, action, status: "confirmation_required", spokenSummary: message, details: safety.reason, timestamp: Date.now() });
      emitStatus(context, "waiting_confirmation", message);
      await context.callbacks?.onPrompt?.(message, "confirmation");
      return { status: "waiting_confirmation", context };
    }

    if (action.action === "done") {
      appendStep(context, { stepNumber, action, status: "success", spokenSummary: action.summary, timestamp: Date.now() });
      context.conversation = [...context.conversation, { role: "assistant" as const, content: action.summary }].slice(-6);
      emitStatus(context, "done", action.summary);
      return { status: "done", summary: action.summary, context };
    }

    if (action.action === "ask_user") {
      context.pendingQuestion = action.question;
      context.conversation = [...context.conversation, { role: "assistant" as const, content: action.question }].slice(-6);
      appendStep(context, { stepNumber, action, status: "success", spokenSummary: action.question, timestamp: Date.now() });
      emitStatus(context, "waiting_confirmation", action.question);
      await context.callbacks?.onPrompt?.(action.question, "question");
      return { status: "waiting_confirmation", context };
    }

    const executingLabel = getUiTranslation("Executing", lang, "कार्रवाई हो रही है");
    emitStatus(context, "running", `${stepLabel} ${stepNumber}: ${executingLabel} ${action.action}`);
    let response: ExecutionResponse;
    try {
      response = await context.sendTabMessage<ExecutionResponse>(context.tabId, { type: "BV_EXECUTE_ACTION", action });
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : "Action execution failed." };
    }

    if (!response?.ok || response.result?.success === false) {
      const error = response?.error || response?.result?.error || "Action execution failed.";
      if (/element id \[\d+\] was not found in the current page/i.test(error) && !refreshedAfterStaleElement) {
        refreshedAfterStaleElement = true;
        currentSnapshot = await fetchSnapshot(context);
        stepNumber -= 1;
        continue;
      }
      appendStep(context, { stepNumber, action, status: "failed", details: error, timestamp: Date.now() });
      emitStatus(context, "failed", error);
      return { status: "failed", error, context };
    }

    lastSuccessfulRepeatableAction = key;
    lastSkippedRepeatedAction = null;
    const speech = outcomeSpeech(action, currentSnapshot, lang);
    context.conversation = [...context.conversation, { role: "assistant" as const, content: speech }].slice(-6);
    appendStep(context, { stepNumber, action, status: "success", spokenSummary: speech, timestamp: Date.now() });
    currentSnapshot = response.freshSnapshot || await fetchSnapshot(context);
  }

  const error = getUiTranslation("The maximum of 15 steps has been reached.", lang);
  emitStatus(context, "failed", error);
  return { status: "failed", error, context };
}

export async function runAgentTask(context: TaskRunnerContext): Promise<TaskRunnerResult> {
  if (isAborted(context)) return { status: "stopped", context };
  context.pendingConfirmation = null;
  context.pendingQuestion = null;
  const lang = resolveLanguage(context.languageCode || "en-IN", context.goal);
  emitStatus(context, "running", getUiTranslation("Starting task", lang));
  try {
    await context.sendTabMessage(context.tabId, { type: "BV_ACTIVATE_AGENT", statusText: "Browse Voice active" });
    return await runLoop(context);
  } catch (error) {
    if (isAborted(context)) return { status: "stopped", context };
    const message = error instanceof Error ? error.message : getUiTranslation("Task failed.", lang);
    emitStatus(context, "failed", message);
    return { status: "failed", error: message, context };
  }
}

export async function resumeAgentTask(context: TaskRunnerContext, confirmed: boolean, answer?: string): Promise<TaskRunnerResult> {
  if (isAborted(context)) return { status: "stopped", context };
  const lang = resolveLanguage(context.languageCode || "en-IN", context.goal);
  const pending = context.pendingConfirmation;
  if (pending) {
    context.pendingConfirmation = null;
    if (!confirmed) {
      const message = getUiTranslation("The action was cancelled.", lang);
      emitStatus(context, "failed", message);
      return { status: "failed", error: message, context };
    }
    try {
      emitStatus(context, "running", getUiTranslation("Executing confirmed action", lang));
      const response = await executeConfirmedAction(context, pending);
      if (!response?.ok || response.result?.success === false) throw new Error(response?.error || response?.result?.error || getUiTranslation("The confirmed action could not be completed.", lang));
      const snapshot = response.freshSnapshot || await fetchSnapshot(context);
      const stepNumber = context.steps.length + 1;
      const speech = hasPaymentReceipt(snapshot.summary) ? getUiTranslation("Payment receipt is visible.", lang) : outcomeSpeech(pending.action, pending.snapshot, lang);
      appendStep(context, { stepNumber, action: pending.action, status: "success", spokenSummary: speech, timestamp: Date.now() });
      context.conversation = [...context.conversation, { role: "assistant" as const, content: speech }].slice(-6);
      if (hasPaymentReceipt(snapshot.summary)) {
        emitStatus(context, "done", speech);
        return { status: "done", summary: speech, context };
      }
      return await runLoop(context, snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : getUiTranslation("The confirmed action could not be completed.", lang);
      emitStatus(context, "failed", message);
      return { status: "failed", error: message, context };
    }
  }

  if (context.pendingQuestion) {
    context.pendingQuestion = null;
    if (!answer?.trim()) return { status: "waiting_confirmation", context };
    context.conversation = [...context.conversation, { role: "user" as const, content: answer.trim() }].slice(-6);
    emitStatus(context, "running", getUiTranslation("Continuing task", lang));
    try { return await runLoop(context); } catch (error) {
      const message = error instanceof Error ? error.message : getUiTranslation("Task failed.", lang);
      emitStatus(context, "failed", message);
      return { status: "failed", error: message, context };
    }
  }
  return await runAgentTask(context);
}
