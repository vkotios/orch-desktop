import { describe, it, expect } from "vitest";
import {
  parseCodexClarification,
  parseCodexAsyncClarification,
  parseClaudeClarification,
  encodeCodexClarificationAnswer,
  encodeCodexAsyncClarificationAnswer,
  encodeClaudeClarificationAnswer,
} from "../server/native-clarification.mjs";

const codexQuestion = (over = {}) => ({
  id: "q1",
  header: "Pick one",
  question: "Which color?",
  options: [
    { label: "Red", description: "The warm one" },
    { label: "Blue", description: "The cool one" },
  ],
  ...over,
});

const codexParams = (over = {}) => ({
  threadId: "th-1",
  turnId: "tu-1",
  itemId: "it-1",
  questions: [codexQuestion()],
  isBlocking: true,
  ...over,
});

const claudeQuestion = (over = {}) => ({
  header: "Pick",
  question: "Which color?",
  options: [
    { label: "Red", description: "Warm" },
    { label: "Green", description: "Cool" },
  ],
  multiSelect: false,
  ...over,
});

const claudeInput = (over = {}) => ({ questions: [claudeQuestion()], ...over });

// Builds a plain object with true own properties, even for keys such as
// "__proto__" that an object literal would route into the prototype.
function ownObject(entries) {
  const obj = {};
  for (const [key, value] of entries) {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return obj;
}

const snapshot = (v) => JSON.stringify(v);

describe("parseCodexClarification", () => {
  it("returns bounded display data for a blocking request and ignores native extras", () => {
    const parsed = parseCodexClarification(codexParams({
      autoResolutionMs: 5000,
      extraTop: "ignored",
    }));
    expect(parsed).toEqual({
      nativeThreadId: "th-1",
      nativeTurnId: "tu-1",
      nativeItemId: "it-1",
      isBlocking: true,
      questions: [{
        id: "q1",
        header: "Pick one",
        question: "Which color?",
        options: [
          { label: "Red", description: "The warm one" },
          { label: "Blue", description: "The cool one" },
        ],
        multiSelect: false,
        isOther: false,
      }],
    });
  });

  it("accepts a nonblocking request with null options and default flags", () => {
    const input = codexParams({
      isBlocking: false,
      questions: [{ id: "a", header: "H", question: "Free text?", options: null }],
    });
    expect(parseCodexClarification(input).questions[0]).toMatchObject({
      options: null,
      multiSelect: false,
      isOther: false,
    });
  });

  it("treats missing options as free text and retains isOther", () => {
    const { id, header, question } = codexQuestion();
    const parsed = parseCodexClarification(codexParams({
      questions: [{ id, header, question, isOther: true }],
    }));
    expect(parsed.questions[0]).toMatchObject({ options: null, isOther: true });
  });

  it("requires isBlocking and never infers it from autoResolutionMs", () => {
    expect(() => parseCodexClarification(codexParams({ isBlocking: undefined }))).toThrow(/isBlocking/);
    const { isBlocking, ...rest } = codexParams();
    expect(() => parseCodexClarification(rest)).toThrow(/isBlocking/);
    expect(() => parseCodexClarification(codexParams({ isBlocking: "yes" }))).toThrow(/isBlocking/);
  });

  it("rejects bad native ids without inventing any", () => {
    for (const field of ["threadId", "turnId", "itemId"]) {
      expect(() => parseCodexClarification(codexParams({ [field]: "" })), field).toThrow(/threadId|turnId|itemId/);
      expect(() => parseCodexClarification(codexParams({ [field]: "x".repeat(129) })), field).toThrow();
      expect(() => parseCodexClarification(codexParams({ [field]: 42 })), field).toThrow();
    }
    const { threadId, ...rest } = codexParams();
    expect(() => parseCodexClarification(rest)).toThrow(/threadId/);
  });

  it("rejects empty, oversized, and duplicate question sets", () => {
    expect(() => parseCodexClarification(codexParams({ questions: [] }))).toThrow(/questions/);
    expect(() => parseCodexClarification(codexParams({
      questions: ["a", "b", "c", "d", "e"].map((id) => codexQuestion({ id })),
    }))).toThrow(/questions/);
    expect(() => parseCodexClarification(codexParams({
      questions: [codexQuestion({ id: "dup" }), codexQuestion({ id: "dup" })],
    }))).toThrow(/duplicate/);
    expect(() => parseCodexClarification(codexParams({ questions: "nope" }))).toThrow(/questions/);
  });

  it("rejects malformed question fields and option shapes", () => {
    expect(() => parseCodexClarification(codexParams({ questions: [codexQuestion({ id: "" })] }))).toThrow(/id/);
    expect(() => parseCodexClarification(codexParams({ questions: [codexQuestion({ id: "x".repeat(129) })] }))).toThrow(/id/);
    expect(() => parseCodexClarification(codexParams({ questions: [codexQuestion({ header: "" })] }))).toThrow(/header/);
    expect(() => parseCodexClarification(codexParams({ questions: [codexQuestion({ question: "" })] }))).toThrow(/question/);
    expect(() => parseCodexClarification(codexParams({ questions: [codexQuestion({ options: [] })] }))).toThrow(/options/);
    expect(() => parseCodexClarification(codexParams({
      questions: [codexQuestion({ options: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, description: "d" })) })],
    }))).toThrow(/options/);
    expect(() => parseCodexClarification(codexParams({
      questions: [codexQuestion({ options: [{ label: "Same", description: "a" }, { label: "Same", description: "b" }] })],
    }))).toThrow(/duplicate/);
    expect(() => parseCodexClarification(codexParams({ questions: [codexQuestion({ options: [{ label: "", description: "d" }] })] }))).toThrow(/label/);
    expect(() => parseCodexClarification(codexParams({ questions: [null] }))).toThrow();
  });

  it("rejects secret questions and malformed flags explicitly", () => {
    expect(() => parseCodexClarification(codexParams({ questions: [codexQuestion({ isSecret: true })] }))).toThrow(/isSecret/);
    expect(parseCodexClarification(codexParams({ questions: [codexQuestion({ isSecret: false })] })).questions[0].isOther).toBe(false);
    expect(() => parseCodexClarification(codexParams({ questions: [codexQuestion({ isSecret: "no" })] }))).toThrow(/isSecret/);
    expect(() => parseCodexClarification(codexParams({ questions: [codexQuestion({ isOther: 1 })] }))).toThrow(/isOther/);
  });

  it("rejects non-plain params", () => {
    expect(() => parseCodexClarification(null)).toThrow();
    expect(() => parseCodexClarification([1])).toThrow();
    expect(() => parseCodexClarification("x")).toThrow();
  });

  it("accepts Unicode text within bounds", () => {
    const parsed = parseCodexClarification(codexParams({
      questions: [codexQuestion({ header: "🎨 色", question: "好きな色は？", options: [{ label: "赤🎈", description: "あかい" }] })],
    }));
    expect(parsed.questions[0].header).toBe("🎨 色");
  });

  it("rejects aggregate display text over the cap rather than truncating", () => {
    const big = (n) => "x".repeat(n);
    // Exactly at the cap: 128 + 2048 + 6 * 2304 + (256 + 128) = 16384.
    const options = Array.from({ length: 6 }, (_, i) => ({ label: `L${i}${big(254)}`, description: big(2048) }));
    options.push({ label: big(256), description: big(128) });
    const ok = parseCodexClarification(codexParams({
      questions: [{ id: "q", header: big(128), question: big(2048), options }],
    }));
    expect(ok.questions).toHaveLength(1);
    const over = options.slice();
    over[6] = { label: big(256), description: big(129) };
    expect(() => parseCodexClarification(codexParams({
      questions: [{ id: "q", header: big(128), question: big(2048), options: over }],
    }))).toThrow(/aggregate/);
  });
});

describe("parseClaudeClarification", () => {
  it("returns display questions keyed by original text with free-text allowed", () => {
    const parsed = parseClaudeClarification(claudeInput());
    expect(parsed).toEqual({
      questions: [{
        id: "Which color?",
        header: "Pick",
        question: "Which color?",
        options: [
          { label: "Red", description: "Warm" },
          { label: "Green", description: "Cool" },
        ],
        multiSelect: false,
        isOther: true,
      }],
    });
  });

  it("preserves multiSelect and supports multiple questions", () => {
    const parsed = parseClaudeClarification(claudeInput({
      questions: [claudeQuestion({ multiSelect: true }), claudeQuestion({ question: "Second?", header: "H2" })],
    }));
    expect(parsed.questions.map((q) => [q.id, q.multiSelect, q.isOther])).toEqual([
      ["Which color?", true, true],
      ["Second?", false, true],
    ]);
  });

  it("rejects any prefilled answers and duplicate question text", () => {
    expect(() => parseClaudeClarification(claudeInput({ answers: {} }))).toThrow(/answers/);
    expect(() => parseClaudeClarification(claudeInput({ answers: { "Which color?": "Red" } }))).toThrow(/answers/);
    expect(() => parseClaudeClarification(claudeInput({
      questions: [claudeQuestion(), claudeQuestion()],
    }))).toThrow(/unique/);
  });

  it("requires 2 to 8 options and a boolean multiSelect", () => {
    expect(() => parseClaudeClarification(claudeInput({ questions: [claudeQuestion({ options: [{ label: "Only", description: "one" }] })] }))).toThrow(/options/);
    expect(() => parseClaudeClarification(claudeInput({
      questions: [claudeQuestion({ options: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, description: "d" })) })],
    }))).toThrow(/options/);
    const { multiSelect, ...rest } = claudeQuestion();
    void multiSelect;
    expect(() => parseClaudeClarification(claudeInput({ questions: [rest] }))).toThrow(/multiSelect/);
    expect(() => parseClaudeClarification(claudeInput({ questions: [claudeQuestion({ multiSelect: "yes" })] }))).toThrow(/multiSelect/);
  });

  it("rejects empty or oversized question sets and bad bounds", () => {
    expect(() => parseClaudeClarification(claudeInput({ questions: [] }))).toThrow(/questions/);
    expect(() => parseClaudeClarification(claudeInput({
      questions: ["1", "2", "3", "4", "5"].map((n) => claudeQuestion({ question: `Q${n}?` })),
    }))).toThrow(/questions/);
    expect(() => parseClaudeClarification(claudeInput({ questions: [claudeQuestion({ header: "" })] }))).toThrow(/header/);
    expect(() => parseClaudeClarification(claudeInput({ questions: [claudeQuestion({ question: "x".repeat(2049) })] }))).toThrow(/question/);
    expect(() => parseClaudeClarification("nope")).toThrow();
  });

  it("does not mutate its input", () => {
    const input = claudeInput({ questions: [claudeQuestion(), claudeQuestion({ question: "Other?" })] });
    const before = snapshot(input);
    parseClaudeClarification(input);
    expect(snapshot(input)).toBe(before);
  });

  it("rejects aggregate display text over the cap", () => {
    const big = (n) => "y".repeat(n);
    const options = Array.from({ length: 7 }, (_, i) => ({ label: `L${i}${big(254)}`, description: big(2048) }));
    expect(() => parseClaudeClarification(claudeInput({
      questions: [{ header: big(128), question: big(2048), options, multiSelect: false }],
    }))).toThrow(/aggregate/);
  });
});

describe("encodeCodexClarificationAnswer", () => {
  it("encodes the exact wire shape, allows free text, and mutates nothing", () => {
    const parsed = parseCodexClarification(codexParams());
    const answers = { q1: ["Magenta (not listed)"] };
    const before = [snapshot(parsed), snapshot(answers)];
    const wire = encodeCodexClarificationAnswer(parsed, answers);
    expect(wire).toEqual({ answers: { q1: { answers: ["Magenta (not listed)"] } } });
    expect(snapshot(parsed)).toBe(before[0]);
    expect(snapshot(answers)).toBe(before[1]);
    expect(Object.hasOwn(wire.answers, "q1")).toBe(true);
  });

  it("round-trips multiple questions and keeps answer strings exact", () => {
    const parsed = parseCodexClarification(codexParams({
      questions: [codexQuestion({ id: "a" }), codexQuestion({ id: "b", header: "H2", question: "Q2?" })],
    }));
    const wire = encodeCodexClarificationAnswer(parsed, { a: ["  padded  "], b: ["x"] });
    expect(wire.answers.a.answers).toEqual(["  padded  "]);
    expect(Object.keys(wire.answers).sort()).toEqual(["a", "b"]);
  });

  it("rejects missing, extra, and malformed answer maps", () => {
    const parsed = parseCodexClarification(codexParams({
      questions: [codexQuestion({ id: "a" }), codexQuestion({ id: "b", header: "H2", question: "Q2?" })],
    }));
    expect(() => encodeCodexClarificationAnswer(parsed, { a: ["x"] })).toThrow(/every question/);
    expect(() => encodeCodexClarificationAnswer(parsed, { a: ["x"], b: ["y"], c: ["z"] })).toThrow(/every question/);
    expect(() => encodeCodexClarificationAnswer(parsed, { a: ["x"], c: ["y"] })).toThrow(/unknown/);
    expect(() => encodeCodexClarificationAnswer(parsed, null)).toThrow();
    expect(() => encodeCodexClarificationAnswer(parsed, [["a", ["x"]]])).toThrow();
    expect(() => encodeCodexClarificationAnswer(parsed, { a: "x", b: ["y"] })).toThrow();
  });

  it("rejects empty, blank, duplicate, oversized, and mistyped answers", () => {
    const parsed = parseCodexClarification(codexParams());
    const secret = "s3cr3t-answer-value";
    for (const bad of [[], [""], ["   "], ["\t \n"], ["x", "x"], ["x", "y"], ["x".repeat(4097)], [42], [null]]) {
      expect(() => encodeCodexClarificationAnswer(parsed, { q1: bad })).toThrow();
    }
    expect(encodeCodexClarificationAnswer(parsed, { q1: [secret] }).answers.q1.answers).toEqual([secret]);
    expect(() => encodeCodexClarificationAnswer(parsed, { q1: ["x".repeat(4097)] })).toThrow(/at most 4096/);
  });

  it("never echoes answer text in rejection messages", () => {
    const parsed = parseCodexClarification(codexParams());
    const sensitive = `sensitive-${"z".repeat(4100)}`;
    let message = "";
    try {
      encodeCodexClarificationAnswer(parsed, { q1: [sensitive] });
    } catch (err) {
      message = err.message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(sensitive.slice(0, 64));
  });

  it("accepts four full-size answers at the aggregate cap", () => {
    const parsed = parseCodexClarification(codexParams({
      questions: ["a", "b", "c", "d"].map((id) => codexQuestion({ id, header: "H", question: "Q?" })),
    }));
    const answers = { a: ["x".repeat(4096)], b: ["y".repeat(4096)], c: ["z".repeat(4096)], d: ["w".repeat(4096)] };
    expect(encodeCodexClarificationAnswer(parsed, answers).answers.d.answers[0]).toHaveLength(4096);
  });

  it("handles dangerous keys as safe own properties", () => {
    const parsed = parseCodexClarification(codexParams({ questions: [codexQuestion({ id: "__proto__" })] }));
    const answers = ownObject([["__proto__", ["picked"]]]);
    const wire = encodeCodexClarificationAnswer(parsed, answers);
    expect(Object.hasOwn(wire.answers, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(wire.answers)).toBe(Object.prototype);
    expect(wire.answers["__proto__"]).toEqual({ answers: ["picked"] });
  });

  it("accepts Unicode answers", () => {
    const parsed = parseCodexClarification(codexParams());
    const wire = encodeCodexClarificationAnswer(parsed, { q1: ["赤 🎈"] });
    expect(wire.answers.q1.answers).toEqual(["赤 🎈"]);
  });
});

describe("encodeClaudeClarificationAnswer", () => {
  it("encodes allow with answers joined per original question text", () => {
    const input = claudeInput({
      questions: [
        claudeQuestion({ multiSelect: true }),
        claudeQuestion({ question: "Second?", header: "H2" }),
      ],
    });
    const parsed = parseClaudeClarification(input);
    const answers = { "Which color?": ["Red", "Green"], "Second?": ["Blue"] };
    const before = [snapshot(input), snapshot(parsed), snapshot(answers)];
    const wire = encodeClaudeClarificationAnswer(input, parsed, answers);
    expect(wire).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: input.questions,
        answers: { "Which color?": "Red, Green", "Second?": "Blue" },
      },
    });
    expect(wire.updatedInput.questions).toBe(input.questions);
    expect(snapshot(input)).toBe(before[0]);
    expect(snapshot(parsed)).toBe(before[1]);
    expect(snapshot(answers)).toBe(before[2]);
  });

  it("preserves other native fields exactly and adds no permission fields", () => {
    const input = claudeInput({ tool_name: "AskUserQuestion", sessionExtra: { n: 1 } });
    const parsed = parseClaudeClarification(input);
    const wire = encodeClaudeClarificationAnswer(input, parsed, { "Which color?": ["Red"] });
    expect(wire.updatedInput.tool_name).toBe("AskUserQuestion");
    expect(wire.updatedInput.sessionExtra).toBe(input.sessionExtra);
    expect(Object.keys(wire).sort()).toEqual(["behavior", "updatedInput"]);
  });

  it("rejects stale or tampered parsed objects", () => {
    const input = claudeInput();
    const parsed = parseClaudeClarification(input);
    const clone = () => JSON.parse(snapshot(parsed));
    const variants = [
      (() => { const p = clone(); p.questions[0].question = "Changed?"; return p; })(),
      (() => { const p = clone(); p.questions[0].options[0].label = "Changed"; return p; })(),
      (() => { const p = clone(); p.questions[0].multiSelect = true; return p; })(),
      (() => { const p = clone(); p.questions[0].isOther = false; return p; })(),
      (() => { const p = clone(); p.questions.push(p.questions[0]); return p; })(),
      (() => { const p = clone(); p.extra = 1; return p; })(),
      (() => { const p = clone(); p.questions[0].extra = 1; return p; })(),
      ({ questions: [] }),
    ];
    for (const tampered of variants) {
      expect(() => encodeClaudeClarificationAnswer(input, tampered, { "Which color?": ["Red"] })).toThrow(/match/);
    }
    // A parsed object from different input text is stale.
    const other = parseClaudeClarification(claudeInput({ questions: [claudeQuestion({ question: "Other?" })] }));
    expect(() => encodeClaudeClarificationAnswer(input, other, { "Which color?": ["Red"] })).toThrow(/match/);
  });

  it("rejects missing, extra, blank, and wrong-cardinality answers", () => {
    const input = claudeInput();
    const parsed = parseClaudeClarification(input);
    expect(() => encodeClaudeClarificationAnswer(input, parsed, {})).toThrow(/every question/);
    expect(() => encodeClaudeClarificationAnswer(input, parsed, { "Which color?": ["Red"], "Extra?": ["x"] })).toThrow(/every question/);
    expect(() => encodeClaudeClarificationAnswer(input, parsed, { "Extra?": ["x"] })).toThrow(/unknown/);
    expect(() => encodeClaudeClarificationAnswer(input, parsed, { "Which color?": [] })).toThrow();
    expect(() => encodeClaudeClarificationAnswer(input, parsed, { "Which color?": ["  "] })).toThrow();
    expect(() => encodeClaudeClarificationAnswer(input, parsed, { "Which color?": ["Red", "Green"] })).toThrow(/single-choice/);
    expect(() => encodeClaudeClarificationAnswer(input, parsed, { "Which color?": ["Red", "Red"] })).toThrow(/single-choice/);
  });

  it("enforces multi-select limits and the aggregate answer cap", () => {
    const input = claudeInput({ questions: [claudeQuestion({ multiSelect: true })] });
    const parsed = parseClaudeClarification(input);
    expect(() => encodeClaudeClarificationAnswer(input, parsed, { "Which color?": ["a", "a"] })).toThrow(/duplicate/);
    expect(() => encodeClaudeClarificationAnswer(input, parsed, {
      "Which color?": ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    })).toThrow(/at most 8/);
    // Exactly at the aggregate cap passes.
    const atCap = encodeClaudeClarificationAnswer(input, parsed, {
      "Which color?": Array.from({ length: 8 }, (_, i) => `${i}${"x".repeat(2047)}`),
    });
    expect(atCap.updatedInput.answers["Which color?"]).toContain(", ");
    // One char over the cap rejects.
    expect(() => encodeClaudeClarificationAnswer(input, parsed, {
      "Which color?": Array.from({ length: 8 }, (_, i) => `${i}${"x".repeat(2048)}`),
    })).toThrow(/aggregate/);
  });

  it("handles a __proto__ question text as a safe own property", () => {
    const input = claudeInput({ questions: [claudeQuestion({ question: "__proto__" })] });
    const parsed = parseClaudeClarification(input);
    expect(parsed.questions[0].id).toBe("__proto__");
    const answers = ownObject([["__proto__", ["free text"]]]);
    const wire = encodeClaudeClarificationAnswer(input, parsed, answers);
    expect(Object.hasOwn(wire.updatedInput.answers, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(wire.updatedInput.answers)).toBe(Object.prototype);
    expect(wire.updatedInput.answers["__proto__"]).toBe("free text");
  });
});

const asyncItem = (over = {}) => ({
  type: "agentMessage",
  id: "item-abc",
  delivery: "async",
  ...over,
});

const asyncParams = (over = {}) => ({
  threadId: "th-1",
  turnId: "tu-1",
  item: asyncItem({
    text: "thinking out loud",
    questions: [{ title: "Which visual style should I use?", options: ["Graphite", "Light"] }],
  }),
  ...over,
});

describe("parseCodexAsyncClarification", () => {
  it("parses the live async agentMessage shape with ordinal display ids", () => {
    const parsed = parseCodexAsyncClarification(asyncParams());
    expect(parsed).toEqual({
      nativeThreadId: "th-1",
      nativeTurnId: "tu-1",
      nativeItemId: "item-abc",
      isBlocking: false,
      questions: [{
        id: "0",
        header: "Question 1",
        question: "Which visual style should I use?",
        options: [
          { label: "Graphite", description: "" },
          { label: "Light", description: "" },
        ],
        multiSelect: false,
        isOther: true,
      }],
    });
    expect(parsed.nativeItemId).toBe("item-abc");
    expect(parsed.questions[0].id).not.toBe("item-abc");
  });

  it("ignores unconsumed extras including item text without exposing raw payload", () => {
    const parsed = parseCodexAsyncClarification(asyncParams({
      extraTop: "ignored",
      item: asyncItem({
        text: "do not leak this raw text",
        extraItem: 1,
        questions: [{ title: "Q?", options: null, extraQ: true }],
      }),
    }));
    expect(parsed.isBlocking).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("do not leak this raw text");
    expect(JSON.stringify(parsed)).not.toContain("extraItem");
  });

  it("accepts absent or null options as free text and preserves order", () => {
    const parsed = parseCodexAsyncClarification(asyncParams({
      item: asyncItem({
        questions: [
          { title: "First?" },
          { title: "Second?", options: null },
          { title: "Third?", options: ["Only"] },
        ],
      }),
    }));
    expect(parsed.questions.map((q) => q.question)).toEqual(["First?", "Second?", "Third?"]);
    expect(parsed.questions[0].options).toBe(null);
    expect(parsed.questions[1].options).toBe(null);
    expect(parsed.questions.map((q) => q.id)).toEqual(["0", "1", "2"]);
    expect(parsed.questions.map((q) => q.header)).toEqual(["Question 1", "Question 2", "Question 3"]);
  });

  it("rejects wrong item type or delivery", () => {
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ delivery: "sync" }),
    }))).toThrow(/delivery/);
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ type: "text" }),
    }))).toThrow(/type/);
    expect(() => parseCodexAsyncClarification(asyncParams({ item: "nope" }))).toThrow(/item/);
  });

  it("rejects missing or oversize native ids", () => {
    expect(() => parseCodexAsyncClarification(asyncParams({ threadId: "" }))).toThrow(/threadId/);
    expect(() => parseCodexAsyncClarification(asyncParams({ turnId: "x".repeat(129) }))).toThrow(/turnId/);
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ id: "" }),
    }))).toThrow(/itemId/);
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ id: "x".repeat(129) }),
    }))).toThrow(/itemId/);
    const { threadId, ...rest } = asyncParams();
    void threadId;
    expect(() => parseCodexAsyncClarification(rest)).toThrow(/threadId/);
  });

  it("rejects question and option bound violations and duplicates", () => {
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ questions: [] }),
    }))).toThrow(/questions/);
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ questions: ["a", "b", "c", "d", "e"].map((title) => ({ title })) }),
    }))).toThrow(/questions/);
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ questions: [{ title: "" }] }),
    }))).toThrow(/title/);
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ questions: [{ title: "x".repeat(2049) }] }),
    }))).toThrow(/title/);
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ questions: [{ title: "Q?", options: [] }] }),
    }))).toThrow(/options/);
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ questions: [{ title: "Q?", options: Array.from({ length: 9 }, (_, i) => `L${i}`) }] }),
    }))).toThrow(/options/);
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ questions: [{ title: "Q?", options: ["Dup", "Dup"] }] }),
    }))).toThrow(/duplicate/);
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ questions: [{ title: "Q?", options: [""] }] }),
    }))).toThrow(/option/);
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ questions: [{ title: "Q?", options: ["x".repeat(257)] }] }),
    }))).toThrow(/option/);
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ questions: [{ title: "Q?", options: [42] }] }),
    }))).toThrow(/option/);
    expect(() => parseCodexAsyncClarification(null)).toThrow();
  });

  it("rejects aggregate display text over the cap", () => {
    const big = (n) => "x".repeat(n);
    const full = () => ({ title: big(2048), options: Array.from({ length: 8 }, (_, i) => `L${i}${big(254)}`) });
    expect(() => parseCodexAsyncClarification(asyncParams({
      item: asyncItem({ questions: [full(), full(), full(), full()] }),
    }))).toThrow(/aggregate/);
  });
});

describe("encodeCodexAsyncClarificationAnswer", () => {
  it("encodes ordered user text without defaults and mutates nothing", () => {
    const parsed = parseCodexAsyncClarification(asyncParams({
      item: asyncItem({
        questions: [
          { title: "Which visual style should I use?", options: ["Graphite", "Light"] },
          { title: "Free text?", options: null },
        ],
      }),
    }));
    const answers = { 0: ["Graphite"], 1: ["custom words"] };
    const before = [snapshot(parsed), snapshot(answers)];
    const text = encodeCodexAsyncClarificationAnswer(parsed, answers);
    expect(typeof text).toBe("string");
    expect(text.startsWith("Answers to your questions:\n")).toBe(true);
    expect(JSON.parse(text.slice("Answers to your questions:\n".length))).toEqual([
      { question: "Which visual style should I use?", answers: ["Graphite"] },
      { question: "Free text?", answers: ["custom words"] },
    ]);
    expect(snapshot(parsed)).toBe(before[0]);
    expect(snapshot(answers)).toBe(before[1]);
  });

  it("rejects missing, unknown, blank, and too-many answers", () => {
    const parsed = parseCodexAsyncClarification(asyncParams({
      item: asyncItem({
        questions: [{ title: "A?" }, { title: "B?" }],
      }),
    }));
    expect(() => encodeCodexAsyncClarificationAnswer(parsed, { 0: ["x"] })).toThrow(/every question/);
    expect(() => encodeCodexAsyncClarificationAnswer(parsed, { 0: ["x"], 1: ["y"], 2: ["z"] })).toThrow(/every question/);
    expect(() => encodeCodexAsyncClarificationAnswer(parsed, { 0: ["x"], 2: ["y"] })).toThrow(/unknown/);
    expect(() => encodeCodexAsyncClarificationAnswer(parsed, { 0: [""], 1: ["y"] })).toThrow();
    expect(() => encodeCodexAsyncClarificationAnswer(parsed, { 0: ["   "], 1: ["y"] })).toThrow();
    expect(() => encodeCodexAsyncClarificationAnswer(parsed, { 0: ["a", "b"], 1: ["y"] })).toThrow(/single-choice/);
    expect(() => encodeCodexAsyncClarificationAnswer(parsed, { 0: ["x".repeat(4097)], 1: ["y"] })).toThrow(/at most 4096/);
  });

  it("rejects malformed async parsed input and never trusts frontend questions", () => {
    const parsed = parseCodexAsyncClarification(asyncParams());
    const clone = () => JSON.parse(JSON.stringify(parsed));
    const tamperedId = clone();
    tamperedId.questions[0].id = "item-abc";
    expect(() => encodeCodexAsyncClarificationAnswer(tamperedId, { 0: ["x"] })).toThrow();
    const tamperedFlags = clone();
    tamperedFlags.questions[0].multiSelect = true;
    expect(() => encodeCodexAsyncClarificationAnswer(tamperedFlags, { 0: ["x"] })).toThrow();
    const blocking = parseCodexClarification(codexParams());
    expect(() => encodeCodexAsyncClarificationAnswer(blocking, { q1: ["x"] })).toThrow();
    expect(() => encodeCodexAsyncClarificationAnswer({ questions: [] }, { 0: ["x"] })).toThrow();
    expect(() => encodeCodexAsyncClarificationAnswer(parsed, null)).toThrow();
  });
});
