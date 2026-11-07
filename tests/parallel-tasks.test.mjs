import assert from "node:assert/strict";
import test from "node:test";
import { decomposeRequest, decomposeRequestWithFallback } from "../lib/planner.ts";
import { validatePlannerAction } from "../lib/schema.ts";
import {
  createTaskRunnerContext,
  runAgentTask,
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
