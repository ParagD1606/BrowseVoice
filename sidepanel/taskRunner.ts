import {
  getPlannerRetryAfterMs,
  isPlannerRateLimitError,
  type PlannerProvider,
  type StepLogEntry,
} from "../lib/planner.ts";
import { hasPaymentReceipt, hasVisiblePaymentForm, isPaymentIntent } from "../lib/payment-state.ts";
import { inspectActionSafety, type PageSnapshot } from "../lib/safety.ts";
import { validatePlannerAction, type PlannerAction } from "../lib/schema.ts";
import { buildGuidance, type Guidance, type GuidanceReason } from "../lib/guidance.ts";

export type TaskRunnerStatus =
  | "queued"
  | "running"
  | "waiting_confirmation"
  | "waiting_question"
  | "waiting_user"
  | "paused"
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
  onGuidance?: (guidance: Guidance) => Promise<void> | void;
}

export interface TaskRunnerContext {
  readonly tabId: number;
  readonly goal: string;
  readonly planner: PlannerProvider;
  maxSteps: number;
  readonly hardMaxSteps: number;
  readonly controller: AbortController;
  steps: StepLogEntry[];
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  pendingConfirmation: PendingTaskConfirmation | null;
  pendingQuestion: string | null;
  pendingQuestionOptions: string[];
  guidance: Guidance | null;
  unchangedFingerprintCount: number;
  staleElementRetries: number;
  failedActionCounts: Map<string, number>;
  recentActionKeys: string[];
  lastFingerprint: string | null;
  lastExecutedActionKey: string | null;
  lastExecutedBeforeFingerprint: string | null;
  stopRequested: boolean;
  callbacks?: TaskRunnerCallbacks;
  translate?: (english: string, hindi: string) => string;
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
  input: Omit<TaskRunnerContext, "controller" | "steps" | "conversation" | "pendingConfirmation" | "pendingQuestion" | "pendingQuestionOptions" | "guidance" | "unchangedFingerprintCount" | "staleElementRetries" | "failedActionCounts" | "recentActionKeys" | "lastFingerprint" | "lastExecutedActionKey" | "lastExecutedBeforeFingerprint" | "stopRequested" | "maxSteps" | "hardMaxSteps"> & { maxSteps?: number; hardMaxSteps?: number },
): TaskRunnerContext {
  const maxSteps = input.maxSteps ?? 15;
  return {
    ...input,
    maxSteps,
    hardMaxSteps: input.hardMaxSteps ?? 45,
    controller: new AbortController(),
    steps: [],
    conversation: [{ role: "user", content: input.goal }],
    pendingConfirmation: null,
    pendingQuestion: null,
    pendingQuestionOptions: [],
    guidance: null,
    unchangedFingerprintCount: 0,
    staleElementRetries: 0,
    failedActionCounts: new Map(),
    recentActionKeys: [],
    lastFingerprint: null,
    lastExecutedActionKey: null,
    lastExecutedBeforeFingerprint: null,
    stopRequested: false,
  };
}

export function stopAgentTask(context: TaskRunnerContext): void {
  context.stopRequested = true;
  context.controller.abort();
  context.pendingConfirmation = null;
  context.pendingQuestion = null;
  context.pendingQuestionOptions = [];
  context.guidance = null;
  context.pendingQuestionOptions = [];
  const guidance = buildGuidance("stopped", { translate: context.translate });
  context.guidance = guidance;
  void context.callbacks?.onGuidance?.(guidance);
  context.callbacks?.onStatus?.("stopped", "Task stopped");
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

function guidanceContext(context: TaskRunnerContext, extra: Record<string, unknown> = {}) {
  return { taskLabel: context.goal.slice(0, 80), translate: context.translate, ...extra };
}

async function pauseWithGuidance(context: TaskRunnerContext, reason: GuidanceReason, extra: Record<string, unknown> = {}, status: TaskRunnerStatus = "paused"): Promise<TaskRunnerResult> {
  const guidance = buildGuidance(reason, guidanceContext(context, extra));
  context.guidance = guidance;
  emitStatus(context, status, guidance.title);
  await context.callbacks?.onGuidance?.(guidance);
  return { status, error: guidance.whatHappened, context };
}

export function applyTaskGuidance(context: TaskRunnerContext, guidance: Guidance, status: TaskRunnerStatus = "paused"): void {
  context.guidance = guidance;
  emitStatus(context, status, guidance.title);
  void context.callbacks?.onGuidance?.(guidance);
}

function appendStep(context: TaskRunnerContext, entry: StepLogEntry): void {
  context.steps.push(entry);
  context.callbacks?.onStep?.(entry);
}

function outcomeSpeech(action: PlannerAction, snapshot: PageSnapshot): string {
  if (action.action === "click" || action.action === "type" || action.action === "select") {
    const target = snapshot.interactiveElements.find((element) => element.id === action.id);
    const label = target?.label?.trim() || "field";
    if (action.action === "click") return `Clicked ${label}.`;
    if (action.action === "select") return `Updated the ${label} selection.`;
    return `Filled the ${label} field.`;
  }
  if (action.action === "scroll") return `Scrolled ${action.direction}.`;
  if (action.action === "navigate") return "Opened the requested page.";
  return action.action === "done" ? action.summary : action.action === "ask_user" ? action.question : "Action completed.";
}

function actionKey(action: PlannerAction): string {
  return JSON.stringify(action);
}

function repeatableActionIdentity(action: PlannerAction, snapshot: PageSnapshot): { key: string; label: string } | null {
  if (action.action === "click") {
    const target = snapshot.interactiveElements.find((element) => element.id === action.id);
    return { key: `click|${action.id}|${target?.label || ""}|${snapshot.url}`, label: target?.label || "" };
  }
  if (action.action === "navigate") {
    return { key: `navigate|${action.url}|${action.url}|${snapshot.url}`, label: "" };
  }
  return null;
}

function isPaginationLabel(label: string): boolean {
  return /\b(?:next|more|load\s+more|see\s+more|show\s+more|page\s*\d+|older|newer)\b|[›»→]/i.test(label);
}

function rememberExecutedAction(context: TaskRunnerContext, action: PlannerAction, beforeSnapshot: PageSnapshot, beforeFingerprint: string): void {
  const identity = repeatableActionIdentity(action, beforeSnapshot);
  context.lastExecutedActionKey = identity?.key || null;
  context.lastExecutedBeforeFingerprint = identity ? beforeFingerprint : null;
}

function hashFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function snapshotFingerprint(snapshot: PageSnapshot): string {
  const controls = snapshot.interactiveElements.map((element) => {
    const safeState = element.isSensitive
      ? "sensitive"
      : `${element.value || ""}:${element.checked === undefined ? "" : String(element.checked)}:${element.selected || ""}`;
    return `${element.id}:${element.label}:${element.role}:${safeState}`;
  }).join("|");
  const scrollY = Math.round((snapshot.scrollY || 0) / 50) * 50;
  return hashFingerprint(`${snapshot.url}|${snapshot.summary}|${snapshot.scrollHeight || 0}|${scrollY}|${controls}`);
}

function isContinueCommand(text: string): boolean {
  return /^(?:done|ho\s*gaya|ho\s*gya|kar\s*diya|bhar\s*diya|continue|aage\s*badho|ok\s*done|हो\s*गया|आगे\s*बढ़ो)$/i.test(text.trim());
}

function describeAction(action: PlannerAction): string {
  if (action.action === "click") return `click ${action.id}`;
  if (action.action === "type") return `type into ${action.id}`;
  if (action.action === "select") return `select ${action.value}`;
  if (action.action === "navigate") return `open ${action.url}`;
  if (action.action === "scroll") return `scroll ${action.direction}`;
  if (action.action === "press_key") return `press ${action.key}`;
  if (action.action === "ask_user") return "ask a question";
  return "finish the task";
}

function isNetworkError(error: string): boolean {
  return /network|fetch failed|failed to fetch|timed out|timeout|offline|connection/i.test(error);
}

function isInvalidApiKeyError(error: string): boolean {
  return /401|403|invalid.*(?:api|key)|api.*key.*(?:invalid|rejected)|unauthorized/i.test(error);
}

function isStaleElementError(error: string): boolean {
  return /element id \[\d+\] was not found in the current page/i.test(error);
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
        snapshot,
        history: context.steps.slice(-5),
        conversation: context.conversation,
      });
    } catch (error) {
      if (!isPlannerRateLimitError(error) || attempt >= 2) throw error;
      attempt += 1;
      const retryAfterMs = Math.max(250, getPlannerRetryAfterMs(error) ?? 500 * (2 ** (attempt - 1)));
      context.callbacks?.onRateLimited?.(attempt, retryAfterMs);
      let remainingMs = retryAfterMs;
      while (remainingMs > 0 && !isAborted(context)) {
        const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
        emitStatus(context, "running", `Rate limited, retrying in ${seconds} s`);
        const waitMs = Math.min(1000, remainingMs);
        await delayWithAbort(context, waitMs);
        remainingMs -= waitMs;
      }
    }
  }
}

async function fetchSnapshot(context: TaskRunnerContext): Promise<PageSnapshot> {
  const response = await context.sendTabMessage<{ ok?: boolean; snapshot?: PageSnapshot; error?: string }>(context.tabId, { type: "BV_GET_SNAPSHOT" });
  if (!response?.ok || !response.snapshot) throw new Error(response?.error || "Failed to retrieve page snapshot from tab.");
  return response.snapshot;
}

async function executeConfirmedAction(context: TaskRunnerContext, pending: PendingTaskConfirmation): Promise<{ response: ExecutionResponse; beforeSnapshot: PageSnapshot }> {
  const freshSnapshot = await fetchSnapshot(context);
  const safety = inspectActionSafety(pending.action, freshSnapshot);
  if (!safety.permitted) throw new Error(safety.reason || "The confirmed action is no longer safe.");
  return {
    response: await context.sendTabMessage<ExecutionResponse>(context.tabId, { type: "BV_EXECUTE_ACTION", action: pending.action }),
    beforeSnapshot: freshSnapshot,
  };
}

async function runLoop(context: TaskRunnerContext, initialSnapshot?: PageSnapshot): Promise<TaskRunnerResult> {
  let currentSnapshot = initialSnapshot || await fetchSnapshot(context);
  context.lastFingerprint = snapshotFingerprint(currentSnapshot);

  for (let stepNumber = context.steps.length + 1; stepNumber <= context.maxSteps; stepNumber += 1) {
    if (isAborted(context)) return { status: "stopped", context };
    emitStatus(context, "running", `Step ${stepNumber}: planning next action`);

    let action = await planWithRetry(context, currentSnapshot);
    const validation = validatePlannerAction(action);
    if (!validation.valid) throw new Error(validation.error);
    action = validation.action;

    if (action.action === "done" && isPaymentIntent(context.goal) && !hasPaymentReceipt(currentSnapshot.summary)) {
      const continueToPayment = currentSnapshot.interactiveElements.find((element) =>
        (element.tag === "button" || element.role === "button") &&
        /continue.{0,30}payment|proceed.{0,20}pay|भुगतान.{0,20}(?:आगे|जारी)/i.test(element.label),
      );
      if (continueToPayment && !hasVisiblePaymentForm(currentSnapshot)) {
        action = { action: "click", id: continueToPayment.id, rationale: "Opening the payment page; payment is not complete yet." };
      } else {
        return await pauseWithGuidance(context, "payment_incomplete", {
          error: hasVisiblePaymentForm(currentSnapshot)
            ? "The payment form is open, but no receipt is visible yet."
            : "No successful payment receipt is visible yet.",
          pageTitle: currentSnapshot.title,
          pageSummary: currentSnapshot.summary.slice(0, 180),
        }, "waiting_user");
      }
    }

    const repeatIdentity = repeatableActionIdentity(action, currentSnapshot);
    if (repeatIdentity && repeatIdentity.key === context.lastExecutedActionKey) {
      const freshSnapshot = await fetchSnapshot(context);
      const freshFingerprint = snapshotFingerprint(freshSnapshot);
      const pageChanged = context.lastExecutedBeforeFingerprint !== null && context.lastExecutedBeforeFingerprint !== freshFingerprint;
      currentSnapshot = freshSnapshot;
      context.lastFingerprint = freshFingerprint;
      if (!pageChanged || action.action !== "click" || !isPaginationLabel(repeatIdentity.label)) {
        return await pauseWithGuidance(context, "repeated_action", {
          error: pageChanged
            ? "I already did that, but this control is not a pagination control."
            : "I already did that and nothing changed.",
          tried: [describeAction(action)],
          pageTitle: currentSnapshot.title,
          pageSummary: currentSnapshot.summary.slice(0, 180),
        });
      }
    }

    const safety = inspectActionSafety(action, currentSnapshot);
    if (!safety.permitted) {
      const message = safety.safetyAlertSpeech || "This field contains sensitive information. Please fill it manually.";
      appendStep(context, { stepNumber, action, status: "blocked", spokenSummary: message, details: safety.reason, timestamp: Date.now() });
      if (action.action === "type" && safety.targetElement?.isSensitive) {
        await context.sendTabMessage(context.tabId, {
          type: "BV_HIGHLIGHT_MANUAL_FIELDS",
          fields: [{ id: safety.targetElement.id, label: safety.targetElement.label, reason: safety.targetElement.sensitiveReason || "sensitive information" }],
        }).catch(() => undefined);
        return await pauseWithGuidance(context, "sensitive_field", {
          fieldLabel: safety.targetElement.label,
          fieldReason: safety.targetElement.sensitiveReason || "sensitive information",
        }, "waiting_user");
      }
      const reason: GuidanceReason = /navigation/i.test(safety.reason || "") ? "navigation_blocked" : "action_failed";
      return await pauseWithGuidance(context, reason, { error: safety.reason || message }, "blocked");
    }

    if (safety.requiresConfirmation) {
      const message = safety.safetyAlertSpeech || "Do you want to confirm this action? Say yes to continue.";
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
      context.pendingQuestionOptions = action.options || [];
      context.conversation = [...context.conversation, { role: "assistant" as const, content: action.question }].slice(-6);
      appendStep(context, { stepNumber, action, status: "success", spokenSummary: action.question, timestamp: Date.now() });
      await pauseWithGuidance(context, "question", { error: action.question }, "waiting_question");
      await context.callbacks?.onPrompt?.(action.question, "question");
      return { status: "waiting_question", context };
    }

    emitStatus(context, "running", `Step ${stepNumber}: executing ${action.action}`);
    const actionSnapshot = currentSnapshot;
    let response: ExecutionResponse;
    try {
      response = await context.sendTabMessage<ExecutionResponse>(context.tabId, { type: "BV_EXECUTE_ACTION", action });
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : "Action execution failed." };
    }

    if (!response?.ok || response.result?.success === false) {
      const error = response?.error || response?.result?.error || "Action execution failed.";
      const failedKey = actionKey(action);
      const failedCount = (context.failedActionCounts.get(failedKey) || 0) + 1;
      context.failedActionCounts.set(failedKey, failedCount);
      if (isStaleElementError(error)) {
        context.staleElementRetries += 1;
        if (context.staleElementRetries < 3) {
          currentSnapshot = await fetchSnapshot(context);
          stepNumber -= 1;
          continue;
        }
        return await pauseWithGuidance(context, "stale_element", {
          error,
          tried: [describeAction(action)],
          pageTitle: currentSnapshot.title,
          pageSummary: currentSnapshot.summary.slice(0, 180),
        });
      }
      if (failedCount < 2) {
        currentSnapshot = await fetchSnapshot(context);
        stepNumber -= 1;
        continue;
      }
      appendStep(context, { stepNumber, action, status: "failed", details: error, timestamp: Date.now() });
      return await pauseWithGuidance(context, "action_failed", {
        error,
        tried: context.steps.slice(-3).map((step) => describeAction(step.action)).concat(describeAction(action)),
        pageTitle: currentSnapshot.title,
        pageSummary: currentSnapshot.summary.slice(0, 180),
      }, "paused");
    }

    context.staleElementRetries = 0;
    context.failedActionCounts.delete(actionKey(action));
    const speech = outcomeSpeech(action, currentSnapshot);
    context.conversation = [...context.conversation, { role: "assistant" as const, content: speech }].slice(-6);
    appendStep(context, { stepNumber, action, status: "success", spokenSummary: speech, timestamp: Date.now() });
    const beforeFingerprint = context.lastFingerprint;
    currentSnapshot = response.freshSnapshot || await fetchSnapshot(context);
    const afterFingerprint = snapshotFingerprint(currentSnapshot);
    rememberExecutedAction(context, action, actionSnapshot, beforeFingerprint || "");
    context.recentActionKeys = [...context.recentActionKeys, actionKey(action)].slice(-4);
    const countsAsUnchangedAction = action.action === "click" || action.action === "navigate" || action.action === "press_key";
    context.unchangedFingerprintCount = countsAsUnchangedAction && beforeFingerprint === afterFingerprint
      ? context.unchangedFingerprintCount + 1
      : 0;
    context.lastFingerprint = afterFingerprint;
    const recentActions = context.steps.slice(-4).map((step) => step.action);
    const scrollOnlyCycle = recentActions.length === 4 && recentActions.every((recentAction) => recentAction.action === "scroll");
    const lastThreeActions = context.steps.slice(-3).map((step) => step.action);
    const tripleActionKey = lastThreeActions.length === 3 ? actionKey(lastThreeActions[0]) : null;
    const tripleAction = tripleActionKey && lastThreeActions.every((recentAction) => recentAction.action !== "scroll" && recentAction.action !== "type" && actionKey(recentAction) === tripleActionKey);
    if (tripleAction) {
      return await pauseWithGuidance(context, "repeated_action", {
        error: "I already did that three times in a row.",
        tried: lastThreeActions.map((recentAction) => describeAction(recentAction)),
        pageTitle: currentSnapshot.title,
        pageSummary: currentSnapshot.summary.slice(0, 180),
      });
    }
    const cycle = !scrollOnlyCycle && context.recentActionKeys.length === 4 &&
      context.recentActionKeys[0] === context.recentActionKeys[2] &&
      context.recentActionKeys[1] === context.recentActionKeys[3] &&
      context.recentActionKeys[0] !== context.recentActionKeys[1];
    if (cycle) {
      return await pauseWithGuidance(context, "repeated_action", {
        tried: context.steps.slice(-4).map((step) => describeAction(step.action)),
        pageTitle: currentSnapshot.title,
        pageSummary: currentSnapshot.summary.slice(0, 180),
      });
    }
    if (context.unchangedFingerprintCount >= 3) {
      return await pauseWithGuidance(context, "no_progress", {
        tried: context.steps.slice(-3).map((step) => describeAction(step.action)),
        pageTitle: currentSnapshot.title,
        pageSummary: currentSnapshot.summary.slice(0, 180),
      });
    }
  }

  const completed = context.steps.filter((step) => step.status === "success").slice(-2).map((step) => step.spokenSummary || describeAction(step.action)).join("; ");
  const hardCap = context.maxSteps >= context.hardMaxSteps;
  return await pauseWithGuidance(context, "max_steps", {
    completed: completed || "no step is confirmed",
    remaining: context.goal,
    error: hardCap ? "hard-cap" : undefined,
  }, "paused");
}

export async function runAgentTask(context: TaskRunnerContext): Promise<TaskRunnerResult> {
  if (isAborted(context)) return { status: "stopped", context };
  context.pendingConfirmation = null;
  context.pendingQuestion = null;
  emitStatus(context, "running", "Starting task");
  try {
    await context.sendTabMessage(context.tabId, { type: "BV_ACTIVATE_AGENT", statusText: "Browse Voice active" });
    return await runLoop(context);
  } catch (error) {
    if (isAborted(context)) {
      const guidance = buildGuidance("stopped", { translate: context.translate });
      applyTaskGuidance(context, guidance, "stopped");
      return { status: "stopped", context };
    }
    const message = error instanceof Error ? error.message : "Task failed.";
    const reason: GuidanceReason = isPlannerRateLimitError(error)
      ? "rate_limited"
      : isInvalidApiKeyError(message)
        ? "invalid_api_key"
        : isNetworkError(message)
          ? "network_error"
          : /planner|schema|json/i.test(message) ? "planner_error" : "action_failed";
    const result = await pauseWithGuidance(context, reason, { error: message }, "paused");
    return { ...result, error: message };
  }
}

export async function resumeAgentTask(context: TaskRunnerContext, confirmed: boolean, answer?: string): Promise<TaskRunnerResult> {
  if (isAborted(context)) return { status: "stopped", context };
  const pending = context.pendingConfirmation;
  if (pending) {
    context.pendingConfirmation = null;
    if (!confirmed) {
      const message = "The action was cancelled.";
      return await pauseWithGuidance(context, "stopped", { error: message }, "failed");
    }
    try {
      emitStatus(context, "running", "Executing confirmed action");
      const confirmedExecution = await executeConfirmedAction(context, pending);
      const response = confirmedExecution.response;
      if (!response?.ok || response.result?.success === false) throw new Error(response?.error || response?.result?.error || "The confirmed action could not be completed.");
      const snapshot = response.freshSnapshot || await fetchSnapshot(context);
      rememberExecutedAction(context, pending.action, confirmedExecution.beforeSnapshot, snapshotFingerprint(confirmedExecution.beforeSnapshot));
      const stepNumber = context.steps.length + 1;
      const speech = hasPaymentReceipt(snapshot.summary) ? "Payment receipt is visible." : outcomeSpeech(pending.action, pending.snapshot);
      appendStep(context, { stepNumber, action: pending.action, status: "success", spokenSummary: speech, timestamp: Date.now() });
      context.conversation = [...context.conversation, { role: "assistant" as const, content: speech }].slice(-6);
      if (hasPaymentReceipt(snapshot.summary)) {
        emitStatus(context, "done", speech);
        return { status: "done", summary: speech, context };
      }
      return await runLoop(context, snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The confirmed action could not be completed.";
      const result = await pauseWithGuidance(context, "action_failed", { error: message }, "paused");
      return { ...result, error: message };
    }
  }

  if (context.pendingQuestion) {
    if (!answer?.trim()) return { status: "waiting_question", context };
    context.pendingQuestion = null;
    context.pendingQuestionOptions = [];
    context.conversation = [...context.conversation, { role: "user" as const, content: answer.trim() }].slice(-6);
    emitStatus(context, "running", "Continuing task");
    try { return await runLoop(context); } catch (error) {
      const message = error instanceof Error ? error.message : "Task failed.";
      emitStatus(context, "failed", message);
      return { status: "failed", error: message, context };
    }
  }

  if (context.guidance) {
    const hint = answer?.trim() || "";
    if (!hint) return { status: "paused", context };
    if (context.guidance.reason === "max_steps") {
      if (context.maxSteps >= context.hardMaxSteps) return { status: "paused", context };
      if (!confirmed && !isContinueCommand(hint) && hint.toLowerCase() !== "continue") return { status: "paused", context };
      context.maxSteps = Math.min(context.hardMaxSteps, context.maxSteps + 15);
    } else if (context.guidance.reason === "sensitive_field" && !isContinueCommand(hint)) {
      return { status: "waiting_user", context };
    }
    context.conversation = [...context.conversation, { role: "user" as const, content: hint }].slice(-6);
    context.guidance = null;
    context.unchangedFingerprintCount = 0;
    context.staleElementRetries = 0;
    context.failedActionCounts.clear();
    context.recentActionKeys = [];
    context.lastExecutedActionKey = null;
    context.lastExecutedBeforeFingerprint = null;
    try {
      emitStatus(context, "running", "Continuing task");
      return await runLoop(context, await fetchSnapshot(context));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Task failed.";
      const result = await pauseWithGuidance(context, isNetworkError(message) ? "network_error" : "action_failed", { error: message }, "paused");
      return { ...result, error: message };
    }
  }
  return await runAgentTask(context);
}
