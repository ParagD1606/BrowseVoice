import test from "node:test";
import assert from "node:assert/strict";

import {
  AutonomousOrchestrator,
  SharedMemoryStore,
  createInitialTaskMemory,
  formatSharedMemoryForWorker,
  resolveDirectNewTabIntent,
} from "../lib/orchestrator.ts";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error("Timed out waiting for orchestrator state.");
}

function page(tabId, summary = `tab-${tabId}`) {
  return {
    url: `https://worker-${tabId}.test/`,
    title: `Worker ${tabId}`,
    summary,
    interactiveElements: [],
    timestamp: Date.now(),
  };
}

class FakeBrowser {
  constructor() {
    this.nextTabId = 20;
    this.tabs = new Map([[10, { id: 10, url: "https://active.test/", title: "Active" }]]);
    this.created = [];
    this.executions = [];
    this.deactivations = [];
    this.inFlightMessages = 0;
    this.maxInFlightMessages = 0;
  }

  async getActiveTab() { return this.tabs.get(10); }
  async getTab(tabId) { return this.tabs.get(tabId); }
  async createTab(options) {
    const tab = { id: this.nextTabId++, url: options.url, title: options.url || "New tab" };
    this.tabs.set(tab.id, tab);
    this.created.push(tab);
    return tab;
  }
  async updateTab(tabId, update) {
    const tab = this.tabs.get(tabId);
    if (!tab) return undefined;
    Object.assign(tab, update);
    return tab;
  }
  async removeTab(tabId) { this.tabs.delete(tabId); }
  async sendMessage(tabId, message) {
    if (!this.tabs.has(tabId)) throw new Error(`Tab ${tabId} is closed.`);
    this.inFlightMessages += 1;
    this.maxInFlightMessages = Math.max(this.maxInFlightMessages, this.inFlightMessages);
    try {
      if (message.type === "BV_GET_SNAPSHOT") {
        await wait(15);
        return { ok: true, snapshot: page(tabId) };
      }
      if (message.type === "BV_EXECUTE_ACTION") {
        await wait(15);
        this.executions.push({ tabId, action: message.action });
        return { ok: true, freshSnapshot: page(tabId, `updated by ${message.action.action}`) };
      }
      if (message.type === "BV_DEACTIVATE_AGENT") {
        this.deactivations.push(tabId);
        return { ok: true };
      }
      return { ok: true };
    } finally {
      this.inFlightMessages -= 1;
    }
  }
}

class SearchBrowser extends FakeBrowser {
  constructor() {
    super();
    this.searchState = new Map();
  }

  async sendMessage(tabId, message) {
    if (!this.tabs.has(tabId)) throw new Error(`Tab ${tabId} is closed.`);
    const state = this.searchState.get(tabId) || { query: "", submitted: false };
    this.searchState.set(tabId, state);
    if (message.type === "BV_GET_SNAPSHOT") {
      return {
        ok: true,
        snapshot: {
          url: this.tabs.get(tabId).url,
          title: state.submitted ? "Search results" : "Search page",
          summary: state.submitted ? `Results for ${state.query}` : "Search page",
          interactiveElements: [
            { id: 1, tag: "input", role: "searchbox", label: "Search", type: "search", value: state.query, isSensitive: false },
            { id: 2, tag: "button", role: "button", label: "Search", isSensitive: false },
          ],
          timestamp: Date.now(),
        },
      };
    }
    if (message.type === "BV_EXECUTE_ACTION") {
      const action = message.action;
      if (action.action === "type") state.query = action.text;
      if (action.action === "click" || action.action === "press_key") {
        state.submitted = true;
        this.tabs.get(tabId).url = `${this.tabs.get(tabId).url}?q=${encodeURIComponent(state.query)}`;
      }
      this.executions.push({ tabId, action });
      return { ok: true, freshSnapshot: (await this.sendMessage(tabId, { type: "BV_GET_SNAPSHOT" })).snapshot };
    }
    return { ok: true };
  }
}

class ParallelPlanner {
  constructor() {
    this.calls = [];
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.callCount = new Map();
  }

  async plan(request) {
    this.calls.push(request);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await wait(15);
    const count = (this.callCount.get(request.userRequest) || 0) + 1;
    this.callCount.set(request.userRequest, count);
    this.inFlight -= 1;
    if (count === 1) return { action: "scroll", direction: "down", amount: 100, rationale: "Inspecting the worker page." };
    return { action: "done", summary: `${request.userRequest} completed`, rationale: "Worker finished." };
  }
}

function makeOrchestrator(browser, planner, persistence = { load: async () => null, save: async () => {} }) {
  return new AutonomousOrchestrator({
    browser,
    persistence,
    createPlanner: () => planner,
  });
}

test("SharedMemoryStore serializes concurrent updates without lost findings", async () => {
  const store = new SharedMemoryStore(createInitialTaskMemory("compare products"));
  await Promise.all([1, 2, 3].map((index) => store.commit(`worker-${index}`, "finding", `finding ${index}`, (state) => {
    state.findings.push({ id: `f-${index}`, workerId: `worker-${index}`, subtaskId: `s-${index}`, title: `Finding ${index}`, content: `value ${index}`, createdAt: Date.now(), version: state.version + 1 });
  })));
  const state = store.snapshot();
  assert.equal(state.version, 3);
  assert.deepEqual(state.findings.map((finding) => finding.id).sort(), ["f-1", "f-2", "f-3"]);
});

test("a direct new-tab request bypasses decomposition and opens exactly one tab", async () => {
  const browser = new FakeBrowser();
  let plannerCalls = 0;
  const orchestrator = new AutonomousOrchestrator({
    browser,
    persistence: { load: async () => null, save: async () => {} },
    createPlanner: () => ({ id: "test", name: "test", async plan() { plannerCalls += 1; return { action: "done", summary: "unexpected" }; } }),
  });
  assert.equal(resolveDirectNewTabIntent("can u open youtube in new tab"), "https://youtube.com/");
  const state = await orchestrator.start("can u open youtube in new tab", {
    decompose: async () => { throw new Error("decomposition must not run"); },
  });
  assert.equal(state.status, "completed");
  assert.equal(state.tabs.length, 1);
  assert.equal(browser.created.length, 1);
  assert.equal(browser.created[0].url, "https://youtube.com/");
  assert.equal(plannerCalls, 0);
});

test("a new task cleans up agent tabs left by a previous terminal task", async () => {
  const browser = new FakeBrowser();
  browser.tabs.set(99, { id: 99, url: "https://stale.example", title: "Stale worker" });
  const previous = createInitialTaskMemory("previous task");
  previous.status = "failed";
  previous.tabs.push({ tabId: 99, workerId: "old-worker", subtaskId: "old-task", createdByAgent: true, status: "active", url: "https://stale.example", lastUpdatedAt: Date.now() });
  const orchestrator = new AutonomousOrchestrator({
    browser,
    persistence: { load: async () => previous, save: async () => {} },
    createPlanner: () => ({ id: "test", name: "test", async plan() { return { action: "done", summary: "unexpected" }; } }),
  });
  await orchestrator.start("open a fresh site in new tab");
  assert.equal(browser.tabs.has(99), false);
  assert.equal(browser.created.length, 1);
});

test("equivalent action-level subtasks merge into one end-to-end workflow per destination", () => {
  const state = createInitialTaskMemory("search the same query on two sources", [
    { id: "one-open", title: "Search on Source One", instruction: "Search on Source One", startUrl: "https://www.one.example" },
    { id: "one-query", title: "Search for lucky man on Source One", instruction: "Search for lucky man on Source One", startUrl: "https://one.example", searchQuery: "lucky man" },
    { id: "two", title: "Search for lucky man on Source Two", instruction: "Search for lucky man on Source Two", startUrl: "https://two.example", searchQuery: "lucky man" },
  ]);
  assert.equal(state.subtasks.length, 2);
  assert.equal(state.subtasks.find((subtask) => subtask.startUrl.includes("one.example")).searchQuery, "lucky man");
});

test("one explicit query in the global objective is shared by workflows that omit it", () => {
  const state = createInitialTaskMemory("open two sources and search lucky man in both", [
    { id: "one", title: "Search on Source One", instruction: "Search on Source One", startUrl: "https://one.example" },
    { id: "two", title: "Search on Source Two", instruction: "Search on Source Two", startUrl: "https://two.example" },
  ]);
  assert.deepEqual(state.subtasks.map((subtask) => subtask.searchQuery), ["lucky man", "lucky man"]);
});

test("three independent subtasks open tabs and execute concurrently", async () => {
  const browser = new FakeBrowser();
  const planner = new ParallelPlanner();
  const orchestrator = makeOrchestrator(browser, planner);
  await orchestrator.start("research three products", {
    activeTabId: 10,
    subtasks: [
      { id: "a", title: "Product A", instruction: "research product A", startUrl: "https://a.test" },
      { id: "b", title: "Product B", instruction: "research product B", startUrl: "https://b.test" },
      { id: "c", title: "Product C", instruction: "research product C", startUrl: "https://c.test" },
    ],
  });
  await waitFor(() => orchestrator.memory.snapshot().status === "completed");
  const state = orchestrator.memory.snapshot();
  assert.equal(state.subtasks.filter((subtask) => subtask.status === "completed").length, 3);
  assert.equal(state.tabs.length, 3);
  assert.equal(browser.created.length, 3);
  assert.ok(browser.maxInFlightMessages > 1, "browser workers must overlap instead of running serially");
  assert.match(state.finalResponse, /Product [ABC]/);
});

test("structured search workflows execute and verify without planner calls", async () => {
  const browser = new SearchBrowser();
  let plannerCalls = 0;
  const orchestrator = new AutonomousOrchestrator({
    browser,
    persistence: { load: async () => null, save: async () => {} },
    createPlanner: () => ({ id: "test", name: "test", async plan() { plannerCalls += 1; return { action: "done", summary: "unexpected planner use" }; } }),
  });
  await orchestrator.start("open two sources and search for lucky man in both", {
    subtasks: [
      { id: "one", title: "Source one search", instruction: "Search for lucky man on source one", startUrl: "https://one.example", searchQuery: "lucky man", expectedOutcome: "Search results visible" },
      { id: "two", title: "Source two search", instruction: "Search for lucky man on source two", startUrl: "https://two.example", searchQuery: "lucky man", expectedOutcome: "Search results visible" },
    ],
  });
  await waitFor(() => orchestrator.memory.snapshot().status === "completed");
  const state = orchestrator.memory.snapshot();
  assert.equal(state.subtasks.length, 2);
  assert.equal(state.subtasks.filter((subtask) => subtask.status === "completed").length, 2);
  assert.equal(browser.created.length, 2);
  assert.equal(plannerCalls, 0);
  assert.equal(browser.executions.filter(({ action }) => action.action === "type").length, 2);
  assert.deepEqual(browser.executions.filter(({ action }) => action.action === "type").map(({ action }) => action.text), ["lucky man", "lucky man"]);
  assert.equal(state.findings.filter((finding) => finding.title.includes("search result")).length, 2);
});

test("planner rate-limit errors are retried centrally without duplicating browser work", async () => {
  const browser = new FakeBrowser();
  let plannerCalls = 0;
  const orchestrator = new AutonomousOrchestrator({
    browser,
    persistence: { load: async () => null, save: async () => {} },
    createPlanner: () => ({ id: "test", name: "test", async plan() {
      plannerCalls += 1;
      if (plannerCalls === 1) throw new Error("LLM API returned 429: retry_after 0.01s");
      return { action: "done", summary: "Recovered and completed." };
    } }),
  });
  await orchestrator.start("inspect one page", { activeTabId: 10, maxLlmRetries: 1, subtasks: [{ id: "one", title: "One", instruction: "inspect one" }] });
  await waitFor(() => orchestrator.memory.snapshot().status === "completed");
  assert.equal(plannerCalls, 2);
  assert.equal(browser.created.length, 0);
  assert.equal(orchestrator.memory.snapshot().tabs.length, 1);
  assert.equal(orchestrator.memory.snapshot().subtasks[0].status, "completed");
});

test("Stop cancels in-flight workers and deactivates every managed tab", async () => {
  const browser = new FakeBrowser();
  let releasePlanner;
  const plannerStarted = new Promise((resolve) => {
    releasePlanner = resolve;
  });
  const planner = {
    async plan() {
      await plannerStarted;
      return { action: "click", targetId: 1, rationale: "Late action must be ignored after Stop." };
    },
  };
  const orchestrator = makeOrchestrator(browser, planner);
  await orchestrator.start("stop the agent", {
    activeTabId: 10,
    subtasks: [{ id: "stop-test", title: "Stop test", instruction: "inspect the page" }],
  });
  await waitFor(() => orchestrator.memory.snapshot().subtasks[0]?.status === "inspecting");

  const stopPromise = orchestrator.stop(false);
  await waitFor(() => orchestrator.memory.snapshot().status === "cancelled");
  releasePlanner();
  await stopPromise;
  await wait(30);

  assert.equal(browser.executions.length, 0, "a planner result that returns after Stop must not execute");
  assert.deepEqual(browser.deactivations, [10]);
  assert.equal(orchestrator.memory.snapshot().subtasks[0].status, "cancelled");
  assert.equal(browser.tabs.has(10), true, "Stop should leave the user's tab open");
});

test("worker findings are visible in the next worker planning request", async () => {
  const browser = new FakeBrowser();
  const planner = new ParallelPlanner();
  const orchestrator = makeOrchestrator(browser, planner);
  await orchestrator.start("compare two products", {
    activeTabId: 10,
    subtasks: [
      { id: "a", title: "A", instruction: "research A" },
      { id: "b", title: "B", instruction: "research B" },
    ],
  });
  await waitFor(() => planner.calls.length >= 2);
  await orchestrator.publishFinding({ id: "live", workerId: "external", subtaskId: "a", title: "Live shared result", content: "shared-insight" });
  await waitFor(() => planner.calls.some((request) => request.sharedMemoryContext?.includes("shared-insight")));
  assert.ok(planner.calls.some((request) => request.sharedMemoryContext.includes("shared-insight")));
});

test("dynamic subtasks create additional tabs while a task is running", async () => {
  const browser = new FakeBrowser();
  const planner = new ParallelPlanner();
  const orchestrator = makeOrchestrator(browser, planner);
  await orchestrator.start("research a source", { activeTabId: 10, subtasks: [{ id: "primary", title: "Primary", instruction: "research primary" }] });
  await orchestrator.addSubtask({ id: "dynamic", title: "Dynamic source", instruction: "research the newly discovered source", startUrl: "https://dynamic.test" });
  await waitFor(() => orchestrator.memory.snapshot().subtasks.some((subtask) => subtask.id === "dynamic" && subtask.status === "completed"));
  assert.ok(orchestrator.memory.snapshot().tabs.some((tab) => tab.subtaskId === "dynamic"));
});

test("open_tab planner action becomes a coordinated child worker", async () => {
  const browser = new FakeBrowser();
  let first = true;
  const planner = { async plan() {
    if (first) {
      first = false;
      return { action: "open_tab", url: "https://child.test", task: "Inspect child source" };
    }
    return { action: "done", summary: "Parent complete" };
  } };
  const orchestrator = makeOrchestrator(browser, planner);
  await orchestrator.start("open a source", { activeTabId: 10, subtasks: [{ id: "parent", title: "Parent", instruction: "open a source" }] });
  await waitFor(() => orchestrator.memory.snapshot().subtasks.some((subtask) => subtask.id.startsWith("parent-child")));
  assert.ok(orchestrator.memory.snapshot().tabs.some((tab) => tab.subtaskId.startsWith("parent-child")));
});

test("worker failures are isolated and recorded", async () => {
  const browser = new FakeBrowser();
  const planner = { async plan(request) {
    if (request.userRequest.includes("broken")) throw new Error("simulated worker failure");
    return { action: "done", summary: "healthy worker complete" };
  } };
  const orchestrator = makeOrchestrator(browser, planner);
  await orchestrator.start("run independent workers", {
    activeTabId: 10,
    subtasks: [
      { id: "broken", title: "Broken", instruction: "broken worker" },
      { id: "healthy", title: "Healthy", instruction: "healthy worker" },
    ],
  });
  await waitFor(() => orchestrator.memory.snapshot().status === "failed");
  const state = orchestrator.memory.snapshot();
  assert.equal(state.subtasks.find((subtask) => subtask.id === "healthy").status, "completed");
  assert.ok(state.errors.some((error) => error.message.includes("simulated worker failure")));
});

test("failed dependencies do not leave downstream workers pending forever", async () => {
  const browser = new FakeBrowser();
  const planner = { async plan(request) {
    if (request.userRequest.includes("broken")) throw new Error("dependency failure");
    return { action: "done", summary: "unexpected execution" };
  } };
  const orchestrator = makeOrchestrator(browser, planner);
  await orchestrator.start("run dependent workers", {
    activeTabId: 10,
    maxRetries: 0,
    subtasks: [
      { id: "broken", title: "Broken", instruction: "broken worker" },
      { id: "dependent", title: "Dependent", instruction: "dependent worker", dependsOn: ["broken"] },
    ],
  });
  await waitFor(() => orchestrator.memory.snapshot().status === "failed");
  const state = orchestrator.memory.snapshot();
  assert.equal(state.subtasks.find((subtask) => subtask.id === "broken").status, "failed");
  assert.equal(state.subtasks.find((subtask) => subtask.id === "dependent").status, "failed");
});

test("manual tab closure is tracked and retried without overwriting other workers", async () => {
  const browser = new FakeBrowser();
  const planner = { async plan() { await wait(100); return { action: "done", summary: "late result" }; } };
  const orchestrator = makeOrchestrator(browser, planner);
  await orchestrator.start("watch a tab", { activeTabId: 10, subtasks: [{ id: "watch", title: "Watch", instruction: "watch page" }] });
  await waitFor(() => orchestrator.memory.snapshot().tabs.length === 1);
  const tabId = orchestrator.memory.snapshot().tabs[0].tabId;
  browser.tabs.delete(tabId);
  await orchestrator.handleTabRemoved(tabId, "User closed the worker tab.");
  const state = orchestrator.memory.snapshot();
  assert.equal(state.tabs[0].status, "closed");
  assert.ok(state.errors.length >= 0);
});

test("worker tab activation switches to the requested managed tab", async () => {
  const browser = new FakeBrowser();
  const planner = new ParallelPlanner();
  const orchestrator = makeOrchestrator(browser, planner);
  await orchestrator.start("inspect two pages", { activeTabId: 10, subtasks: [{ id: "one", title: "One", instruction: "inspect one" }, { id: "two", title: "Two", instruction: "inspect two" }] });
  await waitFor(() => orchestrator.memory.snapshot().tabs.length === 2);
  await orchestrator.activateWorker("two");
  const tab = orchestrator.memory.snapshot().tabs.find((candidate) => candidate.subtaskId === "two");
  assert.equal(browser.tabs.get(tab.tabId).active, true);
});

test("persisted memory restores task state after a new orchestrator instance", async () => {
  let saved = null;
  const persistence = {
    async load() { return saved; },
    async save(state) { saved = state; },
  };
  const first = new SharedMemoryStore(createInitialTaskMemory("resume task"), persistence);
  await first.initialize();
  await first.commit("worker", "finding", "saved finding", (state) => {
    state.status = "running";
    state.findings.push({ id: "persisted", workerId: "worker", subtaskId: "primary", title: "Saved", content: "survives restart", createdAt: Date.now(), version: state.version + 1 });
  });
  const second = new SharedMemoryStore(createInitialTaskMemory("other"), persistence);
  const restored = await second.initialize();
  assert.equal(restored.originalInstruction, "resume task");
  assert.equal(restored.findings[0].content, "survives restart");
});

test("shared memory projection is bounded and includes plan and version", () => {
  const state = createInitialTaskMemory("objective", [{ id: "a", title: "A", instruction: "do A" }]);
  state.version = 7;
  state.findings.push({ id: "f", workerId: "w", subtaskId: "a", title: "Finding", content: "value", createdAt: Date.now(), version: 7 });
  const projection = formatSharedMemoryForWorker(state, "w");
  assert.match(projection, /"memoryVersion": 7/);
  assert.match(projection, /Finding/);
});
