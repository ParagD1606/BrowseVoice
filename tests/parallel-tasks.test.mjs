import assert from "node:assert/strict";
import test from "node:test";
import { buildPlannerPrompt, decomposeRequest, decomposeRequestWithFallback, PLANNER_SYSTEM_PROMPT, shouldCallDecompositionModel } from "../lib/planner.ts";
import { validatePlannerAction } from "../lib/schema.ts";
import { buildGuidance } from "../lib/guidance.ts";
import {
  createTaskRunnerContext,
  runAgentTask,
  resumeAgentTask,
  stopAgentTasks,
  stopAgentTask,
} from "../sidepanel/taskRunner.ts";

const baseSnapshot = {
  url: "https://example.com",
  title: "Example",
  summary: "Search page",
  timestamp: Date.now(),
  interactiveElements: [
    { id: 1, tag: "input", role: "searchbox", label: "Search", type: "search", isSensitive: false },
    { id: 2, tag: "button", role: "button", label: "Search", isSensitive: false },
  ],
};

function fakeTransport() {
  return async (_tabId, message) => {
    if (message.type === "BV_GET_SNAPSHOT") return { ok: true, snapshot: baseSnapshot };
    if (message.type === "BV_EXECUTE_ACTION") return { ok: true, result: { success: true }, freshSnapshot: baseSnapshot };
    return { ok: true };
  };
}

test("mock decomposition handles other-tab wording and keeps each query with its site", async () => {
  const tasks = await decomposeRequest({ provider: "mock" }, "open youtube in one tab and google on other tab and search lucku man in youtube and shinchan in google");
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].startUrl, "https://youtube.com");
  assert.equal(tasks[1].startUrl, "https://google.com");
  assert.match(tasks[0].goal, /lucku man/i);
  assert.match(tasks[1].goal, /shinchan/i);
});

test("mock decomposition handles omitted search verb with in", async () => {
  const tasks = await decomposeRequest({ provider: "mock" }, "search lucku man in youtube and shinchan in google");
  assert.equal(tasks.length, 2);
  assert.match(tasks[0].goal, /lucku man/i);
  assert.doesNotMatch(tasks[0].goal, /shinchan/i);
  assert.match(tasks[1].goal, /shinchan/i);
  assert.doesNotMatch(tasks[1].goal, /lucku man/i);
});

test("mock decomposition splits open youtube and google without a tab cue", async () => {
  const tasks = await decomposeRequest({ provider: "mock" }, "open youtube and google");
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].startUrl, "https://youtube.com");
  assert.equal(tasks[1].startUrl, "https://google.com");
  assert.doesNotMatch(tasks[0].goal, /search/i);
  assert.doesNotMatch(tasks[1].goal, /search/i);
});

test("mock decomposition keeps a single task together and supports Hindi/Hinglish", async () => {
  const single = await decomposeRequest({ provider: "mock" }, "open youtube and search cats");
  assert.equal(single.length, 1);

  const hindi = await decomposeRequest({ provider: "mock" }, "ek tab mein youtube kholo aur dusre tab mein google kholo, youtube par lucku man search karo aur google par shinchan search karo");
  assert.equal(hindi.length, 2);
  assert.match(hindi[0].goal, /lucku man/i);
  assert.match(hindi[1].goal, /shinchan/i);
});

test("runner state is isolated between tasks", async () => {
  const planner = {
    id: "fake",
    name: "Fake",
    async plan(request) {
      return request.history.length === 0
        ? { action: "type", id: 1, text: request.userRequest }
        : { action: "done", summary: request.userRequest };
    },
  };
  const first = createTaskRunnerContext({ tabId: 1, goal: "first", planner, sendTabMessage: fakeTransport() });
  const second = createTaskRunnerContext({ tabId: 2, goal: "second", planner, sendTabMessage: fakeTransport() });
  const [firstResult, secondResult] = await Promise.all([runAgentTask(first), runAgentTask(second)]);
  assert.equal(firstResult.status, "done");
  assert.equal(secondResult.status, "done");
  assert.equal(first.steps.length, 2);
  assert.equal(second.steps.length, 2);
  assert.equal(first.steps[0].action.text, "first");
  assert.equal(second.steps[0].action.text, "second");
  stopAgentTask(first);
  assert.equal(first.stopRequested, true);
  assert.equal(second.stopRequested, false);
});

test("submit clicks require confirmation even when the goal says confirm", async () => {
  const planner = {
    id: "fake",
    name: "Fake",
    async plan() { return { action: "click", id: 3 }; },
  };
  const snapshot = { ...baseSnapshot, interactiveElements: [{ id: 3, tag: "button", role: "button", type: "submit", label: "Confirm payment", isSensitive: false }] };
  const send = async (_tabId, message) => message.type === "BV_GET_SNAPSHOT" ? { ok: true, snapshot } : { ok: true };
  const context = createTaskRunnerContext({ tabId: 3, goal: "confirm payment", planner, sendTabMessage: send });
  const result = await runAgentTask(context);
  assert.equal(result.status, "waiting_confirmation");
  assert.ok(context.pendingConfirmation);
});

test("navigation guard rejects javascript, file, and chrome URLs", () => {
  for (const url of ["javascript:alert(1)", "file:///tmp/test.html", "chrome://settings"]) {
    const result = validatePlannerAction({ action: "navigate", url });
    assert.equal(result.valid, false, url);
  }
  assert.equal(validatePlannerAction({ action: "navigate", url: "https://example.com" }).valid, true);
});

test("press_key is a validated planner action and is included in the planner prompt", () => {
  const action = validatePlannerAction({ action: "press_key", key: "Enter" });
  assert.equal(action.valid, true);
  assert.equal(validatePlannerAction({ action: "press_key", key: "Delete" }).valid, false);
  assert.match(PLANNER_SYSTEM_PROMPT, /press_key/);
});

test("mock planner submits a typed search with Enter", async () => {
  const { MockRuleBasedPlanner } = await import("../lib/planner.ts");
  const planner = new MockRuleBasedPlanner();
  const first = await planner.plan({ userRequest: "search cats", snapshot: baseSnapshot, history: [] });
  assert.equal(first.action, "type");
  const second = await planner.plan({ userRequest: "search cats", snapshot: baseSnapshot, history: [{ stepNumber: 1, action: first, status: "success", timestamp: Date.now() }] });
  assert.deepEqual(second, { action: "press_key", key: "Enter", rationale: "Submitting the search." });
});

test("decomposition is skipped for ordinary single-site requests", () => {
  assert.equal(shouldCallDecompositionModel("search cats on youtube"), false);
  assert.equal(shouldCallDecompositionModel("open youtube in one tab"), true);
  assert.equal(shouldCallDecompositionModel("open amazon and google"), true);
});

test("stopping a runner aborts its controller immediately", () => {
  const planner = { id: "fake", name: "Fake", async plan() { return { action: "done", summary: "done" }; } };
  const first = createTaskRunnerContext({ tabId: 1, goal: "first", planner, sendTabMessage: fakeTransport() });
  const second = createTaskRunnerContext({ tabId: 2, goal: "second", planner, sendTabMessage: fakeTransport() });
  stopAgentTask(first);
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(second.controller.signal.aborted, false);
  stopAgentTasks([first, second]);
  assert.equal(second.controller.signal.aborted, true);
});

test("malformed decomposition JSON falls back to one task and preserves the original request on retry", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "not valid json" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const request = "search lucku man on youtube and shinchan on google";
  try {
    const tasks = await decomposeRequestWithFallback({ provider: "openai-compatible", endpoint: "https://fake.example/v1", apiKey: "test-key", model: "test-model" }, request);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].goal, request);
    assert.equal(requests.length, 2, "initial request plus schema-correction retry");
    assert.match(requests[1].messages[1].content, /search lucku man on youtube and shinchan on google/i);
    assert.match(requests[1].messages[1].content, /Previous output:\s*not valid json/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runner retries stale elements three times, then pauses with guidance", async () => {
  let plans = 0;
  let staleFailures = 0;
  const planner = {
    id: "fake",
    name: "Fake",
    async plan() {
      plans += 1;
      return plans === 5 ? { action: "done", summary: "done" } : { action: "click", id: 1 };
    },
  };
  const send = async (_tabId, message) => {
    if (message.type === "BV_GET_SNAPSHOT") return { ok: true, snapshot: baseSnapshot };
    if (message.type === "BV_EXECUTE_ACTION") {
      if (staleFailures < 3) {
        staleFailures += 1;
        return { ok: false, error: "Element ID [1] was not found in the current page." };
      }
      return { ok: true, result: { success: true }, freshSnapshot: baseSnapshot };
    }
    return { ok: true };
  };
  const context = createTaskRunnerContext({ tabId: 9, goal: "click then finish", planner, sendTabMessage: send });
  const result = await runAgentTask(context);
  assert.equal(result.status, "paused");
  assert.equal(result.context.guidance?.reason, "stale_element");
  assert.equal(staleFailures, 3);
});

test("ask_user is exposed as a question, not a confirmation", async () => {
  const planner = { id: "fake", name: "Fake", async plan() { return { action: "ask_user", question: "What should I search?" }; } };
  const context = createTaskRunnerContext({ tabId: 10, goal: "search something", planner, sendTabMessage: fakeTransport() });
  const result = await runAgentTask(context);
  assert.equal(result.status, "waiting_question");
  assert.equal(context.pendingQuestion, "What should I search?");
  assert.equal(context.pendingConfirmation, null);
});

test("every guidance reason has short English and Hindi guidance", async () => {
  const reasons = ["sensitive_field", "question", "max_steps", "repeated_action", "no_progress", "stale_element", "action_failed", "navigation_blocked", "restricted_page", "no_api_key", "invalid_api_key", "rate_limited", "network_error", "planner_error", "mic_denied", "tab_closed", "load_timeout", "payment_incomplete", "stopped"];
  for (const reason of reasons) {
    const english = buildGuidance(reason, { taskLabel: "Test task", error: "Test error", tried: ["click Search"] });
    const hindi = buildGuidance(reason, { languageCode: "hi-IN", taskLabel: "Test task", error: "Test error", tried: ["click Search"] });
    assert.ok(english.title && english.whatHappened && english.whatToDo.length, reason);
    assert.ok(hindi.title && hindi.whatHappened && hindi.whatToDo.length, `${reason} Hindi`);
    assert.ok(english.actions.length, `${reason} actions`);
  }
});

test("unchanged fingerprints pause before another planner call", async () => {
  let plans = 0;
  const planner = { id: "fake", name: "Fake", async plan() { plans += 1; return { action: "type", id: 1, text: "same" }; } };
  const context = createTaskRunnerContext({ tabId: 11, goal: "make progress", planner, sendTabMessage: fakeTransport() });
  const result = await runAgentTask(context);
  assert.equal(result.status, "paused");
  assert.equal(result.context.guidance?.reason, "no_progress");
  assert.equal(plans, 2);
});

test("A-B-A-B action cycles pause the isolated runner", async () => {
  let plans = 0;
  const planner = {
    id: "fake", name: "Fake", async plan() {
      plans += 1;
      return { action: "click", id: plans % 2 ? 1 : 2 };
    },
  };
  const changingTransport = async (_tabId, message) => {
    if (message.type === "BV_GET_SNAPSHOT") return { ok: true, snapshot: { ...baseSnapshot, summary: `page ${plans}` } };
    if (message.type === "BV_EXECUTE_ACTION") return { ok: true, result: { success: true }, freshSnapshot: { ...baseSnapshot, summary: `page ${plans + 1}` } };
    return { ok: true };
  };
  const context = createTaskRunnerContext({ tabId: 12, goal: "alternate controls", planner, sendTabMessage: changingTransport });
  const result = await runAgentTask(context);
  assert.equal(result.status, "paused");
  assert.equal(result.context.guidance?.reason, "repeated_action");
  assert.equal(plans, 4);
});

test("a user hint resumes the same context and resets stuck counters", async () => {
  let plans = 0;
  const planner = {
    id: "fake", name: "Fake", async plan() {
      plans += 1;
      return plans < 3 ? { action: "type", id: 1, text: "same" } : { action: "done", summary: "completed after hint" };
    },
  };
  let changed = false;
  const transport = async (_tabId, message) => {
    if (message.type === "BV_GET_SNAPSHOT") return { ok: true, snapshot: { ...baseSnapshot, summary: changed ? "changed" : "same" } };
    if (message.type === "BV_EXECUTE_ACTION") return { ok: true, result: { success: true }, freshSnapshot: { ...baseSnapshot, summary: changed ? "changed" : "same" } };
    return { ok: true };
  };
  const context = createTaskRunnerContext({ tabId: 13, goal: "continue after hint", planner, sendTabMessage: transport });
  const paused = await runAgentTask(context);
  assert.equal(paused.status, "paused");
  assert.equal(context.guidance?.reason, "no_progress");
  changed = true;
  const resumed = await resumeAgentTask(context, true, "scroll down");
  assert.equal(resumed.status, "done");
  assert.equal(resumed.context, context);
  assert.equal(context.unchangedFingerprintCount, 0);
  assert.equal(context.staleElementRetries, 0);
});

test("sensitive fields wait for the user and resume without restarting", async () => {
  let plans = 0;
  const planner = { id: "fake", name: "Fake", async plan() { plans += 1; return plans === 1 ? { action: "type", id: 9, text: "secret" } : { action: "done", summary: "field completed" }; } };
  const sensitiveSnapshot = { ...baseSnapshot, interactiveElements: [{ id: 9, tag: "input", role: "textbox", label: "Password", isSensitive: true, sensitiveReason: "Password" }] };
  const transport = async (_tabId, message) => message.type === "BV_GET_SNAPSHOT" ? { ok: true, snapshot: sensitiveSnapshot } : { ok: true, result: { success: true }, freshSnapshot: sensitiveSnapshot };
  const context = createTaskRunnerContext({ tabId: 14, goal: "fill password", planner, sendTabMessage: transport });
  const waiting = await runAgentTask(context);
  assert.equal(waiting.status, "waiting_user");
  const resumed = await resumeAgentTask(context, true, "done");
  assert.equal(resumed.status, "done");
  assert.equal(resumed.context, context);
  assert.equal(plans, 2);
});

test("max steps offers continuation and respects the hard cap", async () => {
  let sequence = 0;
  const planner = { id: "fake", name: "Fake", async plan() { sequence += 1; return { action: "scroll", direction: sequence % 2 ? "down" : "up", amount: sequence }; } };
  const transport = async (_tabId, message) => {
    if (message.type === "BV_GET_SNAPSHOT") return { ok: true, snapshot: { ...baseSnapshot, summary: `page ${sequence}` } };
    if (message.type === "BV_EXECUTE_ACTION") return { ok: true, result: { success: true }, freshSnapshot: { ...baseSnapshot, summary: `page ${sequence + 1}` } };
    return { ok: true };
  };
  const context = createTaskRunnerContext({ tabId: 15, goal: "scroll", planner, sendTabMessage: transport, maxSteps: 1, hardMaxSteps: 3 });
  let result = await runAgentTask(context);
  assert.equal(result.status, "paused");
  assert.equal(context.guidance?.reason, "max_steps");
  assert.equal(context.guidance?.actions[0].kind, "continue_more");
  result = await resumeAgentTask(context, true, "continue");
  assert.equal(result.status, "paused");
  result = await resumeAgentTask(context, true, "continue");
  assert.equal(result.status, "paused");
  assert.equal(context.guidance?.actions[0].kind, "dismiss");
  assert.equal(context.maxSteps, 3);
});

test("a successful action resets consecutive stale retries", async () => {
  let staleFailures = 0;
  let plans = 0;
  const planner = {
    id: "fake", name: "Fake", async plan() {
      plans += 1;
      return plans === 4 ? { action: "done", summary: "recovered" } : { action: "click", id: 1 };
    },
  };
  const transport = async (_tabId, message) => {
    if (message.type === "BV_GET_SNAPSHOT") return { ok: true, snapshot: { ...baseSnapshot, summary: `snapshot ${staleFailures}` } };
    if (message.type === "BV_EXECUTE_ACTION") {
      if (staleFailures < 2) {
        staleFailures += 1;
        return { ok: false, error: "Element ID [1] was not found in the current page." };
      }
      return { ok: true, result: { success: true }, freshSnapshot: { ...baseSnapshot, summary: "recovered" } };
    }
    return { ok: true };
  };
  const context = createTaskRunnerContext({ tabId: 16, goal: "recover stale control", planner, sendTabMessage: transport });
  const result = await runAgentTask(context);
  assert.equal(result.status, "done");
  assert.equal(context.staleElementRetries, 0);
});
