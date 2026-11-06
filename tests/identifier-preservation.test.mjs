import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyFormValue,
  mergeTranscriptsPreservingIdentifiers,
  resolveFormValue,
  setExactTextValue,
} from "../lib/form-values.ts";
import {
  MockRuleBasedPlanner,
  protectPlannerAction,
} from "../lib/planner.ts";

const upiField = {
  id: 1,
  tag: "input",
  role: "input",
  label: "UPI ID",
  type: "text",
  name: "upi_id",
  placeholder: "name@bank",
  value: "",
  isSensitive: false,
};

const emailField = {
  id: 2,
  tag: "input",
  role: "input",
  label: "Email address",
  type: "email",
  name: "email",
  placeholder: "user@example.com",
  value: "",
  isSensitive: false,
};

function snapshot(...interactiveElements) {
  return {
    url: "https://example.test/form",
    title: "Test form",
    summary: "Test form",
    interactiveElements,
    timestamp: Date.now(),
  };
}

test("Hindi conversation preserves an exact English UPI ID", async () => {
  const request = "मेरी UPI ID upi@bank भर दो";
  const decision = resolveFormValue(request, upiField);
  assert.equal(decision.exactValue, "upi@bank");

  const planner = new MockRuleBasedPlanner();
  const action = await planner.plan({ userRequest: request, snapshot: snapshot(upiField), history: [] });
  assert.deepEqual({ action: action.action, id: action.id, text: action.text }, {
    action: "type",
    id: 1,
    text: "upi@bank",
  });
});

test("English conversation preserves the same identifier", () => {
  assert.equal(resolveFormValue("Enter UPI ID upi@bank", upiField).exactValue, "upi@bank");
});

test("English email remains exact during Hindi and Marathi conversations", () => {
  assert.equal(resolveFormValue("कृपया email user@gmail.com डालें", emailField).exactValue, "user@gmail.com");
  assert.equal(resolveFormValue("कृपया email user.name+tag@example.co.in भरा", emailField).exactValue, "user.name+tag@example.co.in");
  assert.equal(resolveFormValue("माझा email user@gmail.com टाका", emailField).exactValue, "user@gmail.com");
});

test("Gnani and browser transcripts merge without rewriting identifiers", () => {
  assert.equal(
    mergeTranscriptsPreservingIdentifiers("मेरी UPI ID यूपीआई एट द रेट बैंक भरें", "upi@bank"),
    "मेरी UPI ID यूपीआई एट द रेट बैंक भरें upi@bank",
  );
  assert.equal(
    mergeTranscriptsPreservingIdentifiers("कृपया email डालें", "user@gmail.com"),
    "कृपया email डालें user@gmail.com",
  );
});

test("Hindi technical terms and mixed-language identifiers are not translated", () => {
  const apiKeyField = { ...upiField, label: "API key", name: "api_key", placeholder: "key" };
  assert.equal(resolveFormValue("API key sk_live-ABC_123 टाका", apiKeyField).exactValue, "sk_live-ABC_123");
  assert.equal(resolveFormValue("website https://Example.com/a_b?q=1 भरें", { label: "Website", type: "url" }).exactValue, "https://Example.com/a_b?q=1");
  assert.equal(classifyFormValue({ label: "Comments" }), "text");
  assert.equal(resolveFormValue("यह सामान्य हिंदी वाक्य है", { label: "Comments" }).requiresExactValue, false);
  assert.equal(resolveFormValue("मेरा mobile +91-98765-43210 डालें", { label: "Mobile number", type: "tel" }).exactValue, "+91-98765-43210");
  assert.equal(resolveFormValue("account ACCT-01_ref टाका", { label: "Account reference" }).exactValue, "ACCT-01_ref");
});

test("A phonetic/non-Latin identifier becomes an explicit repeat request", async () => {
  const request = "मेरी UPI ID यूपीआई एट द रेट बैंक भर दो";
  const planner = new MockRuleBasedPlanner();
  const action = await planner.plan({ userRequest: request, snapshot: snapshot(upiField), history: [] });
  assert.equal(action.action, "ask_user");
  assert.match(action.question, /exact|repeat|original/i);
});

test("The post-planner guard repairs model rewriting and preserves special characters", () => {
  const request = {
    userRequest: "UPI ID user_name-01@bank-1 डालो",
    snapshot: snapshot(upiField),
    history: [],
  };
  const guarded = protectPlannerAction(request, { action: "type", id: 1, text: "यूज़र नेम एट बैंक" });
  assert.equal(guarded.action, "type");
  assert.equal(guarded.text, "user_name-01@bank-1");
});

test("Final DOM value receives exact characters without locale conversion", () => {
  class FakeInput {
    #value = "";
    get value() { return this.#value; }
    set value(value) { this.#value = value; }
  }
  class FakeTextArea extends FakeInput {}
  globalThis.HTMLInputElement = FakeInput;
  globalThis.HTMLTextAreaElement = FakeTextArea;
  const input = new FakeInput();
  setExactTextValue(input, "user_name-01@bank-1");
  assert.equal(input.value, "user_name-01@bank-1");
});
