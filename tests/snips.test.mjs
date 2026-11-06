import test from "node:test";
import assert from "node:assert/strict";

import { cleanSnippetLines, cleanSnippetText } from "../lib/snips.ts";

test("snippet cleanup removes private-use icon-font glyphs without changing content", () => {
  assert.equal(
    cleanSnippetText("Claude  Navigation  New Ctrl + Shift + O"),
    "Claude Navigation New Ctrl + Shift + O",
  );
});

test("snippet lines remove duplicate and icon-only noise while preserving selected order", () => {
  assert.equal(
    cleanSnippetLines(["Claude", "Claude", " ", "5 Days, 25 Hours: Re-scoped"]),
    "Claude\n5 Days, 25 Hours: Re-scoped",
  );
});
