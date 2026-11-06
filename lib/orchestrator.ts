/**
 * Shared multi-tab orchestration for Browse Voice.
 *
 * The orchestrator is intentionally browser-API agnostic. The side panel
 * supplies a Chrome adapter, while tests can supply an in-memory adapter. This
 * keeps coordination, persistence, conflict handling, and worker scheduling
 * deterministic and reusable.
 */

import type { LLMConfig, PlannerProvider, StepLogEntry } from "./planner.ts";
import { createPlanner, protectPlannerAction } from "./planner.ts";
import type { PageSnapshot } from "./safety.ts";
import {
  inspectActionSafety,
  isConfirmationCommand,
} from "./safety.ts";
import type { PlannerAction } from "./schema.ts";

export type WorkerStatus = "pending" | "assigned" | "opening_tab" | "navigating" | "inspecting" | "executing" | "waiting" | "verifying" | "retrying" | "completed" | "failed" | "cancelled";
export type OrchestratorStatus = "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export type WorkerWaitReason = "user_input" | "confirmation" | "tab_unavailable";

export interface SubtaskSpec {
  id: string;
  title: string;
  instruction: string;
  startUrl?: string;
  dependsOn?: string[];
  searchQuery?: string;
  expectedOutcome?: string;
}

export interface OrchestratedSubtask extends SubtaskSpec {
  dependsOn: string[];
  status: WorkerStatus;
  workerId?: string;
  tabId?: number;
  attempts: number;
  result?: string;
  error?: string;
  waitReason?: WorkerWaitReason;
  pendingAction?: PlannerAction;
  searchExecuted?: boolean;
  verification?: string;
  currentAction?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface ManagedTabContext {
  tabId: number;
  workerId: string;
  subtaskId: string;
  createdByAgent: boolean;
  status: "opening" | "active" | "closed" | "failed";
  url?: string;
  title?: string;
  lastSnapshotSummary?: string;
  lastAction?: string;
  lastUpdatedAt: number;
}

export interface SharedFinding {
  id: string;
  workerId: string;
  subtaskId: string;
  tabId?: number;
  title: string;
  content: string;
  sourceUrl?: string;
  createdAt: number;
  version: number;
}

export interface SharedObservation {
  id: string;
  workerId: string;
  subtaskId: string;
  tabId?: number;
  summary: string;
  url?: string;
  createdAt: number;
  version: number;
}

export interface MemoryUpdate {
  version: number;
  type: string;
  actor: string;
  summary: string;
  createdAt: number;
}

export interface SharedTaskMemory {
  version: number;
  taskId: string;
  originalInstruction: string;
  objective: string;
  status: OrchestratorStatus;
  subtasks: OrchestratedSubtask[];
  tabs: ManagedTabContext[];
  findings: SharedFinding[];
  observations: SharedObservation[];
  decisions: string[];
  conversation: Array<{ role: "user" | "assistant"; content: string; createdAt: number }>;
  errors: Array<{ actor: string; message: string; retryable: boolean; createdAt: number }>;
  updates: MemoryUpdate[];
  finalResponse?: string;
  updatedAt: number;
}

export interface MemoryPersistence {
  load(): Promise<SharedTaskMemory | null>;
  save(state: SharedTaskMemory): Promise<void>;
}

export interface BrowserTabInfo {
  id: number;
  url?: string;
  title?: string;
  windowId?: number;
  active?: boolean;
}

export interface BrowserTabAdapter {
  getActiveTab(): Promise<BrowserTabInfo | undefined>;
  getTab(tabId: number): Promise<BrowserTabInfo | undefined>;
  createTab(options: { url?: string; active?: boolean; windowId?: number }): Promise<BrowserTabInfo>;
  updateTab(tabId: number, update: { url?: string; active?: boolean }): Promise<BrowserTabInfo | undefined>;
  removeTab(tabId: number): Promise<void>;
  sendMessage<T>(tabId: number, message: Record<string, unknown>): Promise<T>;
}

export interface OrchestratorOptions {
  activeTabId?: number;
  maxConcurrentWorkers?: number;
  maxStepsPerWorker?: number;
  maxRetries?: number;
  maxLlmRetries?: number;
  plannerMinIntervalMs?: number;
  subtasks?: SubtaskSpec[];
  decompose?: (instruction: string) => Promise<SubtaskSpec[]>;
}

export interface OrchestratorDependencies {
  browser: BrowserTabAdapter;
  persistence: MemoryPersistence;
  createPlanner: () => PlannerProvider;
  summarize?: (state: SharedTaskMemory) => Promise<string>;
  now?: () => number;
  onStateChange?: (state: SharedTaskMemory) => void;
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeWebUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function canonicalWebUrl(value: string | undefined): string | undefined {
  const safe = safeWebUrl(value);
  if (!safe) return undefined;
  try {
    const url = new URL(safe);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return safe;
  }
}

function inferUrl(value: string): string | undefined {
  const candidate = value.match(/https?:\/\/[^\s)\]}>,]+/i)?.[0]?.replace(/[.,!?]+$/, "");
  return safeWebUrl(candidate);
}

function destinationFingerprint(spec: SubtaskSpec): string | undefined {
  const url = canonicalWebUrl(spec.startUrl) || canonicalWebUrl(inferUrl(`${spec.title} ${spec.instruction}`));
  if (url) return url;
  const destination = spec.instruction.match(/\b(?:on|at|from)\s+(?:the\s+)?([\p{L}\p{N}][\p{L}\p{N} ._-]*)$/iu)?.[1];
  return destination ? [...normalizedTaskTokens(destination)].sort().join("|") : undefined;
}

function normalizedTaskTokens(value: string): Set<string> {
  const ignored = new Set(["the", "and", "for", "from", "with", "into", "that", "this", "on", "in", "at", "to", "a", "an", "one", "another", "tab", "tabs", "open", "opened", "search", "find", "look", "up"]);
  return new Set((value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((token) => !ignored.has(token)));
}

/** Recovers an explicit search value from a workflow when the decomposer did not fill searchQuery. */
function inferSearchQuery(instruction: string): string | undefined {
  const quoted = instruction.match(/\b(?:search|find|look\s+up|query)\b[^"“”']*["“”']([^"“”']+)["“”']/i)?.[1];
  if (quoted?.trim()) return quoted.trim();
  const beforeDestination = instruction.match(/\b(?:search|find|look\s+up|query)\b(?:\s+(?:for|about))?\s+(.+?)\s+\b(?:on|in|at)\b/i)?.[1];
  if (beforeDestination?.trim()) return beforeDestination.trim().replace(/[.,!?]+$/, "");
  const atEnd = instruction.match(/\b(?:search|find|look\s+up|query)\b(?:\s+(?:for|about))?\s+(.+?)\s*$/i)?.[1];
  if (!atEnd || /^(?:on|in|at)\b/i.test(atEnd.trim())) return undefined;
  return atEnd.trim().replace(/[.,!?]+$/, "") || undefined;
}

function findSearchInput(snapshot: PageSnapshot): PageSnapshot["interactiveElements"][number] | undefined {
  return snapshot.interactiveElements
    .filter((element) => ["input", "textarea"].includes(element.tag) && !element.isSensitive)
    .map((element) => {
      const context = `${element.label} ${element.name || ""} ${element.placeholder || ""} ${element.type || ""} ${element.role}`.toLowerCase();
      const score = Number(element.type === "search") * 10 + Number(/search|query|find|look up|खोज/i.test(context)) * 8 + Number(element.tag === "input") * 2;
      return { element, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.element)[0];
}

function findSearchSubmit(snapshot: PageSnapshot): PageSnapshot["interactiveElements"][number] | undefined {
  return snapshot.interactiveElements
    .filter((element) => element.tag === "button" || element.role === "button" || element.type === "submit")
    .map((element) => {
      const context = `${element.label} ${element.name || ""} ${element.placeholder || ""}`.toLowerCase();
      const score = Number(/search|find|go|submit|enter|खोज/i.test(context)) * 10 + Number(element.type === "submit") * 3;
      return { element, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.element)[0];
}

function isSimpleSearchWorkflow(subtask: OrchestratedSubtask): boolean {
  const text = `${subtask.instruction} ${subtask.expectedOutcome || ""}`;
  return !/\b(compare|collect|extract|summari[sz]e|report|analy[sz]e|list|relevant|price|details)\b/i.test(text);
}

function sameWorkflow(a: SubtaskSpec, b: SubtaskSpec): boolean {
  const firstDestination = destinationFingerprint(a);
  const secondDestination = destinationFingerprint(b);
  if (!firstDestination || !secondDestination || firstDestination !== secondDestination) return false;
  if (a.searchQuery && b.searchQuery && a.searchQuery.trim().toLowerCase() !== b.searchQuery.trim().toLowerCase()) return false;
  const first = normalizedTaskTokens(`${a.title} ${a.instruction}`);
  const second = normalizedTaskTokens(`${b.title} ${b.instruction}`);
  if (!first.size || !second.size) return true;
  return [...first].every((token) => second.has(token)) || [...second].every((token) => first.has(token));
}

/**
 * Resolves an explicit user request to open one website in one new tab.
 * These commands are deterministic browser operations and must not consume an
 * LLM call or be decomposed into multiple workers.
 */
export function resolveDirectNewTabIntent(request: string): string | undefined {
  const normalized = request.trim().replace(/[?!。，。]+$/u, "");
  const match = normalized.match(
    /^(?:(?:can|could|would)\s+(?:you|u)|please|i\s+want\s+you\s+to)?\s*(?:open|launch|visit|go\s+to)\s+(.+?)\s+(?:in|on)\s+(?:a\s+)?(?:new\s+tab|another\s+tab|naye?\s+tab(?:\s+mein)?|नए\s+टैब\s+में)$/iu,
  );
  if (!match) return undefined;

  const target = match[1].trim().replace(/^(?:the|website|site)\s+/i, "").replace(/\s+(?:website|site)$/i, "");
  if (!target) return undefined;
  const directUrl = safeWebUrl(target);
  if (directUrl) return directUrl;
  if (/^(?:www\.)?[^\s/]+\.[a-z]{2,}(?:\/[^\s]*)?$/i.test(target)) return safeWebUrl(`https://${target}`);

  // A bare site name is resolved as its conventional .com domain. This keeps
  // the operation generic without a website-specific task or worker mapping.
  const domain = target.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9.-]/g, "");
  return domain ? safeWebUrl(`https://${domain}.com`) : undefined;
}

function normalizeSubtasks(specs: SubtaskSpec[], instruction: string): SubtaskSpec[] {
  const seen = new Set<string>();
  const normalized = specs.map((spec, index) => {
    const id = String(spec.id || `subtask-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, "-");
    const uniqueId = seen.has(id) ? `${id}-${index + 1}` : id;
    seen.add(uniqueId);
    return {
      id: uniqueId,
      title: String(spec.title || `Worker ${index + 1}`),
      instruction: String(spec.instruction || instruction),
      startUrl: safeWebUrl(spec.startUrl) || inferUrl(String(spec.instruction || "")),
      dependsOn: Array.isArray(spec.dependsOn) ? spec.dependsOn.map(String).filter((dependency) => dependency !== uniqueId) : [],
      searchQuery: typeof spec.searchQuery === "string" && spec.searchQuery.trim() ? spec.searchQuery.trim() : inferSearchQuery(String(spec.instruction || "")),
      expectedOutcome: typeof spec.expectedOutcome === "string" && spec.expectedOutcome.trim() ? spec.expectedOutcome.trim() : undefined,
    };
  });
  const deduplicated: SubtaskSpec[] = [];
  for (const spec of normalized) {
    const signature = [
      canonicalWebUrl(spec.startUrl) || "",
      spec.title.trim().toLowerCase().replace(/\s+/g, " "),
      spec.instruction.trim().toLowerCase().replace(/\s+/g, " "),
    ].join("|");
    const duplicate = deduplicated.find((candidate) => {
      const candidateSignature = [
        canonicalWebUrl(candidate.startUrl) || "",
        candidate.title.trim().toLowerCase().replace(/\s+/g, " "),
        candidate.instruction.trim().toLowerCase().replace(/\s+/g, " "),
      ].join("|");
      return candidateSignature === signature || sameWorkflow(candidate, spec);
    });
    if (!duplicate) {
      deduplicated.push(spec);
    } else {
      // Keep the richer workflow description and preserve any structured
      // search/verification fields from either equivalent model output.
      if (spec.instruction.length > duplicate.instruction.length) duplicate.instruction = spec.instruction;
      if (spec.title.length > duplicate.title.length) duplicate.title = spec.title;
      duplicate.searchQuery ||= spec.searchQuery;
      duplicate.expectedOutcome ||= spec.expectedOutcome;
    }
  }
  const known = new Set(deduplicated.map((spec) => spec.id));
  return deduplicated.map((spec) => ({ ...spec, dependsOn: (spec.dependsOn || []).filter((dependency) => known.has(dependency)) }));
}

export function createInitialTaskMemory(
  instruction: string,
  subtasks: SubtaskSpec[] = [{ id: "primary", title: "Primary task", instruction }],
  now = Date.now(),
): SharedTaskMemory {
  const sharedSearchQuery = inferSearchQuery(instruction);
  const normalizedSpecs = normalizeSubtasks(subtasks, instruction).map((spec) => ({
    ...spec,
    searchQuery: spec.searchQuery || (sharedSearchQuery && /\b(search|find|look\s+up|query)\b/i.test(`${spec.title} ${spec.instruction}`) ? sharedSearchQuery : undefined),
  }));
  return {
    version: 0,
    taskId: createId("task"),
    originalInstruction: instruction,
    objective: instruction,
    status: "idle",
    subtasks: normalizedSpecs.map((spec) => ({
      ...spec,
      dependsOn: spec.dependsOn || [],
      status: "pending",
      attempts: 0,
    })),
    tabs: [],
    findings: [],
    observations: [],
    decisions: [],
    conversation: [{ role: "user", content: instruction, createdAt: now }],
    errors: [],
    updates: [],
    finalResponse: undefined,
    updatedAt: now,
  };
}

/**
 * A serialized state manager. Every mutation is applied to the latest state,
 * then persisted, so concurrent workers cannot overwrite one another.
 */
export class SharedMemoryStore {
  private state: SharedTaskMemory;
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;
  private listeners = new Set<(state: SharedTaskMemory) => void>();
  private readonly persistence?: MemoryPersistence;
  private readonly now: () => number;

  constructor(
    initial: SharedTaskMemory = createInitialTaskMemory(""),
    persistence?: MemoryPersistence,
    now: () => number = Date.now,
  ) {
    this.state = clone(initial);
    this.persistence = persistence;
    this.now = now;
  }

  public async initialize(): Promise<SharedTaskMemory> {
    if (!this.initialized) {
      const persisted = await this.persistence?.load();
      if (persisted) this.state = clone(persisted);
      this.initialized = true;
      this.emit();
    }
    return this.snapshot();
  }

  public snapshot(): SharedTaskMemory {
    return clone(this.state);
  }

  public subscribe(listener: (state: SharedTaskMemory) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  public async replace(nextState: SharedTaskMemory, actor = "orchestrator", type = "state-replaced"): Promise<SharedTaskMemory> {
    return this.commit(actor, type, type, (state) => {
      Object.keys(state).forEach((key) => delete (state as unknown as Record<string, unknown>)[key]);
      Object.assign(state, clone(nextState));
    });
  }

  public async commit(
    actor: string,
    type: string,
    summary: string,
    mutator: (state: SharedTaskMemory) => void,
  ): Promise<SharedTaskMemory> {
    let result: SharedTaskMemory | undefined;
    const run = async () => {
      const next = clone(this.state);
      mutator(next);
      next.version = this.state.version + 1;
      next.updatedAt = this.now();
      next.updates = [...next.updates, {
        version: next.version,
        type,
        actor,
        summary: summary.slice(0, 500),
        createdAt: next.updatedAt,
      }].slice(-200);
      this.state = next;
      await this.persistence?.save(this.snapshot());
      result = this.snapshot();
      this.emit();
    };
    const nextQueue = this.queue.then(run, run);
    this.queue = nextQueue.then(() => undefined, () => undefined);
    await nextQueue;
    return result || this.snapshot();
  }

  private emit(): void {
    const current = this.snapshot();
    this.listeners.forEach((listener) => listener(current));
  }
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b429\b|rate[_ -]?limit|too many requests|tokens? per minute|temporarily unavailable)/i.test(message);
}

function retryAfterMilliseconds(error: unknown, attempt: number): number {
  const message = error instanceof Error ? error.message : String(error);
  const seconds = message.match(/(?:retry[-_ ]after|retry again in|retry_after)[^\d]*(\d+(?:\.\d+)?)/i)?.[1];
  if (seconds) return Math.min(60_000, Math.max(500, Math.ceil(Number(seconds) * 1000) + Math.round(Math.random() * 250)));
  return Math.min(30_000, 1_000 * (2 ** attempt) + Math.round(Math.random() * 250));
}

/** Serializes provider calls and retries only rate-limit failures. */
class LlmRequestScheduler {
  private queue: Promise<void> = Promise.resolve();
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private lastCompletedAt = 0;

  constructor(maxRetries = 2, minIntervalMs = 0) {
    this.maxRetries = Math.max(0, Math.min(5, maxRetries));
    this.minIntervalMs = Math.max(0, Math.min(60_000, minIntervalMs));
  }

  public schedule<T>(operation: () => Promise<T>): Promise<T> {
    let result: T | undefined;
    let failure: unknown;
    const run = async () => {
      for (let attempt = 0; ; attempt += 1) {
        const waitMs = this.minIntervalMs - (Date.now() - this.lastCompletedAt);
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        try {
          result = await operation();
          this.lastCompletedAt = Date.now();
          return;
        } catch (error) {
          failure = error;
          if (!isRateLimitError(error) || attempt >= this.maxRetries) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryAfterMilliseconds(error, attempt)));
        }
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(() => undefined, () => undefined);
    return next.then(() => result as T, () => { throw failure; });
  }
}

export function formatSharedMemoryForWorker(state: SharedTaskMemory, workerId?: string): string {
  return JSON.stringify({
    taskId: state.taskId,
    objective: state.objective,
    currentWorker: workerId,
    plan: state.subtasks.map(({ id, title, status, result, error, tabId, searchQuery, expectedOutcome, verification, currentAction }) => ({ id, title, status, result, error, tabId, searchQuery, expectedOutcome, verification, currentAction })),
    findings: state.findings.slice(-12).map(({ id, workerId: sourceWorker, subtaskId, title, content, sourceUrl, createdAt }) => ({ id, workerId: sourceWorker, subtaskId, title, content: content.slice(0, 500), sourceUrl, createdAt })),
    recentObservations: state.observations.slice(-8).map((observation) => ({ ...observation, summary: observation.summary.slice(0, 500) })),
    decisions: state.decisions.slice(-20),
    errors: state.errors.slice(-20),
    memoryVersion: state.version,
  }, null, 2).slice(0, 6000);
}

const DECOMPOSER_PROMPT = `You are the task decomposer for Browse Voice, a multi-tab browser agent.
Break the user's objective into independent, end-to-end browser workflows.
Each subtask owns one coherent workflow and its tab: opening/navigating, interacting, verifying, and reporting are steps of the same workflow, never separate subtasks.
If the user asks for the same operation on multiple destinations, create exactly one workflow per destination. Never create duplicate or action-only subtasks.
Return JSON only: {"subtasks":[{"id":"stable-id","title":"short title","instruction":"complete workflow instruction","startUrl":"canonical URL when a destination is identified","searchQuery":"exact query when this workflow explicitly searches","expectedOutcome":"verifiable outcome","dependsOn":["other-id"]}]}.
Resolve named destinations to their canonical web URLs when possible; do not create a separate subtask just to open or navigate to a destination.
Use a single subtask when parallel work is not useful. Preserve exact user values, including search queries. Do not invent facts. Do not put credentials or secrets into startUrl. Keep instructions generic and actionable. IDs must be unique.`;

function parseSubtaskResponse(raw: string, instruction: string): SubtaskSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return [{ id: "primary", title: "Primary task", instruction }];
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return [{ id: "primary", title: "Primary task", instruction }]; }
  }
  const rawSubtasks = (parsed && typeof parsed === "object" && Array.isArray((parsed as { subtasks?: unknown }).subtasks))
    ? (parsed as { subtasks: unknown[] }).subtasks
    : [];
  const specs = rawSubtasks.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item, index) => ({
      id: String(item.id || `subtask-${index + 1}`),
      title: String(item.title || `Worker ${index + 1}`),
      instruction: String(item.instruction || instruction),
      startUrl: safeWebUrl(item.startUrl),
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [],
      searchQuery: typeof item.searchQuery === "string" ? item.searchQuery : undefined,
      expectedOutcome: typeof item.expectedOutcome === "string" ? item.expectedOutcome : undefined,
    }));
  return normalizeSubtasks(specs.length ? specs : [{ id: "primary", title: "Primary task", instruction }], instruction);
}

export async function decomposeTask(config: LLMConfig, instruction: string): Promise<SubtaskSpec[]> {
  if (!config.apiKey || config.provider === "mock") return [{ id: "primary", title: "Primary task", instruction }];
  if (config.provider === "gemini") {
    const model = config.model || "gemini-3.8-flash";
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: DECOMPOSER_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: instruction }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: 500 },
      }),
    });
    if (!response.ok) throw new Error(`Task decomposition failed (${response.status}; Retry-After ${response.headers.get("retry-after") || "unknown"}): ${await response.text()}`);
    const data = await response.json();
    const content = data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || "";
    return parseSubtaskResponse(content, instruction);
  }

  const endpoint = (config.endpoint || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model || "gpt-4o-mini",
      messages: [{ role: "system", content: DECOMPOSER_PROMPT }, { role: "user", content: instruction }],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) throw new Error(`Task decomposition failed (${response.status}; Retry-After ${response.headers.get("retry-after") || "unknown"}): ${await response.text()}`);
  const data = await response.json();
  return parseSubtaskResponse(typeof data?.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "", instruction);
}

const SUMMARY_PROMPT = `You are the final response writer for a multi-tab browser task. Summarize only the supplied shared findings and worker results. Be concise but include useful comparisons, source URLs when present, and clearly identify missing or failed work. Do not claim actions or facts that are not in the data. Return plain text, not JSON or markdown fences.`;

export async function summarizeTask(config: LLMConfig, state: SharedTaskMemory): Promise<string> {
  const evidence = JSON.stringify({
    objective: state.objective,
    subtasks: state.subtasks.map(({ title, instruction, status, result, error }) => ({ title, instruction, status, result, error })),
    findings: state.findings.slice(-80).map(({ title, content, sourceUrl, subtaskId }) => ({ title, content, sourceUrl, subtaskId })),
  }, null, 2).slice(0, 10000);
  if (!config.apiKey || config.provider === "mock") {
    const completed = state.subtasks.filter((subtask) => subtask.status === "completed");
    const results = completed.map((subtask) => `${subtask.title}: ${subtask.result || "completed"}`).join("\n");
    return results || "The autonomous task finished without a worker result.";
  }

  if (config.provider === "gemini") {
    const model = config.model || "gemini-3.8-flash";
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SUMMARY_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: evidence }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
      }),
    });
    if (!response.ok) throw new Error(`Task summary failed (${response.status}; Retry-After ${response.headers.get("retry-after") || "unknown"}): ${await response.text()}`);
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
    if (!text) throw new Error("The summary model returned no response.");
    return text;
  }

  const endpoint = (config.endpoint || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model || "gpt-4o-mini",
      messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: evidence }],
      temperature: 0.1,
      max_tokens: 500,
    }),
  });
  if (!response.ok) throw new Error(`Task summary failed (${response.status}; Retry-After ${response.headers.get("retry-after") || "unknown"}): ${await response.text()}`);
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("The summary model returned no response.");
  return text;
}

export class AutonomousOrchestrator {
  public readonly memory: SharedMemoryStore;
  private readonly dependencies: OrchestratorDependencies;
  private readonly now: () => number;
  private maxConcurrentWorkers = 8;
  private maxStepsPerWorker = 20;
  private maxRetries = 2;
  private llmScheduler = new LlmRequestScheduler();
  private readonly activeWorkers = new Set<string>();
  private readonly claimedTabIds = new Set<number>();
  private initialized = false;
  private generation = 0;

  constructor(dependencies: OrchestratorDependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now || Date.now;
    this.memory = new SharedMemoryStore(createInitialTaskMemory(""), dependencies.persistence, this.now);
    this.memory.subscribe((state) => dependencies.onStateChange?.(state));
  }

  public async initialize(): Promise<SharedTaskMemory> {
    if (!this.initialized) {
      await this.memory.initialize();
      this.initialized = true;
    }
    return this.memory.snapshot();
  }

  public async start(instruction: string, options: OrchestratorOptions = {}): Promise<SharedTaskMemory> {
    await this.initialize();
    this.maxConcurrentWorkers = Math.max(1, Math.min(32, Math.round(options.maxConcurrentWorkers || 8)));
    this.maxStepsPerWorker = Math.max(1, Math.min(100, Math.round(options.maxStepsPerWorker || 20)));
    this.maxRetries = Math.max(0, Math.min(5, Math.round(options.maxRetries ?? 2)));
    this.llmScheduler = new LlmRequestScheduler(options.maxLlmRetries ?? 2, options.plannerMinIntervalMs ?? 0);
    const current = this.memory.snapshot();
    if (current.status === "running" || current.status === "waiting") {
      throw new Error("Browse Voice already has an autonomous task in progress.");
    }
    const generation = ++this.generation;
    this.activeWorkers.clear();
    this.claimedTabIds.clear();
    if (["failed", "completed", "cancelled"].includes(current.status)) {
      await Promise.all(current.tabs
        .filter((tab) => tab.createdByAgent && tab.status !== "closed")
        .map((tab) => this.dependencies.browser.removeTab(tab.tabId).catch(() => undefined)));
    }
    const directUrl = resolveDirectNewTabIntent(instruction);
    if (directUrl) return this.openDirectTab(instruction, directUrl);
    let specs = options.subtasks;
    if (!specs) {
      specs = options.decompose
        ? await this.llmScheduler.schedule(() => options.decompose!(instruction))
        : [{ id: "primary", title: "Primary task", instruction }];
    }
    const initial = createInitialTaskMemory(instruction, specs, this.now());
    initial.status = "running";
    await this.memory.replace(initial, "orchestrator", "task-started");
    const startingTabId = options.activeTabId ?? (await this.dependencies.browser.getActiveTab())?.id;
    await this.schedule(startingTabId, generation);
    return this.memory.snapshot();
  }

  /** Completes a deterministic one-tab request without invoking a planner. */
  public async openDirectTab(instruction: string, url: string): Promise<SharedTaskMemory> {
    await this.initialize();
    const directUrl = safeWebUrl(url);
    if (!directUrl) throw new Error("Browse Voice can only open http(s) websites.");
    const current = this.memory.snapshot();
    if (current.status === "running" || current.status === "waiting") {
      throw new Error("Browse Voice already has an autonomous task in progress.");
    }

    const workerId = createId("direct-tab-worker");
    const initial = createInitialTaskMemory(instruction, [{
      id: "direct-open",
      title: "Open tab",
      instruction,
      startUrl: directUrl,
    }], this.now());
    initial.status = "running";
    await this.memory.replace(initial, "orchestrator", "direct-tab-task-started");

    try {
      const tab = await this.dependencies.browser.createTab({ url: directUrl, active: true });
      const completedAt = this.now();
      await this.memory.commit(workerId, "direct-tab-opened", `Opened ${directUrl} in one new tab.`, (state) => {
        const subtask = state.subtasks[0];
        if (subtask) {
          subtask.status = "completed";
          subtask.workerId = workerId;
          subtask.tabId = tab.id;
          subtask.attempts = 1;
          subtask.result = `Opened ${directUrl} in a new tab.`;
          subtask.completedAt = completedAt;
        }
        state.tabs.push({
          tabId: tab.id,
          workerId,
          subtaskId: "direct-open",
          createdByAgent: true,
          status: "active",
          url: tab.url || directUrl,
          title: tab.title,
          lastUpdatedAt: completedAt,
        });
        state.status = "completed";
        state.finalResponse = `Opened ${directUrl} in a new tab.`;
        state.conversation.push({ role: "assistant", content: state.finalResponse, createdAt: completedAt });
      });
    } catch (error) {
      await this.memory.commit("orchestrator", "direct-tab-failed", error instanceof Error ? error.message : "Could not open the new tab.", (state) => {
        const subtask = state.subtasks[0];
        if (subtask) {
          subtask.status = "failed";
          subtask.error = error instanceof Error ? error.message : "Could not open the new tab.";
        }
        state.status = "failed";
        state.errors.push({ actor: "orchestrator", message: error instanceof Error ? error.message : "Could not open the new tab.", retryable: false, createdAt: this.now() });
      });
    }
    return this.memory.snapshot();
  }

  public async recover(options: Pick<OrchestratorOptions, "activeTabId"> = {}): Promise<SharedTaskMemory> {
    await this.initialize();
    const state = this.memory.snapshot();
    if (state.status !== "running" && state.status !== "waiting") return state;
    const generation = ++this.generation;
    this.activeWorkers.clear();
    this.claimedTabIds.clear();
    for (const tab of state.tabs.filter((candidate) => candidate.status === "active" || candidate.status === "opening")) {
      const exists = await this.dependencies.browser.getTab(tab.tabId).catch(() => undefined);
      if (!exists) await this.handleTabRemoved(tab.tabId, "The browser tab was unavailable after recovery.");
    }
    await this.memory.commit("orchestrator", "recovered", "Recovered persisted task state after extension restart.", (next) => {
      next.subtasks.forEach((subtask) => {
        if (!["pending", "completed", "failed", "cancelled", "waiting"].includes(subtask.status)) {
          subtask.status = "pending";
          subtask.attempts += 1;
          subtask.error = "Worker resumed after extension restart.";
        }
      });
      next.status = "running";
    });
    const startingTabId = options.activeTabId ?? (await this.dependencies.browser.getActiveTab())?.id;
    await this.schedule(startingTabId, generation);
    return this.memory.snapshot();
  }

  public async stop(closeAgentTabs = false): Promise<SharedTaskMemory> {
    await this.initialize();
    ++this.generation;
    this.activeWorkers.clear();
    this.claimedTabIds.clear();
    const managedTabs = this.memory.snapshot().tabs.filter((tab) => tab.status !== "closed");
    await this.memory.commit("user", "task-cancelled", "User stopped the autonomous task.", (state) => {
      state.status = "cancelled";
      state.subtasks.forEach((subtask) => {
        if (!["completed", "failed", "cancelled"].includes(subtask.status)) subtask.status = "cancelled";
      });
    });
    await Promise.all(managedTabs.map((tab) => this.dependencies.browser.sendMessage(tab.tabId, { type: "BV_DEACTIVATE_AGENT", sessionId: this.generation }).catch(() => undefined)));
    if (closeAgentTabs) {
      await Promise.all(this.memory.snapshot().tabs.filter((tab) => tab.createdByAgent && tab.status !== "closed").map(async (tab) => {
        await this.dependencies.browser.removeTab(tab.tabId).catch(() => undefined);
        await this.memory.commit("orchestrator", "tab-closed", `Closed agent tab ${tab.tabId}.`, (state) => {
          const tracked = state.tabs.find((candidate) => candidate.tabId === tab.tabId);
          if (tracked) tracked.status = "closed";
        });
      }));
    }
    return this.memory.snapshot();
  }

  public async addSubtask(spec: SubtaskSpec, activeTabId?: number): Promise<SharedTaskMemory> {
    await this.initialize();
    await this.memory.commit("orchestrator", "subtask-added", `Added subtask ${spec.title}.`, (state) => {
      if (!state.subtasks.some((subtask) => subtask.id === spec.id)) {
        const normalized = normalizeSubtasks([spec], state.objective)[0];
        state.subtasks.push({ ...normalized, dependsOn: normalized.dependsOn || [], status: "pending", attempts: 0 });
        if (state.status === "completed" || state.status === "idle") state.status = "running";
      }
    });
    await this.schedule(activeTabId, this.generation);
    return this.memory.snapshot();
  }

  public async publishFinding(input: Omit<SharedFinding, "version" | "createdAt"> & Partial<Pick<SharedFinding, "createdAt">>): Promise<SharedTaskMemory> {
    await this.initialize();
    return this.memory.commit(input.workerId, "finding-published", `${input.title}: ${input.content}`, (state) => {
      state.findings.push({ ...input, createdAt: input.createdAt || this.now(), version: state.version + 1 });
    });
  }

  public async handleUserInput(text: string): Promise<SharedTaskMemory> {
    await this.initialize();
    await this.memory.commit("user", "conversation-updated", "User replied to the autonomous task.", (state) => {
      state.conversation.push({ role: "user", content: text, createdAt: this.now() });
      state.subtasks.forEach((subtask) => {
        if (subtask.status === "waiting" && subtask.waitReason === "user_input") {
          subtask.status = "pending";
          subtask.waitReason = undefined;
        }
      });
      state.status = "running";
    });
    const waitingConfirmation = this.memory.snapshot().subtasks.find((subtask) => subtask.status === "waiting" && subtask.waitReason === "confirmation" && subtask.pendingAction);
    if (waitingConfirmation && isConfirmationCommand(text)) {
      await this.executePendingConfirmation(waitingConfirmation);
    } else if (waitingConfirmation) {
      await this.memory.commit("user", "confirmation-cancelled", "User declined a consequential worker action.", (state) => {
        const subtask = state.subtasks.find((candidate) => candidate.id === waitingConfirmation.id);
        if (subtask) {
          subtask.status = "failed";
          subtask.error = "User declined the required confirmation.";
          subtask.pendingAction = undefined;
          subtask.waitReason = undefined;
        }
      });
    }
    await this.schedule(undefined, this.generation);
    return this.memory.snapshot();
  }

  public async handleTabRemoved(tabId: number, reason = "The tab was closed."): Promise<void> {
    await this.initialize();
    const tracked = this.memory.snapshot().tabs.find((tab) => tab.tabId === tabId);
    if (!tracked) return;
    await this.memory.commit("browser", "tab-removed", reason, (state) => {
      const tab = state.tabs.find((candidate) => candidate.tabId === tabId);
      if (tab) {
        tab.status = "closed";
        tab.lastUpdatedAt = this.now();
      }
      const subtask = state.subtasks.find((candidate) => candidate.id === tracked.subtaskId);
      if (subtask && !["pending", "completed", "failed", "cancelled"].includes(subtask.status)) {
        subtask.status = subtask.attempts < this.maxRetries ? "pending" : "failed";
        subtask.error = reason;
        subtask.waitReason = "tab_unavailable";
      }
    });
    await this.schedule();
  }

  public async activateWorker(workerOrSubtaskId: string): Promise<void> {
    await this.initialize();
    const tab = this.memory.snapshot().tabs.find((candidate) => candidate.workerId === workerOrSubtaskId || candidate.subtaskId === workerOrSubtaskId);
    if (!tab || tab.status === "closed") throw new Error("That worker tab is no longer available.");
    await this.dependencies.browser.updateTab(tab.tabId, { active: true });
    await this.memory.commit("user", "tab-activated", `Switched to ${tab.subtaskId} in tab ${tab.tabId}.`, (state) => {
      state.decisions.push(`User switched to worker ${tab.workerId} in tab ${tab.tabId}.`);
    });
  }

  public async closeWorkerTab(workerOrSubtaskId: string): Promise<void> {
    await this.initialize();
    const tab = this.memory.snapshot().tabs.find((candidate) => candidate.workerId === workerOrSubtaskId || candidate.subtaskId === workerOrSubtaskId);
    if (!tab || tab.status === "closed") return;
    if (tab.createdByAgent) await this.dependencies.browser.removeTab(tab.tabId);
    await this.memory.commit("user", "tab-closed", `Closed worker tab ${tab.tabId}.`, (state) => {
      const tracked = state.tabs.find((candidate) => candidate.tabId === tab.tabId);
      if (tracked) {
        tracked.status = "closed";
        tracked.lastUpdatedAt = this.now();
      }
    });
  }

  private async schedule(activeTabId?: number, generation = this.generation): Promise<void> {
    if (generation !== this.generation) return;
    const state = this.memory.snapshot();
    if (state.status === "cancelled" || state.status === "completed" || state.status === "failed") return;
    const completed = new Set(state.subtasks.filter((subtask) => subtask.status === "completed").map((subtask) => subtask.id));
    const failed = new Set(state.subtasks.filter((subtask) => subtask.status === "failed" || subtask.status === "cancelled").map((subtask) => subtask.id));
    const blocked = state.subtasks.filter((subtask) => subtask.status === "pending" && subtask.dependsOn.some((dependency) => failed.has(dependency)));
    if (blocked.length > 0) {
      await this.memory.commit("orchestrator", "dependency-blocked", `Marked ${blocked.length} dependent worker(s) as failed.`, (next) => {
        next.subtasks.forEach((subtask) => {
          if (subtask.status === "pending" && subtask.dependsOn.some((dependency) => failed.has(dependency))) {
            subtask.status = "failed";
            subtask.error = "A required dependency failed or was cancelled.";
          }
        });
      });
      await this.schedule(activeTabId, generation);
      return;
    }
    const ready = state.subtasks.filter((subtask) => subtask.status === "pending" && subtask.dependsOn.every((dependency) => completed.has(dependency)));
    const available = Math.max(0, this.maxConcurrentWorkers - this.activeWorkers.size);
    ready.slice(0, available).forEach((subtask) => {
      const workerId = subtask.workerId || createId("worker");
      this.activeWorkers.add(workerId);
      void this.launchWorker(subtask.id, workerId, activeTabId, generation);
    });
    if (ready.length === 0 && this.activeWorkers.size === 0) {
      await this.finishIfSettled();
    }
  }

  private async launchWorker(subtaskId: string, workerId: string, activeTabId: number | undefined, generation: number): Promise<void> {
    let tabId: number | undefined;
    try {
      if (generation !== this.generation) return;
      const current = this.memory.snapshot();
      const subtask = current.subtasks.find((candidate) => candidate.id === subtaskId);
      if (!subtask) return;
      const assignedTab = subtask.tabId
        ? current.tabs.find((candidate) => candidate.tabId === subtask.tabId && candidate.status !== "closed")
        : undefined;
      const useActive = !assignedTab && !subtask.startUrl && activeTabId !== undefined && !this.claimedTabIds.has(activeTabId) && !current.tabs.some((tab) => tab.tabId === activeTabId);
      if (useActive) this.claimedTabIds.add(activeTabId);
      const existing = useActive ? await this.dependencies.browser.getTab(activeTabId).catch(() => undefined) : undefined;
      const reusedAssignedTab = assignedTab ? await this.dependencies.browser.getTab(assignedTab.tabId).catch(() => undefined) : undefined;
      const tab = reusedAssignedTab || existing || await this.dependencies.browser.createTab({ url: subtask.startUrl || "about:blank", active: false });
      tabId = tab.id;
      if (generation !== this.generation) {
        if (!reusedAssignedTab && !existing) await this.dependencies.browser.removeTab(tab.id).catch(() => undefined);
        return;
      }
      await this.memory.commit(workerId, "worker-started", `${subtask.title} started in tab ${tabId}.`, (state) => {
        const tracked = state.subtasks.find((candidate) => candidate.id === subtaskId);
        if (tracked) {
          tracked.status = reusedAssignedTab || existing ? "inspecting" : "opening_tab";
          tracked.workerId = workerId;
          tracked.tabId = tabId;
          tracked.attempts += 1;
          tracked.startedAt = this.now();
          tracked.waitReason = undefined;
        }
        const existingContext = state.tabs.find((candidate) => candidate.tabId === tabId);
        if (existingContext) {
          existingContext.workerId = workerId;
          existingContext.subtaskId = subtaskId;
          existingContext.status = "active";
          existingContext.url = tab.url;
          existingContext.title = tab.title;
          existingContext.lastUpdatedAt = this.now();
        } else {
          state.tabs.push({
            tabId: tabId!, workerId, subtaskId, createdByAgent: !existing && !reusedAssignedTab,
            status: "active", url: tab.url, title: tab.title, lastUpdatedAt: this.now(),
          });
        }
      });
      if (subtask.startUrl && canonicalWebUrl(tab.url) !== canonicalWebUrl(subtask.startUrl)) {
        await this.memory.commit(workerId, "worker-navigating", `${subtask.title} navigating to its assigned destination.`, (state) => {
          const tracked = state.subtasks.find((candidate) => candidate.id === subtaskId);
          if (tracked) { tracked.status = "navigating"; tracked.currentAction = `navigate:${subtask.startUrl}`; }
        });
        await this.dependencies.browser.updateTab(tabId, { url: subtask.startUrl });
      }
      await this.runWorker(subtaskId, workerId, tabId, generation);
    } catch (error) {
      if (generation === this.generation) {
        await this.failWorker(subtaskId, error instanceof Error ? error.message : "Worker failed.", true);
      }
    } finally {
      this.activeWorkers.delete(workerId);
      if (generation === this.generation) await this.schedule(activeTabId, generation);
    }
  }

  private async runWorker(subtaskId: string, workerId: string, tabId: number, generation: number): Promise<void> {
    const planner = this.dependencies.createPlanner();
    const history: StepLogEntry[] = [];
    let snapshot: PageSnapshot | undefined;
    for (let step = 1; step <= this.maxStepsPerWorker; step += 1) {
      if (generation !== this.generation) return;
      const state = this.memory.snapshot();
      const subtask = state.subtasks.find((candidate) => candidate.id === subtaskId);
      if (!subtask || subtask.status === "cancelled") return;
      try {
        await this.memory.commit(workerId, "worker-inspecting", `${subtask.title} is inspecting its current page.`, (next) => {
          const current = next.subtasks.find((candidate) => candidate.id === subtaskId);
          if (current) { current.status = "inspecting"; current.currentAction = "observe"; }
        });
        await this.dependencies.browser.sendMessage(tabId, { type: "BV_ACTIVATE_AGENT", statusText: "Observing", sessionId: generation }).catch(() => undefined);
        if (generation !== this.generation) return;
        snapshot = await this.observeTab(tabId, generation);
        await this.memory.commit(workerId, "observation-added", `${subtask.title} observed ${snapshot.title || snapshot.url}.`, (next) => {
          const tab = next.tabs.find((candidate) => candidate.tabId === tabId);
          if (tab) {
            tab.lastSnapshotSummary = snapshot!.summary.slice(0, 800);
            tab.url = snapshot!.url;
            tab.title = snapshot!.title;
            tab.lastUpdatedAt = this.now();
          }
          next.observations.push({
            id: createId("observation"), workerId, subtaskId, tabId,
            summary: snapshot!.summary.slice(0, 1200), url: snapshot!.url,
            createdAt: this.now(), version: next.version + 1,
          });
        });

        const latestSubtask = this.memory.snapshot().subtasks.find((candidate) => candidate.id === subtaskId);
        if (latestSubtask?.searchQuery && !latestSubtask.searchExecuted) {
          const structuredSearch = await this.executeStructuredSearch(latestSubtask, workerId, tabId, snapshot, generation);
          if (structuredSearch?.verified) {
            snapshot = structuredSearch.snapshot;
            if (isSimpleSearchWorkflow(latestSubtask)) {
              await this.completeWorker(subtaskId, workerId, `Verified search for “${latestSubtask.searchQuery}” on ${snapshot.url}.`, snapshot.url, "Search results page or state was observed after submission.");
              return;
            }
          }
        }

        const plannerRequest = {
          userRequest: subtask.instruction,
          snapshot,
          history,
          conversation: state.conversation.slice(-8).map(({ role, content }) => ({ role, content })),
          sharedMemoryContext: formatSharedMemoryForWorker(this.memory.snapshot(), workerId),
        };
        let action = protectPlannerAction(plannerRequest, await this.llmScheduler.schedule(() => planner.plan(plannerRequest)));
        if (generation !== this.generation) return;
        const safety = inspectActionSafety(action, snapshot);
        if (!safety.permitted) {
          await this.failWorker(subtaskId, safety.reason || "Safety policy blocked the worker action.", false);
          return;
        }
        if (action.action === "ask_user") {
          await this.memory.commit(workerId, "worker-waiting", `${subtask.title} needs user input.`, (next) => {
            const current = next.subtasks.find((candidate) => candidate.id === subtaskId);
            if (current) {
              current.status = "waiting";
              current.waitReason = "user_input";
              current.error = action.action === "ask_user" ? action.question : undefined;
            }
            next.status = "waiting";
            next.conversation.push({ role: "assistant", content: action.action === "ask_user" ? action.question : "", createdAt: this.now() });
          });
          return;
        }
        if (safety.requiresConfirmation) {
          await this.memory.commit(workerId, "confirmation-required", `${subtask.title} requires confirmation.`, (next) => {
            const current = next.subtasks.find((candidate) => candidate.id === subtaskId);
            if (current) {
              current.status = "waiting";
              current.waitReason = "confirmation";
              current.pendingAction = action;
              current.error = safety.safetyAlertSpeech || safety.reason;
            }
            next.status = "waiting";
          });
          return;
        }
        if (action.action === "done") {
          await this.completeWorker(subtaskId, workerId, action.summary, snapshot.url);
          return;
        }
        if (action.action === "open_tab") {
          if (!safeWebUrl(action.url)) {
            await this.failWorker(subtaskId, "The worker requested a non-web tab URL, which Browse Voice blocks.", false);
            return;
          }
          const requestedUrl = safeWebUrl(action.url)!;
          const existingTab = this.memory.snapshot().tabs.find((tab) => tab.status !== "closed" && tab.url && safeWebUrl(tab.url) === requestedUrl);
          if (existingTab) {
            await this.memory.commit(workerId, "duplicate-tab-request", `Reused existing managed tab ${existingTab.tabId} instead of opening a duplicate.`, (next) => {
              next.decisions.push(`Worker ${workerId} requested ${requestedUrl}, but tab ${existingTab.tabId} is already managed.`);
            });
            history.push({ stepNumber: step, action, status: "success", spokenSummary: "The requested website is already open in a managed tab.", timestamp: this.now() });
            continue;
          }
          const newSubtaskId = `${subtaskId}-child-${step}`;
          await this.addSubtask({
            id: newSubtaskId,
            title: action.task || `Research opened tab ${step}`,
            instruction: action.task || `Inspect the page opened at ${action.url} and report useful findings for the parent task.`,
            startUrl: requestedUrl,
          }, undefined);
          history.push({ stepNumber: step, action, status: "success", timestamp: this.now() });
          continue;
        }

        if (generation !== this.generation) return;
        let execution: { ok?: boolean; error?: string; freshSnapshot?: PageSnapshot };
        if (action.action === "navigate") {
          if (!safeWebUrl(action.url)) {
            await this.failWorker(subtaskId, "The worker requested a non-web navigation URL, which Browse Voice blocks.", false);
            return;
          }
          await this.dependencies.browser.updateTab(tabId, { url: action.url });
          execution = { ok: true };
        } else {
          execution = await this.dependencies.browser.sendMessage(tabId, { type: "BV_EXECUTE_ACTION", action, sessionId: generation });
        }
        if (!execution?.ok) throw new Error(execution?.error || `Worker action ${action.action} failed.`);
        history.push({ stepNumber: step, action, status: "success", spokenSummary: action.rationale, timestamp: this.now() });
        await this.memory.commit(workerId, "worker-action", `${subtask.title} executed ${action.action}.`, (next) => {
          const tab = next.tabs.find((candidate) => candidate.tabId === tabId);
          if (tab) {
            tab.lastAction = action.action;
            tab.lastUpdatedAt = this.now();
          }
        });
        if (execution.freshSnapshot) snapshot = execution.freshSnapshot;
        if (snapshot?.summary) {
          await this.publishFinding({
            id: `${workerId}-observation-${step}`,
            workerId,
            subtaskId,
            tabId,
            title: `${subtask.title} observation`,
            content: snapshot.summary.slice(0, 1200),
            sourceUrl: snapshot.url,
          });
        }
      } catch (error) {
        if (generation === this.generation) await this.failWorker(subtaskId, error instanceof Error ? error.message : "Worker execution failed.", true);
        return;
      }
    }
    await this.failWorker(subtaskId, `Worker reached the ${this.maxStepsPerWorker}-step limit.`, false);
  }

  private async observeTab(tabId: number, sessionId?: number): Promise<PageSnapshot> {
    let lastError = "Could not observe the worker tab.";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await this.dependencies.browser.sendMessage<{ ok?: boolean; snapshot?: PageSnapshot; error?: string }>(tabId, { type: "BV_GET_SNAPSHOT", sessionId });
        if (response?.ok && response.snapshot) {
          const snapshot = response.snapshot;
          if (attempt === 3 || snapshot.interactiveElements.length > 0 || !/^about:blank$|^chrome:\/\//i.test(snapshot.url)) return snapshot;
        } else {
          lastError = response?.error || lastError;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : lastError;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    throw new Error(lastError);
  }

  private async executeStructuredSearch(
    subtask: OrchestratedSubtask,
    workerId: string,
    tabId: number,
    before: PageSnapshot,
    sessionId: number,
  ): Promise<{ snapshot: PageSnapshot; verified: boolean } | undefined> {
    const query = subtask.searchQuery?.trim();
    if (!query) return undefined;
    const searchInput = findSearchInput(before);
    if (!searchInput) return undefined;

    const typeAction: PlannerAction = { action: "type", id: searchInput.id, text: query, rationale: "Entering the requested search query." };
    const safety = inspectActionSafety(typeAction, before);
    if (!safety.permitted) throw new Error(safety.reason || "Search input was blocked by safety policy.");
    await this.memory.commit(workerId, "search-executing", `${subtask.title} is entering the requested search query.`, (next) => {
      const current = next.subtasks.find((candidate) => candidate.id === subtask.id);
      if (current) { current.status = "executing"; current.currentAction = "type-search-query"; }
    });
    const typed = await this.dependencies.browser.sendMessage<{ ok?: boolean; error?: string; freshSnapshot?: PageSnapshot }>(tabId, { type: "BV_EXECUTE_ACTION", action: typeAction, sessionId });
    if (!typed?.ok) throw new Error(typed?.error || "Could not enter the search query.");
    let afterType = typed.freshSnapshot || await this.observeTab(tabId, sessionId);
    const currentSearchInput = findSearchInput(afterType) || searchInput;
    const submit = findSearchSubmit(afterType);
    const submitAction: PlannerAction = submit
      ? { action: "click", id: submit.id, rationale: "Submitting the requested search." }
      : { action: "press_key", id: currentSearchInput.id, key: "Enter", rationale: "Submitting the requested search." };
    const submitSafety = inspectActionSafety(submitAction, afterType);
    if (!submitSafety.permitted) throw new Error(submitSafety.reason || "Search submission was blocked by safety policy.");
    const submitted = await this.dependencies.browser.sendMessage<{ ok?: boolean; error?: string; freshSnapshot?: PageSnapshot }>(tabId, { type: "BV_EXECUTE_ACTION", action: submitAction, sessionId });
    if (!submitted?.ok) throw new Error(submitted?.error || "Could not submit the search query.");
    let afterSubmit = submitted.freshSnapshot || await this.observeTab(tabId, sessionId);
    const normalizedQuery = query.toLowerCase();
    const hasVerifiedSearchState = (candidate: PageSnapshot) => {
      const inputStillContainsQuery = candidate.interactiveElements.some((element) =>
        [searchInput.id, currentSearchInput.id].includes(element.id) && (element.value || "").toLowerCase().includes(normalizedQuery)
      );
      const pageContainsQuery = `${candidate.url} ${candidate.title} ${candidate.summary}`.toLowerCase().includes(normalizedQuery);
      const pageChanged = candidate.url !== before.url || candidate.title !== before.title || candidate.summary !== before.summary;
      return pageChanged && (inputStillContainsQuery || pageContainsQuery);
    };
    for (let attempt = 0; attempt < 3 && !hasVerifiedSearchState(afterSubmit); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      afterSubmit = await this.observeTab(tabId, sessionId);
    }
    const verified = hasVerifiedSearchState(afterSubmit);
    await this.memory.commit(workerId, "search-verified", verified ? `${subtask.title} verified the search results.` : `${subtask.title} could not verify the search result state.`, (next) => {
      const current = next.subtasks.find((candidate) => candidate.id === subtask.id);
      if (current) {
        current.status = verified ? "verifying" : "executing";
        current.searchExecuted = verified;
        current.verification = verified ? "Search submission changed the observed page and retained the requested query." : "The query was entered, but the resulting page state could not be verified.";
        current.currentAction = verified ? "search-verified" : "search-needs-planner-verification";
      }
    });
    if (verified) {
      await this.publishFinding({
        id: `${workerId}-search-result`,
        workerId,
        subtaskId: subtask.id,
        tabId,
        title: `${subtask.title} search result`,
        content: afterSubmit.summary.slice(0, 1200) || `Search results loaded for “${query}”.`,
        sourceUrl: afterSubmit.url,
      });
    }
    return { snapshot: afterSubmit, verified };
  }

  private async executePendingConfirmation(subtask: OrchestratedSubtask): Promise<void> {
    if (!subtask.tabId || !subtask.pendingAction) return;
    try {
      const response = await this.dependencies.browser.sendMessage<{ ok?: boolean; error?: string; freshSnapshot?: PageSnapshot }>(subtask.tabId, { type: "BV_EXECUTE_ACTION", action: subtask.pendingAction });
      if (!response?.ok) throw new Error(response?.error || "Confirmed action failed.");
      await this.memory.commit(subtask.workerId || "orchestrator", "confirmation-completed", `${subtask.title} completed its confirmed action.`, (state) => {
        const current = state.subtasks.find((candidate) => candidate.id === subtask.id);
        if (current) {
          current.status = "pending";
          current.pendingAction = undefined;
          current.waitReason = undefined;
          current.error = undefined;
        }
        state.status = "running";
      });
    } catch (error) {
      await this.failWorker(subtask.id, error instanceof Error ? error.message : "Confirmed action failed.", false);
    }
  }

  private async completeWorker(subtaskId: string, workerId: string, result: string, sourceUrl?: string, verification?: string): Promise<void> {
    await this.memory.commit(workerId, "worker-completed", result, (state) => {
      const subtask = state.subtasks.find((candidate) => candidate.id === subtaskId);
      if (subtask) {
        subtask.status = "completed";
        subtask.result = result;
        subtask.completedAt = this.now();
        subtask.waitReason = undefined;
        subtask.verification = verification || subtask.verification;
      }
      state.findings.push({ id: createId("finding"), workerId, subtaskId, tabId: subtask?.tabId, title: subtask?.title || "Worker result", content: result, sourceUrl, createdAt: this.now(), version: state.version + 1 });
    });
  }

  private async failWorker(subtaskId: string, message: string, retryable: boolean): Promise<void> {
    const current = this.memory.snapshot().subtasks.find((subtask) => subtask.id === subtaskId);
    const shouldRetry = Boolean(current && retryable && current.attempts < this.maxRetries && current.status !== "cancelled");
    await this.memory.commit(current?.workerId || "orchestrator", shouldRetry ? "worker-retry" : "worker-failed", message, (state) => {
      const subtask = state.subtasks.find((candidate) => candidate.id === subtaskId);
      if (subtask) {
        subtask.status = shouldRetry ? "pending" : "failed";
        subtask.error = message;
        subtask.waitReason = undefined;
        subtask.pendingAction = undefined;
      }
      state.errors.push({ actor: current?.workerId || "orchestrator", message, retryable: shouldRetry, createdAt: this.now() });
    });
  }

  private async finishIfSettled(): Promise<void> {
    const state = this.memory.snapshot();
    if (state.subtasks.some((subtask) => !["completed", "failed", "cancelled"].includes(subtask.status))) return;
    const waiting = state.subtasks.some((subtask) => subtask.status === "waiting");
    const finalStatus = waiting ? "waiting" : state.subtasks.some((subtask) => subtask.status === "failed") ? "failed" : "completed";
    await this.memory.commit("orchestrator", waiting ? "task-waiting" : "task-finished", waiting ? "Autonomous task is waiting for user input." : "All autonomous workers finished.", (next) => {
      next.status = finalStatus;
    });
    if (!waiting && !this.memory.snapshot().finalResponse) {
      const finalState = this.memory.snapshot();
      let response = finalState.subtasks
        .filter((subtask) => subtask.result || subtask.error)
        .map((subtask) => `${subtask.title}: ${subtask.result || subtask.error}`)
        .join("\n") || "The autonomous task finished.";
      try {
        const allResultsVerified = finalState.subtasks.length > 0 && finalState.subtasks.every((subtask) => subtask.status !== "completed" || Boolean(subtask.verification));
        if (this.dependencies.summarize && !allResultsVerified) response = await this.llmScheduler.schedule(() => this.dependencies.summarize!(this.memory.snapshot()));
      } catch (error) {
        await this.memory.commit("orchestrator", "summary-failed", error instanceof Error ? error.message : "Could not generate the final task summary.", (next) => {
          next.errors.push({ actor: "orchestrator", message: error instanceof Error ? error.message : "Could not generate the final task summary.", retryable: false, createdAt: this.now() });
        });
      }
      await this.memory.commit("orchestrator", "final-response", "Generated the consolidated task response.", (next) => {
        next.finalResponse = response;
        next.conversation.push({ role: "assistant", content: response, createdAt: this.now() });
      });
    }
  }
}

export function createChromeMemoryPersistence(
  storage: { get(keys: string[]): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> },
  key = "browseVoiceAutonomousTask",
): MemoryPersistence {
  return {
    async load() {
      const result = await storage.get([key]);
      const value = result[key];
      return value && typeof value === "object" ? value as SharedTaskMemory : null;
    },
    async save(state) {
      await storage.set({ [key]: state });
    },
  };
}

export function createDefaultPlannerFactory(config: LLMConfig): () => PlannerProvider {
  return () => createPlanner(config);
}
