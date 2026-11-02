// Pure validation/encoding boundary for native clarification questions (CHO-04).
//
// This module is stateless and side-effect free: no providers, no permissions,
// no OS access, no auto-answers. It translates the installed native wire
// shapes (Codex item/tool/requestUserInput params, Claude AskUserQuestion
// input) into bounded display data for the UI, and encodes explicit UI
// answers back into the exact native wire shapes. Anything malformed rejects
// with an Error that names the invalid field without echoing input text.

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;
const MIN_CLAUDE_OPTIONS = 2;
const MAX_CODEX_QUESTION_ID = 128;
const MAX_NATIVE_ID = 128;
const MAX_HEADER = 128;
const MAX_QUESTION_TEXT = 2048;
const MAX_LABEL = 256;
const MAX_DESCRIPTION = 2048;
const MAX_ANSWER = 4096;
const MAX_ANSWERS = 8;
const MAX_AGGREGATE = 16384;

const DISPLAY_QUESTION_KEYS = ["id", "header", "question", "options", "multiSelect", "isOther"];

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Defines an own data property even for keys like "__proto__" that a plain
// assignment would route into the prototype chain.
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function boundedString(value, field, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${field} must be a nonempty string of at most ${max} chars`);
  }
  return value;
}

function nativeId(value, field) {
  return boundedString(value, field, MAX_NATIVE_ID);
}

function optionDescription(value, field) {
  if (typeof value !== "string" || value.length > MAX_DESCRIPTION) {
    throw new Error(`${field} description must be a string of at most ${MAX_DESCRIPTION} chars`);
  }
  return value;
}

function checkDisplayBudget(total, field) {
  if (total > MAX_AGGREGATE) {
    throw new Error(`${field} exceeds the aggregate display text cap of ${MAX_AGGREGATE} chars`);
  }
}

function freezeOption(option) {
  return Object.freeze({ label: option.label, description: option.description });
}

function parseOption(raw, field, seenLabels) {
  if (!isPlainObject(raw)) throw new Error(`${field} must be a plain object`);
  const label = hasOwn(raw, "label") ? boundedString(raw.label, `${field} label`, MAX_LABEL) : null;
  if (label === null) throw new Error(`${field} label must be a nonempty string of at most ${MAX_LABEL} chars`);
  const description = hasOwn(raw, "description")
    ? optionDescription(raw.description, field)
    : null;
  if (description === null) throw new Error(`${field} description must be a string of at most ${MAX_DESCRIPTION} chars`);
  if (seenLabels.has(label)) throw new Error(`${field} has a duplicate option label`);
  seenLabels.add(label);
  return freezeOption({ label, description });
}

function baseQuestionFields(raw, field, idMax) {
  if (!isPlainObject(raw)) throw new Error(`${field} must be a plain object`);
  const id = hasOwn(raw, "id") ? boundedString(raw.id, `${field} id`, idMax) : null;
  if (id === null) throw new Error(`${field} id must be a nonempty string of at most ${idMax} chars`);
  const header = hasOwn(raw, "header") ? boundedString(raw.header, `${field} header`, MAX_HEADER) : null;
  if (header === null) throw new Error(`${field} header must be a nonempty string of at most ${MAX_HEADER} chars`);
  const question = hasOwn(raw, "question")
    ? boundedString(raw.question, `${field} question`, MAX_QUESTION_TEXT)
    : null;
  if (question === null) throw new Error(`${field} question must be a nonempty string of at most ${MAX_QUESTION_TEXT} chars`);
  return { id, header, question };
}

// Codex options: absent/undefined/null means free text; otherwise a nonempty
// array of at most MAX_OPTIONS options. Anything else rejects.
function parseCodexOptions(raw, field) {
  if (!hasOwn(raw, "options") || raw.options === undefined || raw.options === null) return null;
  if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > MAX_OPTIONS) {
    throw new Error(`${field} options must be null or an array of 1 to ${MAX_OPTIONS} options`);
  }
  const seen = new Set();
  return Object.freeze(raw.options.map((entry) => parseOption(entry, field, seen)));
}

function parseCodexFlags(raw, field) {
  let isOther = false;
  if (hasOwn(raw, "isOther") && raw.isOther !== undefined) {
    if (typeof raw.isOther !== "boolean") throw new Error(`${field} isOther must be a boolean when supplied`);
    isOther = raw.isOther;
  }
  if (hasOwn(raw, "isSecret") && raw.isSecret !== undefined) {
    if (typeof raw.isSecret !== "boolean") throw new Error(`${field} isSecret must be a boolean when supplied`);
    if (raw.isSecret) throw new Error(`${field} isSecret questions are not supported in this preview`);
  }
  return isOther;
}

function displayLength(question) {
  let total = question.header.length + question.question.length;
  if (question.options !== null) {
    for (const option of question.options) total += option.label.length + option.description.length;
  }
  return total;
}

export function parseCodexClarification(params) {
  if (!isPlainObject(params)) throw new Error("codex clarification params must be a plain object");
  const nativeThreadId = hasOwn(params, "threadId") ? nativeId(params.threadId, "codex clarification threadId") : null;
  if (nativeThreadId === null) throw new Error("codex clarification threadId must be a nonempty string of at most 128 chars");
  const nativeTurnId = hasOwn(params, "turnId") ? nativeId(params.turnId, "codex clarification turnId") : null;
  if (nativeTurnId === null) throw new Error("codex clarification turnId must be a nonempty string of at most 128 chars");
  const nativeItemId = hasOwn(params, "itemId") ? nativeId(params.itemId, "codex clarification itemId") : null;
  if (nativeItemId === null) throw new Error("codex clarification itemId must be a nonempty string of at most 128 chars");
  // isBlocking is required and authoritative; the deprecated
  // autoResolutionMs hint is ignored, never inferred from.
  if (!hasOwn(params, "isBlocking") || typeof params.isBlocking !== "boolean") {
    throw new Error("codex clarification isBlocking is required and must be a boolean");
  }
  const isBlocking = params.isBlocking;
  if (!hasOwn(params, "questions") || !Array.isArray(params.questions) || params.questions.length === 0 || params.questions.length > MAX_QUESTIONS) {
    throw new Error(`codex clarification questions must be an array of 1 to ${MAX_QUESTIONS} questions`);
  }
  const seenIds = new Set();
  let aggregate = 0;
  const questions = params.questions.map((raw) => {
    const field = "codex clarification question";
    const base = baseQuestionFields(raw, field, MAX_CODEX_QUESTION_ID);
    if (seenIds.has(base.id)) throw new Error("codex clarification question has a duplicate id");
    seenIds.add(base.id);
    const options = parseCodexOptions(raw, field);
    const isOther = parseCodexFlags(raw, field);
    const question = { id: base.id, header: base.header, question: base.question, options, multiSelect: false, isOther };
    aggregate += displayLength(question);
    checkDisplayBudget(aggregate, "codex clarification questions");
    return Object.freeze(question);
  });
  return Object.freeze({ nativeThreadId, nativeTurnId, nativeItemId, isBlocking, questions: Object.freeze(questions) });
}

export function parseCodexAsyncClarification(params) {
  if (!isPlainObject(params)) throw new Error("codex async clarification params must be a plain object");
  const nativeThreadId = hasOwn(params, "threadId") ? nativeId(params.threadId, "codex async clarification threadId") : null;
  if (nativeThreadId === null) throw new Error("codex async clarification threadId must be a nonempty string of at most 128 chars");
  const nativeTurnId = hasOwn(params, "turnId") ? nativeId(params.turnId, "codex async clarification turnId") : null;
  if (nativeTurnId === null) throw new Error("codex async clarification turnId must be a nonempty string of at most 128 chars");
  if (!hasOwn(params, "item") || !isPlainObject(params.item)) {
    throw new Error("codex async clarification item must be a plain object");
  }
  const item = params.item;
  if (!hasOwn(item, "type") || item.type !== "agentMessage") {
    throw new Error("codex async clarification item type must be agentMessage");
  }
  if (!hasOwn(item, "delivery") || item.delivery !== "async") {
    throw new Error("codex async clarification item delivery must be async");
  }
  const nativeItemId = hasOwn(item, "id") ? nativeId(item.id, "codex async clarification itemId") : null;
  if (nativeItemId === null) throw new Error("codex async clarification itemId must be a nonempty string of at most 128 chars");
  if (!hasOwn(item, "questions") || !Array.isArray(item.questions) || item.questions.length === 0 || item.questions.length > MAX_QUESTIONS) {
    throw new Error(`codex async clarification questions must be an array of 1 to ${MAX_QUESTIONS} questions`);
  }
  let aggregate = 0;
  const questions = item.questions.map((raw, index) => {
    const field = "codex async clarification question";
    if (!isPlainObject(raw)) throw new Error(`${field} must be a plain object`);
    const title = hasOwn(raw, "title") ? boundedString(raw.title, `${field} title`, MAX_QUESTION_TEXT) : null;
    if (title === null) throw new Error(`${field} title must be a nonempty string of at most ${MAX_QUESTION_TEXT} chars`);
    let options = null;
    if (!hasOwn(raw, "options") || raw.options === undefined || raw.options === null) {
      options = null;
    } else {
      if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > MAX_OPTIONS) {
        throw new Error(`${field} options must be null or an array of 1 to ${MAX_OPTIONS} options`);
      }
      const seen = new Set();
      options = Object.freeze(raw.options.map((label) => {
        const checked = boundedString(label, `${field} option`, MAX_LABEL);
        if (seen.has(checked)) throw new Error(`${field} has a duplicate option label`);
        seen.add(checked);
        return Object.freeze({ label: checked, description: "" });
      }));
    }
    const display = {
      id: String(index),
      header: `Question ${index + 1}`,
      question: title,
      options,
      multiSelect: false,
      isOther: true,
    };
    aggregate += displayLength(display);
    checkDisplayBudget(aggregate, "codex async clarification questions");
    return Object.freeze(display);
  });
  return Object.freeze({ nativeThreadId, nativeTurnId, nativeItemId, isBlocking: false, questions: Object.freeze(questions) });
}

function checkAsyncParsedShape(parsed) {
  const field = "codex async clarification answers";
  if (!isPlainObject(parsed)) throw new Error(`${field} must be a plain object`);
  if (!hasOwn(parsed, "questions") || !Array.isArray(parsed.questions) || parsed.questions.length === 0 || parsed.questions.length > MAX_QUESTIONS) {
    throw new Error(`${field} must carry 1 to ${MAX_QUESTIONS} parsed questions`);
  }
  if (hasOwn(parsed, "isBlocking") && parsed.isBlocking !== false) {
    throw new Error(`${field} parsed object must be nonblocking async clarification`);
  }
  const seen = new Set();
  for (let i = 0; i < parsed.questions.length; i += 1) {
    const entry = parsed.questions[i];
    if (!isPlainObject(entry)) throw new Error(`${field} has an invalid parsed question`);
    if (entry.id !== String(i)) throw new Error(`${field} has an invalid parsed question id`);
    if (entry.header !== `Question ${i + 1}`) throw new Error(`${field} has an invalid parsed question header`);
    if (typeof entry.question !== "string" || entry.question.length === 0 || entry.question.length > MAX_QUESTION_TEXT) {
      throw new Error(`${field} has an invalid parsed question text`);
    }
    if (entry.multiSelect !== false || entry.isOther !== true) throw new Error(`${field} has invalid parsed question flags`);
    if (entry.options !== null && entry.options !== undefined) {
      if (!Array.isArray(entry.options) || entry.options.length === 0 || entry.options.length > MAX_OPTIONS) {
        throw new Error(`${field} has invalid parsed question options`);
      }
      const labels = new Set();
      for (const option of entry.options) {
        if (!isPlainObject(option) || Object.keys(option).length !== 2) throw new Error(`${field} has invalid parsed question options`);
        if (typeof option.label !== "string" || option.label.length === 0 || option.label.length > MAX_LABEL) {
          throw new Error(`${field} has invalid parsed question options`);
        }
        if (option.description !== "") throw new Error(`${field} has invalid parsed question options`);
        if (labels.has(option.label)) throw new Error(`${field} has a duplicate parsed option label`);
        labels.add(option.label);
      }
    }
    if (seen.has(entry.id)) throw new Error(`${field} has a duplicate parsed question id`);
    seen.add(entry.id);
  }
  return seen;
}

export function encodeCodexAsyncClarificationAnswer(parsed, answers) {
  const ids = checkAsyncParsedShape(parsed);
  if (!isPlainObject(answers)) throw new Error("codex async clarification answers must be a plain object");
  const keys = Object.keys(answers);
  if (keys.length !== ids.size) throw new Error("codex async clarification answers must map every question id exactly once");
  const byId = new Map(parsed.questions.map((entry) => [entry.id, entry]));
  let aggregate = 0;
  const copies = new Map();
  for (const key of keys) {
    const display = byId.get(key);
    if (display === undefined) throw new Error("codex async clarification answers carry an unknown question id");
    const checked = checkAnswerArray(answers[key], "codex async clarification answer", false);
    aggregate += checked.total;
    if (aggregate > MAX_AGGREGATE) {
      throw new Error(`codex async clarification answers exceed the aggregate answer cap of ${MAX_AGGREGATE} chars`);
    }
    copies.set(key, checked.copy);
  }
  const ordered = parsed.questions.map((entry) => ({ question: entry.question, answers: copies.get(entry.id) }));
  return `Answers to your questions:\n${JSON.stringify(ordered)}`;
}

export function parseClaudeClarification(input) {
  if (!isPlainObject(input)) throw new Error("claude clarification input must be a plain object");
  // The boundary never submits provider-supplied answers: any prefilled
  // answers field rejects instead of being silently carried through.
  if (hasOwn(input, "answers")) throw new Error("claude clarification input must not carry prefilled answers");
  if (!hasOwn(input, "questions") || !Array.isArray(input.questions) || input.questions.length === 0 || input.questions.length > MAX_QUESTIONS) {
    throw new Error(`claude clarification questions must be an array of 1 to ${MAX_QUESTIONS} questions`);
  }
  const seenText = new Set();
  let aggregate = 0;
  const questions = input.questions.map((raw) => {
    const field = "claude clarification question";
    if (!isPlainObject(raw)) throw new Error(`${field} must be a plain object`);
    const header = hasOwn(raw, "header") ? boundedString(raw.header, `${field} header`, MAX_HEADER) : null;
    if (header === null) throw new Error(`${field} header must be a nonempty string of at most ${MAX_HEADER} chars`);
    const question = hasOwn(raw, "question")
      ? boundedString(raw.question, `${field} question`, MAX_QUESTION_TEXT)
      : null;
    if (question === null) throw new Error(`${field} question must be a nonempty string of at most ${MAX_QUESTION_TEXT} chars`);
    if (seenText.has(question)) throw new Error("claude clarification question text must be unique for wire answer mapping");
    seenText.add(question);
    if (!hasOwn(raw, "options") || !Array.isArray(raw.options) || raw.options.length < MIN_CLAUDE_OPTIONS || raw.options.length > MAX_OPTIONS) {
      throw new Error(`${field} options must be an array of ${MIN_CLAUDE_OPTIONS} to ${MAX_OPTIONS} options`);
    }
    const seenLabels = new Set();
    const options = Object.freeze(raw.options.map((entry) => parseOption(entry, field, seenLabels)));
    if (!hasOwn(raw, "multiSelect") || typeof raw.multiSelect !== "boolean") {
      throw new Error(`${field} multiSelect is required and must be a boolean`);
    }
    // The native user-input protocol accepts free text, so display always
    // qualifies these as other/free-text capable. The id is the original
    // question text so answers map back on the wire exactly.
    const display = { id: question, header, question, options, multiSelect: raw.multiSelect, isOther: true };
    aggregate += displayLength(display);
    checkDisplayBudget(aggregate, "claude clarification questions");
    return Object.freeze(display);
  });
  return Object.freeze({ questions: Object.freeze(questions) });
}

function checkParsedShape(parsed, field) {
  if (!isPlainObject(parsed)) throw new Error(`${field} must be a plain object`);
  if (!hasOwn(parsed, "questions") || !Array.isArray(parsed.questions) || parsed.questions.length === 0 || parsed.questions.length > MAX_QUESTIONS) {
    throw new Error(`${field} must carry 1 to ${MAX_QUESTIONS} parsed questions`);
  }
  const seen = new Set();
  for (const entry of parsed.questions) {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > MAX_QUESTION_TEXT) {
      throw new Error(`${field} has an invalid parsed question id`);
    }
    if (typeof entry.multiSelect !== "boolean") throw new Error(`${field} has an invalid parsed multiSelect flag`);
    if (seen.has(entry.id)) throw new Error(`${field} has a duplicate parsed question id`);
    seen.add(entry.id);
  }
  return seen;
}

function checkAnswerArray(value, field, multiSelect) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a nonempty array of answer strings`);
  }
  const limit = multiSelect ? MAX_ANSWERS : 1;
  if (value.length > limit) {
    throw new Error(multiSelect
      ? `${field} takes at most ${MAX_ANSWERS} answers`
      : `${field} is single-choice and takes exactly one answer`);
  }
  const seen = new Set();
  let total = 0;
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_ANSWER || entry.trim().length === 0) {
      throw new Error(`${field} answers must be nonblank strings of at most ${MAX_ANSWER} chars`);
    }
    if (seen.has(entry)) throw new Error(`${field} has a duplicate selected answer`);
    seen.add(entry);
    total += entry.length;
  }
  return { copy: [...value], total };
}

// First-slice policy: option membership is NOT enforced (the caller may
// collect free text); the isOther flag stays on the parsed display data so
// the UI can qualify free-text answers.
export function encodeCodexClarificationAnswer(parsed, answers) {
  const ids = checkParsedShape(parsed, "codex clarification answers");
  if (!isPlainObject(answers)) throw new Error("codex clarification answers must be a plain object");
  const keys = Object.keys(answers);
  if (keys.length !== ids.size) throw new Error("codex clarification answers must map every question id exactly once");
  const byId = new Map(parsed.questions.map((entry) => [entry.id, entry]));
  let aggregate = 0;
  const out = {};
  for (const key of keys) {
    if (!byId.has(key)) throw new Error("codex clarification answers carry an unknown question id");
    const checked = checkAnswerArray(answers[key], "codex clarification answer", byId.get(key).multiSelect);
    aggregate += checked.total;
    if (aggregate > MAX_AGGREGATE) {
      throw new Error(`codex clarification answers exceed the aggregate answer cap of ${MAX_AGGREGATE} chars`);
    }
    setOwn(out, key, { answers: checked.copy });
  }
  return { answers: out };
}

function optionsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!isPlainObject(x) || !isPlainObject(y)) return false;
    if (Object.keys(x).length !== 2 || Object.keys(y).length !== 2) return false;
    if (x.label !== y.label || x.description !== y.description) return false;
  }
  return true;
}

function displayEqual(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  if (Object.keys(a).length !== DISPLAY_QUESTION_KEYS.length || Object.keys(b).length !== DISPLAY_QUESTION_KEYS.length) return false;
  for (const key of DISPLAY_QUESTION_KEYS) {
    if (!hasOwn(a, key) || !hasOwn(b, key)) return false;
  }
  return a.id === b.id
    && a.header === b.header
    && a.question === b.question
    && a.multiSelect === b.multiSelect
    && a.isOther === b.isOther
    && optionsEqual(a.options, b.options);
}

export function encodeClaudeClarificationAnswer(originalInput, parsed, answers) {
  if (!isPlainObject(originalInput)) throw new Error("claude clarification input must be a plain object");
  // Re-parse the authoritative input and require the supplied parsed display
  // to match exactly, so a stale or tampered parsed object cannot remap an
  // answer onto different text or options.
  const fresh = parseClaudeClarification(originalInput);
  if (!isPlainObject(parsed) || !hasOwn(parsed, "questions") || Object.keys(parsed).length !== 1) {
    throw new Error("claude clarification parsed object does not match the original input");
  }
  if (!Array.isArray(parsed.questions) || parsed.questions.length !== fresh.questions.length) {
    throw new Error("claude clarification parsed object does not match the original input");
  }
  for (let i = 0; i < fresh.questions.length; i += 1) {
    if (!displayEqual(parsed.questions[i], fresh.questions[i])) {
      throw new Error("claude clarification parsed object does not match the original input");
    }
  }
  if (!isPlainObject(answers)) throw new Error("claude clarification answers must be a plain object");
  const keys = Object.keys(answers);
  if (keys.length !== fresh.questions.length) {
    throw new Error("claude clarification answers must map every question text exactly once");
  }
  const byText = new Map(fresh.questions.map((entry) => [entry.question, entry]));
  let aggregate = 0;
  const joined = {};
  for (const key of keys) {
    const display = byText.get(key);
    if (display === undefined) throw new Error("claude clarification answers carry an unknown question");
    const checked = checkAnswerArray(answers[key], "claude clarification answer", display.multiSelect);
    aggregate += checked.total;
    if (aggregate > MAX_AGGREGATE) {
      throw new Error(`claude clarification answers exceed the aggregate answer cap of ${MAX_AGGREGATE} chars`);
    }
    // Exact answer strings are preserved after validation; the wire carries
    // one joined string per original question text.
    setOwn(joined, key, checked.copy.join(", "));
  }
  return { behavior: "allow", updatedInput: { ...originalInput, answers: joined } };
}
