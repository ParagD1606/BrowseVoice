/**
 * Test Suite for Browse Voice: 10 Sample Commands (Hindi / Hinglish / English)
 * and Safety Verification on the BijliSeva Mock Portal.
 *
 * Can be run via:
 *   node --test tests/commands.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validatePlannerAction } from "../lib/schema.ts";
import {
  MockRuleBasedPlanner,
} from "../lib/planner.ts";
import {
  detectSensitiveField,
  inspectActionSafety,
  isStopCommand,
  isConfirmationCommand,
  isCancellationCommand,
} from "../lib/safety.ts";
import { hasPaymentReceipt, isPaymentIntent } from "../lib/payment-state.ts";

// Synthetic initial Page Snapshot of BijliSeva Mock Portal
const MOCK_PORTAL_LOOKUP_SNAPSHOT = {
  url: "http://localhost:3000/",
  title: "BijliSeva - Power Distribution Corporation (Mock)",
  summary: "Quick Electricity Bill Pay | State Electricity Distribution",
  timestamp: Date.now(),
  interactiveElements: [
    {
      id: 1,
      tag: "input",
      role: "input",
      label: "Consumer Number (उपभोक्ता संख्या)",
      type: "text",
      name: "consumer_number",
      placeholder: "e.g. 100234567",
      value: "",
      isSensitive: false,
    },
    {
      id: 2,
      tag: "select",
      role: "select",
      label: "Supply Circle / District",
      value: "delhi-north",
      isSensitive: false,
    },
    {
      id: 3,
      tag: "button",
      role: "button",
      label: "Check Bill / बिल देखें",
      isSensitive: false,
    },
    {
      id: 4,
      tag: "input",
      role: "input",
      label: "Password (पासवर्ड)",
      type: "password",
      name: "password",
      isSensitive: true,
      sensitiveReason: "Password field (input[type=password])",
    },
    {
      id: 5,
      tag: "button",
      role: "button",
      label: "Login / लॉगिन",
      isSensitive: false,
    },
  ],
};

// Snapshot after bill is checked and summary is visible
const MOCK_PORTAL_BILL_SUMMARY_SNAPSHOT = {
  url: "http://localhost:3000/",
  title: "BijliSeva - Power Distribution Corporation (Mock)",
  summary: "Bill Details | Ramesh Kumar | Total Amount Due: ₹1,450.00 | Units: 245 kWh",
  timestamp: Date.now(),
  interactiveElements: [
    {
      id: 1,
      tag: "input",
      role: "input",
      label: "Consumer Number",
      value: "100234567",
      isSensitive: false,
    },
    {
      id: 3,
      tag: "button",
      role: "button",
      label: "Check Bill / बिल देखें",
      isSensitive: false,
    },
    {
      id: 6,
      tag: "button",
      role: "button",
      label: "Proceed to Pay / बिल भरें (₹1,450.00)",
      isSensitive: false,
    },
  ],
};

// Snapshot in payment form
const MOCK_PORTAL_PAYMENT_FORM_SNAPSHOT = {
  url: "http://localhost:3000/",
  title: "BijliSeva - Payment Gateway (Mock)",
  summary: "Payment Gateway | Total Due: ₹1,450.00",
  timestamp: Date.now(),
  interactiveElements: [
    {
      id: 7,
      tag: "input",
      role: "radio",
      label: "UPI Payment",
      isSensitive: false,
    },
    {
      id: 8,
      tag: "input",
      role: "input",
      label: "Card Number",
      type: "text",
      name: "card_number",
      isSensitive: true,
      sensitiveReason: "Card number / CVV field pattern",
    },
    {
      id: 9,
      tag: "input",
      role: "input",
      label: "CVV",
      type: "password",
      name: "cvv",
      isSensitive: true,
      sensitiveReason: "Password field",
    },
    {
      id: 10,
      tag: "button",
      role: "button",
      type: "submit",
      label: "Pay ₹1,450.00 Now / भुगतान करें",
      isSensitive: false,
    },
  ],
};

const planner = new MockRuleBasedPlanner();

test("Command 1: 'bijli bill dekho' (Hinglish) -> prompts to fill consumer number", async () => {
  const action = await planner.plan({
    userRequest: "bijli bill dekho",
    snapshot: MOCK_PORTAL_LOOKUP_SNAPSHOT,
    history: [],
  });

  const validation = validatePlannerAction(action);
  assert.equal(validation.valid, true, "Must be valid JSON schema action");
  assert.equal(action.action, "type");
  assert.equal(action.id, 1);
  assert.equal(action.text, "100234567");
});

test("Command 2: 'mera consumer number 100234567 daalo' (Hinglish) -> types into consumer number field", async () => {
  const action = await planner.plan({
    userRequest: "mera consumer number 100234567 daalo",
    snapshot: MOCK_PORTAL_LOOKUP_SNAPSHOT,
    history: [],
  });

  assert.equal(action.action, "type");
  assert.equal(action.id, 1);
  assert.equal(action.text, "100234567");
});

test("Command 3: 'bill check karo' (Hindi) -> clicks 'Check Bill' button", async () => {
  const snapshotWithFilledValue = {
    ...MOCK_PORTAL_LOOKUP_SNAPSHOT,
    interactiveElements: MOCK_PORTAL_LOOKUP_SNAPSHOT.interactiveElements.map((el) =>
      el.id === 1 ? { ...el, value: "100234567" } : el
    ),
  };

  const action = await planner.plan({
    userRequest: "bill check karo",
    snapshot: snapshotWithFilledValue,
    history: [],
  });

  assert.equal(action.action, "click");
  assert.equal(action.id, 3);
});

test("Command 4: 'bill bharo' (Hindi) -> clicks proceed to pay button", async () => {
  const action = await planner.plan({
    userRequest: "bill bharo",
    snapshot: MOCK_PORTAL_BILL_SUMMARY_SNAPSHOT,
    history: [],
  });

  assert.equal(action.action, "click");
  assert.equal(action.id, 6);
});

test("Command 5: 'pay electricity bill' (English) -> proceeds to payment", async () => {
  const action = await planner.plan({
    userRequest: "pay electricity bill",
    snapshot: MOCK_PORTAL_BILL_SUMMARY_SNAPSHOT,
    history: [],
  });

  assert.equal(action.action, "click");
  assert.equal(action.id, 6);
});

test("Command 6: 'show my pending bills' (English) -> recognizes visible bill and finishes", async () => {
  const action = await planner.plan({
    userRequest: "show my pending bills",
    snapshot: MOCK_PORTAL_BILL_SUMMARY_SNAPSHOT,
    history: [],
  });

  assert.equal(action.action, "done");
  assert.match(action.summary, /₹1,450/);
});

test("Command 7: 'proceed to payment' (English) -> clicks proceed button", async () => {
  const action = await planner.plan({
    userRequest: "proceed to payment",
    snapshot: MOCK_PORTAL_BILL_SUMMARY_SNAPSHOT,
    history: [],
  });

  assert.equal(action.action, "click");
  assert.equal(action.id, 6);
});

test("Command 8: 'ruko' (Hindi Stop Word) -> triggers emergency stop", () => {
  assert.equal(isStopCommand("ruko"), true);
  assert.equal(isStopCommand("ruko ruko"), true);
  assert.equal(isStopCommand("khatam karo"), true);
  assert.equal(isStopCommand("cancel my order on amazon"), false);
  assert.equal(isStopCommand("search bus stop timings"), false);
  assert.equal(isStopCommand("pause the video and open amazon"), false);
  assert.equal(isStopCommand("play bas song on youtube"), false);
});

test("Command 9: 'stop' (English Stop Word) -> triggers emergency stop", () => {
  assert.equal(isStopCommand("stop"), true);
  assert.equal(isStopCommand("stop it"), true);
  assert.equal(isStopCommand("cancel"), true);
});

test("Command 10: 'ha payment confirm karo' (Hindi/Hinglish Confirmation) -> confirms submit payment", async () => {
  assert.equal(isConfirmationCommand("ha payment confirm karo"), true);
  assert.equal(isConfirmationCommand("haan"), true);
  assert.equal(isConfirmationCommand("yes"), true);
  for (const phrase of ["ok", "okay", "sure", "go ahead", "do it", "yeah", "yep", "kar do", "karo", "theek hai", "ठीक है", "सही है", "जी", "हाँ", "हां", "haan ji"]) {
    assert.equal(isConfirmationCommand(phrase), true, phrase);
  }
  assert.equal(isCancellationCommand("no"), true);
  assert.equal(isConfirmationCommand("no, do it"), false);
  assert.equal(isConfirmationCommand("bill bharo"), false, "A payment request is not itself confirmation");

  const action = await planner.plan({
    userRequest: "ha payment confirm karo",
    snapshot: MOCK_PORTAL_PAYMENT_FORM_SNAPSHOT,
    history: [],
  });

  assert.equal(action.action, "click");
  assert.equal(action.id, 10); // Pay ₹1,450.00 Now button

  // Safety inspection on consequential submit button
  const safety = inspectActionSafety(action, MOCK_PORTAL_PAYMENT_FORM_SNAPSHOT);
  assert.equal(safety.permitted, true);
  assert.equal(safety.requiresConfirmation, true, "Consequential payment action MUST require confirmation");
});

test("Payment form hands sensitive details to the user and is not reported complete", async () => {
  const action = await planner.plan({
    userRequest: "bill bharo",
    snapshot: MOCK_PORTAL_PAYMENT_FORM_SNAPSHOT,
    history: [],
  });

  assert.equal(action.action, "handoff_to_user");
  assert.deepEqual(action.ids, [8, 9]);
  assert.match(action.explanation, /enter private payment details yourself/i);
  assert.equal(hasPaymentReceipt(MOCK_PORTAL_PAYMENT_FORM_SNAPSHOT.summary), false);
});

test("payment completion recognizes generic visible receipt evidence", () => {
  assert.equal(hasPaymentReceipt("Payment Successful"), true);
  assert.equal(hasPaymentReceipt("Order confirmed"), true);
  assert.equal(hasPaymentReceipt("Transaction ID: TX-123"), true);
  assert.equal(hasPaymentReceipt("Receipt available"), true);
  assert.equal(hasPaymentReceipt("Payment Gateway | Payment Successful | Visible payment receipt: Transaction ID present."), true);
});

test("payment intent distinguishes form editing from payment completion", () => {
  for (const request of ["complete payment", "complete the payment", "make the payment", "pay now", "buy a laptop", "place order", "भुगतान करो"]) {
    assert.equal(isPaymentIntent(request), true, request);
  }
  for (const request of ["fill the checkout form", "edit the payment form", "check electricity bill"]) {
    assert.equal(isPaymentIntent(request), false, request);
  }
});

test("the latest follow-up is retained when the mock planner handles payment confirmation", async () => {
  const action = await planner.plan({
    userRequest: "bill bharo",
    snapshot: MOCK_PORTAL_PAYMENT_FORM_SNAPSHOT,
    history: [],
    conversation: [
      { role: "user", content: "bill bharo" },
      { role: "assistant", content: "Fill payment details yourself." },
      { role: "user", content: "confirm payment" },
    ],
  });

  assert.equal(action.action, "click");
  assert.equal(action.id, 10);
});

test("Safety Rule Verification: Sensitive Field Typing Blocked", () => {
  // Test password field detection
  const passwordField = detectSensitiveField({ type: "password", name: "pass" });
  assert.equal(passwordField.isSensitive, true);

  // Test CVV / Card detection
  const cardField = detectSensitiveField({ name: "card_number" });
  assert.equal(cardField.isSensitive, true);

  const cvvField = detectSensitiveField({ name: "cvv" });
  assert.equal(cvvField.isSensitive, true);

  // Test Aadhaar detection
  const aadhaarField = detectSensitiveField({ name: "aadhaar_no" });
  assert.equal(aadhaarField.isSensitive, true);

  for (const field of ["pin", "mpin", "upi pin", "otp", "cvv", "card number", "password", "aadhaar", "aadhar"]) {
    assert.equal(detectSensitiveField({ name: field }).isSensitive, true, field);
  }
  for (const field of ["shipping", "spinner", "pincode", "pin code", "postal code", "zip", "shipping address", "mobile number"]) {
    assert.equal(detectSensitiveField({ name: field }).isSensitive, false, field);
  }

  // Safety inspection blocks action if planner attempts to type into sensitive field ID 4 (password)
  const forbiddenTypeAction = { action: "type", id: 4, text: "mySecret123" };
  const safetyResult = inspectActionSafety(forbiddenTypeAction, MOCK_PORTAL_LOOKUP_SNAPSHOT);

  assert.equal(safetyResult.permitted, false, "Typing into password field must be prohibited");
  assert.match(safetyResult.reason, /Safety Block/);
  assert.match(safetyResult.safetyAlertSpeech, /password|OTP|sensitive/i);
});

test("consequential actions require confirmation, including any payment-form button", () => {
  const labels = ["Buy now", "Book now", "Donate", "Delete", "Remove account", "Complete purchase", "Confirm booking", "Authorize", "Apply", "Subscribe", "Unsubscribe", "Proceed to pay", "खरीदें"];
  for (const label of labels) {
    const result = inspectActionSafety({ action: "click", id: 10 }, { ...MOCK_PORTAL_LOOKUP_SNAPSHOT, interactiveElements: [{ id: 10, tag: "button", role: "button", label, isSensitive: false }] });
    assert.equal(result.requiresConfirmation, true, label);
  }
  const ordinaryButtonOnPaymentForm = inspectActionSafety(
    { action: "click", id: 11 },
    { ...MOCK_PORTAL_PAYMENT_FORM_SNAPSHOT, interactiveElements: [...MOCK_PORTAL_PAYMENT_FORM_SNAPSHOT.interactiveElements, { id: 11, tag: "button", role: "button", label: "Help", isSensitive: false }] },
  );
  assert.equal(ordinaryButtonOnPaymentForm.requiresConfirmation, true);
});
