import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveLanguage,
  getUiTranslation,
  UI_TRANSLATIONS,
  ACTION_SPEECH,
  FORM_QUESTION_COPY,
  SAFETY_SPEECH,
  MOCK_PLANNER_COPY,
} from "../lib/i18n.ts";

const ALL_LANGUAGES = [
  "en-IN",
  "hi-IN",
  "ta-IN",
  "te-IN",
  "kn-IN",
  "mr-IN",
  "gu-IN",
  "bn-IN",
  "pa-IN",
  "ml-IN",
];

test("The visible fields are filled translates to all 10 supported languages", () => {
  const key = "The visible fields are filled. Please review the form. I did not submit it.";
  for (const lang of ALL_LANGUAGES) {
    const translation = getUiTranslation(key, lang);
    assert.ok(translation, `Translation missing for ${lang}`);
    if (lang === "en-IN") {
      assert.equal(translation, key);
    } else {
      assert.notEqual(translation, key, `Translation for ${lang} must not be plain English`);
    }
  }
});

test("The supported fields are filled translates to all 10 supported languages", () => {
  const key = "The supported fields are filled. Fill any sensitive, file, or protected fields yourself, then review the form. I did not submit it.";
  for (const lang of ALL_LANGUAGES) {
    const translation = getUiTranslation(key, lang);
    assert.ok(translation, `Translation missing for ${lang}`);
    if (lang === "en-IN") {
      assert.equal(translation, key);
    } else {
      assert.notEqual(translation, key, `Translation for ${lang} must not be plain English`);
    }
  }
});

test("Manual fields notice translates to all 10 supported languages", () => {
  const key = "I will leave sensitive and file fields for you to handle manually.";
  for (const lang of ALL_LANGUAGES) {
    const translation = getUiTranslation(key, lang);
    assert.ok(translation, `Translation missing for ${lang}`);
    if (lang !== "en-IN") {
      assert.notEqual(translation, key);
    }
  }
});

test("resolveLanguage identifies Indic scripts and language codes", () => {
  assert.equal(resolveLanguage("ta-IN"), "ta-IN");
  assert.equal(resolveLanguage("te-IN"), "te-IN");
  assert.equal(resolveLanguage("kn-IN"), "kn-IN");
  assert.equal(resolveLanguage("mr-IN"), "mr-IN");
  assert.equal(resolveLanguage("gu-IN"), "gu-IN");
  assert.equal(resolveLanguage("bn-IN"), "bn-IN");
  assert.equal(resolveLanguage("pa-IN"), "pa-IN");
  assert.equal(resolveLanguage("ml-IN"), "ml-IN");
  assert.equal(resolveLanguage("hi-IN"), "hi-IN");
  assert.equal(resolveLanguage("en-IN"), "en-IN");

  // Auto-detect script
  assert.equal(resolveLanguage("indic-auto", "மின்கட்டணம்"), "ta-IN");
  assert.equal(resolveLanguage("indic-auto", "విద్యుత్ బిల్లు"), "te-IN");
  assert.equal(resolveLanguage("indic-auto", "ವಿದ್ಯುತ್ ಬಿಲ್"), "kn-IN");
  assert.equal(resolveLanguage("indic-auto", "বিদ্যুৎ বিল"), "bn-IN");
  assert.equal(resolveLanguage("indic-auto", "ਬਿਜਲੀ ਦਾ ਬਿੱਲ"), "pa-IN");
  assert.equal(resolveLanguage("indic-auto", "വൈദ്യുതി ബിൽ"), "ml-IN");
  assert.equal(resolveLanguage("indic-auto", "વીજળી બિલ"), "gu-IN");
  assert.equal(resolveLanguage("indic-auto", "बिजली बिल"), "hi-IN");
});

test("SAFETY_SPEECH covers all supported languages", () => {
  for (const lang of ALL_LANGUAGES) {
    const copy = SAFETY_SPEECH[lang];
    assert.ok(copy, `SAFETY_SPEECH missing for ${lang}`);
    assert.ok(copy.sensitiveField.length > 0);
    assert.ok(copy.confirmationRequired.includes("%s"));
    assert.ok(copy.invalidNavigation.length > 0);
  }
});

test("MOCK_PLANNER_COPY covers all supported languages", () => {
  for (const lang of ALL_LANGUAGES) {
    const copy = MOCK_PLANNER_COPY[lang];
    assert.ok(copy, `MOCK_PLANNER_COPY missing for ${lang}`);
    assert.ok(copy.paymentReceiptSummary.length > 0);
    assert.ok(copy.billSummary.includes("₹1,450"));
    assert.ok(copy.paymentFormQuestion.length > 0);
  }
});
