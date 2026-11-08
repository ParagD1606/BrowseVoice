/**
 * Strict JSON schema and validation for Planner Actions in Browse Voice.
 *
 * Supported Actions:
 *  - click(id)
 *  - type(id, text)
 *  - select(id, value)
 *  - press_key(key)
 *  - scroll(direction)
 *  - navigate(url)
 *  - ask_user(question)
 *  - done(summary)
 */

export type ActionType =
  | "click"
  | "type"
  | "select"
  | "press_key"
  | "scroll"
  | "navigate"
  | "ask_user"
  | "done";

export interface SubTask {
  id: string;
  label: string;
  startUrl?: string;
  goal: string;
}

export type ScrollDirection = "up" | "down" | "left" | "right";

export interface ClickAction {
  action: "click";
  id: number;
  rationale?: string;
}

export interface TypeAction {
  action: "type";
  id: number;
  text: string;
  rationale?: string;
}

export interface SelectAction {
  action: "select";
  id: number;
  value: string;
  rationale?: string;
}

export interface PressKeyAction {
  action: "press_key";
  key: string;
  rationale?: string;
}

export interface ScrollAction {
  action: "scroll";
  direction: ScrollDirection;
  amount?: number;
  rationale?: string;
}

export interface NavigateAction {
  action: "navigate";
  url: string;
  rationale?: string;
}

export interface AskUserAction {
  action: "ask_user";
  question: string;
  options?: string[];
  rationale?: string;
}

export interface DoneAction {
  action: "done";
  summary: string;
  rationale?: string;
}

export type PlannerAction =
  | ClickAction
  | TypeAction
  | SelectAction
  | PressKeyAction
  | ScrollAction
  | NavigateAction
  | AskUserAction
  | DoneAction;

export interface ValidationSuccess {
  valid: true;
  action: PlannerAction;
}

export interface ValidationFailure {
  valid: false;
  error: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export interface SubTaskValidationSuccess {
  valid: true;
  tasks: SubTask[];
}

export interface SubTaskValidationFailure {
  valid: false;
  error: string;
}

export type SubTaskValidationResult = SubTaskValidationSuccess | SubTaskValidationFailure;

export const SUBTASK_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "BrowseVoiceSubTasks",
  type: "array",
  minItems: 1,
  maxItems: 4,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "label", "goal"],
    properties: {
      id: { type: "string", minLength: 1 },
      label: { type: "string", minLength: 1 },
      startUrl: { type: "string", format: "uri", pattern: "^https?://" },
      goal: { type: "string", minLength: 1 },
    },
  },
} as const;

function isAllowedHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function isAllowedNavigationUrl(value: string): boolean {
  return isAllowedHttpUrl(value.trim());
}

export function validateSubTasks(input: unknown): SubTaskValidationResult {
  if (!Array.isArray(input)) return { valid: false, error: "Decomposition output must be a JSON array." };
  if (input.length < 1 || input.length > 4) return { valid: false, error: "Return between 1 and 4 independent sub-tasks." };

  const ids = new Set<string>();
  const tasks: SubTask[] = [];
  for (const [index, value] of input.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { valid: false, error: `Sub-task ${index + 1} must be an object.` };
    }
    const raw = value as Record<string, unknown>;
    const unknownKeys = Object.keys(raw).filter((key) => !["id", "label", "startUrl", "goal"].includes(key));
    if (unknownKeys.length) return { valid: false, error: `Sub-task ${index + 1} contains unsupported fields: ${unknownKeys.join(", ")}.` };
    if (typeof raw.id !== "string" || !raw.id.trim()) return { valid: false, error: `Sub-task ${index + 1} requires a non-empty string 'id'.` };
    if (ids.has(raw.id.trim())) return { valid: false, error: `Sub-task id '${raw.id.trim()}' is duplicated.` };
    if (typeof raw.label !== "string" || !raw.label.trim()) return { valid: false, error: `Sub-task ${index + 1} requires a non-empty string 'label'.` };
    if (typeof raw.goal !== "string" || !raw.goal.trim()) return { valid: false, error: `Sub-task ${index + 1} requires a non-empty string 'goal'.` };
    if (raw.startUrl !== undefined && (typeof raw.startUrl !== "string" || !isAllowedHttpUrl(raw.startUrl))) {
      return { valid: false, error: `Sub-task ${index + 1} has an invalid startUrl; only http(s) URLs are allowed.` };
    }
    ids.add(raw.id.trim());
    tasks.push({
      id: raw.id.trim(),
      label: raw.label.trim().slice(0, 120),
      ...(raw.startUrl ? { startUrl: raw.startUrl.trim() } : {}),
      goal: raw.goal.trim().slice(0, 600),
    });
  }
  return { valid: true, tasks };
}

/** JSON Schema specification for the planner LLM system instructions */
export const PLANNER_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "PlannerAction",
  type: "object",
  required: ["action"],
  oneOf: [
    {
      properties: {
        action: { const: "click" },
        id: { type: "integer", minimum: 1, description: "Numeric ID of the interactive element to click" },
        rationale: { type: "string", description: "Short rationale in Hindi/Hinglish/English" },
      },
      required: ["action", "id"],
    },
    {
      properties: {
        action: { const: "type" },
        id: { type: "integer", minimum: 1, description: "Numeric ID of the input field" },
        text: { type: "string", description: "Text to type into the field" },
        rationale: { type: "string" },
      },
      required: ["action", "id", "text"],
    },
    {
      properties: {
        action: { const: "select" },
        id: { type: "integer", minimum: 1, description: "Numeric ID of the select/dropdown" },
        value: { type: "string", description: "Option value or label to choose" },
        rationale: { type: "string" },
      },
      required: ["action", "id", "value"],
    },
    {
      properties: {
        action: { const: "press_key" },
        key: { type: "string", minLength: 1, description: "Keyboard key to send to the focused element" },
        rationale: { type: "string" },
      },
      required: ["action", "key"],
    },
    {
      properties: {
        action: { const: "scroll" },
        direction: { enum: ["up", "down", "left", "right"] },
        amount: { type: "integer", minimum: 50 },
        rationale: { type: "string" },
      },
      required: ["action", "direction"],
    },
    {
      properties: {
        action: { const: "navigate" },
        url: { type: "string", format: "uri" },
        rationale: { type: "string" },
      },
      required: ["action", "url"],
    },
    {
      properties: {
        action: { const: "ask_user" },
        question: { type: "string", description: "Question to ask the user" },
        options: { type: "array", items: { type: "string" } },
        rationale: { type: "string" },
      },
      required: ["action", "question"],
    },
    {
      properties: {
        action: { const: "done" },
        summary: { type: "string", description: "Final concise summary of completed task" },
      },
      required: ["action", "summary"],
    },
  ],
};

/** Validates arbitrary input against the PlannerAction strict schema */
export function validatePlannerAction(input: unknown): ValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Action output must be a non-null JSON object." };
  }

  const raw = input as Record<string, unknown>;
  const action = raw.action;

  if (typeof action !== "string") {
    return { valid: false, error: "Field 'action' is required and must be a string." };
  }

  const rationale = typeof raw.rationale === "string" ? raw.rationale : undefined;

  switch (action) {
    case "click": {
      if (typeof raw.id !== "number" || !Number.isInteger(raw.id) || raw.id <= 0) {
        return { valid: false, error: "action 'click' requires a positive integer 'id'." };
      }
      return { valid: true, action: { action: "click", id: raw.id, rationale } };
    }

    case "type": {
      if (typeof raw.id !== "number" || !Number.isInteger(raw.id) || raw.id <= 0) {
        return { valid: false, error: "action 'type' requires a positive integer 'id'." };
      }
      if (typeof raw.text !== "string") {
        return { valid: false, error: "action 'type' requires a string 'text'." };
      }
      return { valid: true, action: { action: "type", id: raw.id, text: raw.text, rationale } };
    }

    case "select": {
      if (typeof raw.id !== "number" || !Number.isInteger(raw.id) || raw.id <= 0) {
        return { valid: false, error: "action 'select' requires a positive integer 'id'." };
      }
      if (typeof raw.value !== "string" || raw.value.trim().length === 0) {
        return { valid: false, error: "action 'select' requires a non-empty string 'value'." };
      }
      return { valid: true, action: { action: "select", id: raw.id, value: raw.value, rationale } };
    }

    case "scroll": {
      const dir = raw.direction;
      if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") {
        return { valid: false, error: "action 'scroll' requires 'direction' of 'up' | 'down' | 'left' | 'right'." };
      }
      const amount = typeof raw.amount === "number" && raw.amount > 0 ? Math.round(raw.amount) : undefined;
      return { valid: true, action: { action: "scroll", direction: dir, amount, rationale } };
    }

    case "press_key": {
      if (typeof raw.key !== "string" || !raw.key.trim() || raw.key.trim().length > 40) {
        return { valid: false, error: "action 'press_key' requires a non-empty 'key' of at most 40 characters." };
      }
      return { valid: true, action: { action: "press_key", key: raw.key.trim(), rationale } };
    }

    case "navigate": {
      if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
        return { valid: false, error: "action 'navigate' requires a non-empty string 'url'." };
      }
      if (!isAllowedNavigationUrl(raw.url)) {
        return { valid: false, error: "action 'navigate' only allows http(s) URLs." };
      }
      return { valid: true, action: { action: "navigate", url: raw.url.trim(), rationale } };
    }

    case "ask_user": {
      if (typeof raw.question !== "string" || raw.question.trim().length === 0) {
        return { valid: false, error: "action 'ask_user' requires a non-empty string 'question'." };
      }
      const options = Array.isArray(raw.options) && raw.options.every((opt) => typeof opt === "string")
        ? (raw.options as string[])
        : undefined;
      return { valid: true, action: { action: "ask_user", question: raw.question.trim(), options, rationale } };
    }

    case "done": {
      if (typeof raw.summary !== "string" || raw.summary.trim().length === 0) {
        return { valid: false, error: "action 'done' requires a non-empty string 'summary'." };
      }
      return { valid: true, action: { action: "done", summary: raw.summary.trim(), rationale } };
    }

    default:
      return {
        valid: false,
        error: `Unknown action '${String(action)}'. Allowed actions: click, type, select, press_key, scroll, navigate, ask_user, done.`,
      };
  }
}

/** Parses raw LLM text into a validated action, handling markdown code fences if present */
export function parseAndValidatePlannerJson(rawText: string): ValidationResult {
  let clean = rawText.trim();
  // Strip markdown code fences if LLM wrapped output in ```json ... ```
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  // Attempt direct JSON parse or find surrounding curly braces
  try {
    const parsed = JSON.parse(clean);
    return validatePlannerAction(parsed);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(clean.slice(start, end + 1));
        return validatePlannerAction(parsed);
      } catch (innerErr) {
        return { valid: false, error: `JSON parse error: ${innerErr instanceof Error ? innerErr.message : "Malformed JSON"}` };
      }
    }
    return { valid: false, error: "LLM response did not contain a valid JSON object." };
  }
}

/** Parses strict decomposition JSON, accepting only a 1–4 item array. */
export function parseAndValidateSubTasksJson(rawText: string): SubTaskValidationResult {
  let clean = rawText.trim();
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  try {
    return validateSubTasks(JSON.parse(clean));
  } catch {
    const start = clean.indexOf("[");
    const end = clean.lastIndexOf("]");
    if (start !== -1 && end > start) {
      try {
        return validateSubTasks(JSON.parse(clean.slice(start, end + 1)));
      } catch (innerErr) {
        return { valid: false, error: `JSON parse error: ${innerErr instanceof Error ? innerErr.message : "Malformed JSON"}` };
      }
    }
    return { valid: false, error: "LLM response did not contain a valid sub-task JSON array." };
  }
}
