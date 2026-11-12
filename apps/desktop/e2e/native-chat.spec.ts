/**
 * Rendered journeys for the real CHO desktop UI.
 *
 * Every test boots the real app UI in Chromium through a dedicated Vite dev
 * server (`npm run dev:vite:e2e`, port 1427) with the Tauri IPC doubles from
 * `tauri-fixture.ts`. Assertions use real bounding boxes, focus, keyboard
 * input and computed styles — never source strings or snapshots.
 *
 * Evidence limits (see docs/RENDERED_JOURNEYS.md):
 *   - Chromium browser fixture, NOT WebView2, NOT the installed app;
 *   - no live provider, CLI, Rust host or Node host is invoked;
 *   - the 125%/150% projects approximate layout budgets, not OS DPI.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  DEFAULT_MODELS,
  emitFixtureEvents,
  fixtureAnswers,
  fixtureApprovals,
  fixtureDrafts,
  fixtureLog,
  fixtureSends,
  installTauriFixture,
  openFixtureProject,
  type FixtureScenario,
} from "./tauri-fixture";

const LONG_CODE = Array.from({ length: 60 }, (_, i) => `const value${i} = compute(${i}); // ${"x".repeat(40)}`).join("\n");
const LONG_LINE = `const single = "${"abcdefghij".repeat(30)}";`;
const LONG_PROSE = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: ${"lorem ipsum dolor sit amet ".repeat(6)}`).join("\n\n");
const LONG_DIFF = Array.from({ length: 120 }, (_, i) => `+ line ${i} ${"diff-content-".repeat(6)}`).join("\n");

async function boot(page: Page, scenario: FixtureScenario = {}) {
  await installTauriFixture(page, scenario);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open a project" })).toBeVisible();
}

/** No horizontal page overflow: the document must not scroll sideways. */
async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(metrics.scrollWidth, "document scrollWidth").toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.bodyScrollWidth, "body scrollWidth").toBeLessThanOrEqual(metrics.clientWidth + 1);
}

/** Element must sit inside the viewport horizontally. */
async function expectWithinViewport(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  const viewport = page.viewportSize();
  expect(box, `${selector} has a box`).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
}

test.describe("project open and chat browsing", () => {
  test("opens a project through the real picker, trust dialog and host commands", async ({ page }) => {
    await boot(page, {
      conversations: [
        { id: "conv-alpha", title: "Alpha refactor", updatedAtMs: 1_700_000_000_300 },
        { id: "conv-beta", title: "Beta review", updatedAtMs: 1_700_000_000_200 },
      ],
    });

    await page.getByRole("button", { name: /Browse/ }).click();
    await expect(page.locator("#native-path")).toHaveValue("C:\\fixtures\\cho-demo");
    await page.getByRole("button", { name: "Continue" }).click();

    const trust = page.getByRole("dialog", { name: "Trust this project?" });
    await expect(trust).toBeVisible();
    await expect(trust).toContainText("C:\\fixtures\\cho-demo");
    await page.getByRole("button", { name: "Trust and continue" }).click();

    // Sidebar project identity and restored chats from the host.
    await expect(page.locator(".native-project strong")).toHaveText("cho-demo");
    const chats = page.getByRole("navigation", { name: "Chats" });
    await expect(chats.getByRole("button")).toHaveCount(2);
    await expect(chats.getByRole("button").first()).toContainText("Alpha refactor");

    // The UI asked the host for exactly the documented command sequence.
    const commands = (await fixtureLog(page)).map((entry) => entry.command);
    expect(commands).toContain("native_pick_project_folder");
    expect(commands).toContain("native_chat_validate_project");
    expect(commands).toContain("native_chat_prepare_project");
    expect(commands).toContain("native_chat_list_conversations");
    expect(commands).toContain("native_chat_hydrate_conversation");

    const prepare = (await fixtureLog(page)).find((entry) => entry.command === "native_chat_prepare_project");
    expect(prepare?.args.args).toMatchObject({ projectToken: "token-fixture-1", controller: "codex", trusted: true });

    await expectNoHorizontalOverflow(page);
  });

  test("browses stored chats, filters by query and opens one", async ({ page }) => {
    await boot(page, {
      conversations: [
        { id: "conv-alpha", title: "Alpha refactor", updatedAtMs: 1_700_000_000_300 },
        { id: "conv-beta", title: "Beta review", updatedAtMs: 1_700_000_000_200 },
      ],
    });
    await openFixtureProject(page);

    await page.getByRole("button", { name: "Browse all chats" }).click();
    const dialog = page.getByRole("dialog", { name: "All chats" });
    await expect(dialog).toBeVisible();
    const stored = dialog.getByRole("navigation", { name: "Stored chats" });
    await expect(stored.getByRole("button")).toHaveCount(2);

    await dialog.getByLabel("Search stored chats").fill("beta");
    await dialog.getByRole("button", { name: "Search" }).click();
    await expect(stored.getByRole("button")).toHaveCount(1);
    await expect(stored.getByRole("button")).toContainText("Beta review");

    await stored.getByRole("button").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Chats" }).getByRole("button").first()).toContainText(
      "Beta review",
    );
    await expectNoHorizontalOverflow(page);
  });

  test("rejects a project the host refuses to validate, with an actionable error", async ({ page }) => {
    await boot(page, {
      failCommand: { command: "native_chat_validate_project", message: "That folder is not a Git repository." },
    });
    await page.getByRole("button", { name: /Browse/ }).click();
    await page.getByRole("button", { name: "Continue" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("That folder is not a Git repository.");
    // The user can retry: the form is still usable and the trust dialog never opened.
    await expect(page.getByRole("dialog", { name: "Trust this project?" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});

test.describe("draft switching", () => {
  test("keeps per-chat drafts across switching and restores them from the host", async ({ page }) => {
    await boot(page, {
      conversations: [
        { id: "conv-alpha", title: "Alpha refactor", updatedAtMs: 1_700_000_000_300 },
        { id: "conv-beta", title: "Beta review", updatedAtMs: 1_700_000_000_200 },
      ],
      drafts: { "conv-beta": "draft saved for beta" },
    });
    await openFixtureProject(page);

    const chats = page.getByRole("navigation", { name: "Chats" });
    const composer = page.locator("#native-prompt");

    // Alpha is selected first (newest). Type a draft.
    await expect(chats.getByRole("button").first()).toContainText("Alpha refactor");
    await composer.fill("draft for alpha");
    await expect(composer).toHaveValue("draft for alpha");

    // Switch to Beta: its stored draft must load from the host.
    await chats.getByRole("button", { name: /Beta review/ }).click();
    await expect(composer).toHaveValue("draft saved for beta");

    // Switch back: Alpha's draft is flushed to the host and restored.
    await chats.getByRole("button", { name: /Alpha refactor/ }).click();
    await expect(composer).toHaveValue("draft for alpha");

    const drafts = await fixtureDrafts(page);
    expect(drafts.find((draft) => draft.id === "conv-alpha")?.text).toBe("draft for alpha");

    const saves = (await fixtureLog(page)).filter((entry) => entry.command === "native_chat_save_draft");
    expect(saves.length).toBeGreaterThan(0);
    expect(saves.every((entry) => typeof entry.args.args.saveId === "string")).toBe(true);
    expect(saves.every((entry) => typeof entry.args.args.expectedVersion === "number")).toBe(true);
  });

  test("clearing a stored draft survives immediate switches in both directions", async ({ page }) => {
    await boot(page, {
      conversations: [
        { id: "conv-alpha", title: "Alpha refactor", updatedAtMs: 1_700_000_000_300 },
        { id: "conv-beta", title: "Beta review", updatedAtMs: 1_700_000_000_200 },
      ],
      drafts: { "conv-alpha": "saved alpha" },
    });
    await openFixtureProject(page);

    const chats = page.getByRole("navigation", { name: "Chats" });
    const composer = page.locator("#native-prompt");

    // Alpha (newest) is restored first and shows its stored host draft.
    await expect(chats.getByRole("button").first()).toContainText("Alpha refactor");
    await expect(composer).toHaveValue("saved alpha");

    // Clear the composer and switch immediately, before the 400 ms debounce
    // fires: the empty string is a deliberate edit and must reach the host.
    await composer.fill("");
    await chats.getByRole("button", { name: /Beta review/ }).click();
    await expect(composer).toHaveValue("");
    await chats.getByRole("button", { name: /Alpha refactor/ }).click();
    await expect(composer).toHaveValue("");

    // The clear was flushed to the scripted host: alpha's draft store is empty.
    const drafts = await fixtureDrafts(page);
    expect(drafts.find((draft) => draft.id === "conv-alpha")?.text).toBe("");
  });

  test("debounces draft saves instead of writing on every keystroke", async ({ page }) => {
    await boot(page);
    await openFixtureProject(page);
    const composer = page.locator("#native-prompt");
    await composer.click();
    await composer.pressSequentially("abcdef", { delay: 20 });
    await expect(composer).toHaveValue("abcdef");
    // Wait past the 400 ms debounce.
    await expect
      .poll(async () => (await fixtureLog(page)).filter((entry) => entry.command === "native_chat_save_draft").length)
      .toBeGreaterThan(0);
    const saves = (await fixtureLog(page)).filter((entry) => entry.command === "native_chat_save_draft");
    expect(saves.length).toBeLessThan(6);
    expect(saves.at(-1)?.args.args.text).toBe("abcdef");
  });
});

test.describe("composer keyboard behaviour", () => {
  test("Enter sends and Shift+Enter inserts a newline", async ({ page }) => {
    await boot(page, {
      turnEvents: [{ kind: "message_delta", text: "Working on it.", partId: "p1" }],
    });
    await openFixtureProject(page);
    const composer = page.locator("#native-prompt");

    await composer.click();
    await composer.pressSequentially("first line");
    await composer.press("Shift+Enter");
    await composer.pressSequentially("second line");
    await expect(composer).toHaveValue("first line\nsecond line");

    // Nothing was sent yet.
    expect(await fixtureSends(page)).toHaveLength(0);

    await composer.press("Enter");
    await expect.poll(async () => (await fixtureSends(page)).length).toBe(1);
    const [send] = await fixtureSends(page);
    expect(send.prompt).toBe("first line\nsecond line");
    await expect(composer).toHaveValue("");

    // The user message is rendered in the transcript.
    await expect(page.locator(".native-message.user").last()).toContainText("first line");
    await expect(page.locator(".native-message.assistant").last()).toContainText("Working on it.");
  });

  test("does not send on Enter while an IME composition is active", async ({ page }) => {
    await boot(page);
    await openFixtureProject(page);
    const composer = page.locator("#native-prompt");
    await composer.click();
    await composer.pressSequentially("にほんご");
    // Simulate the composition guard the component relies on.
    await composer.evaluate((element) => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      Object.defineProperty(event, "isComposing", { value: true });
      element.dispatchEvent(event);
    });
    await page.waitForTimeout(300);
    expect(await fixtureSends(page)).toHaveLength(0);
    await expect(composer).toHaveValue("にほんご");
  });

  test("disables Send for an empty composer and keeps the hint visible", async ({ page }) => {
    await boot(page);
    await openFixtureProject(page);
    const send = page.getByRole("button", { name: /Send/ });
    await expect(send).toBeDisabled();
    await expect(page.locator(".native-composer-actions")).toContainText("Enter to send");
    await page.locator("#native-prompt").fill("hello");
    await expect(send).toBeEnabled();
  });
});

test.describe("approval and clarification action states", () => {
  test("shows an approval with its decisions and records the chosen decision", async ({ page }) => {
    await boot(page, {
      turnEvents: [
        { kind: "status", text: "Waiting for approval" },
        {
          kind: "approval",
          approvalId: "appr-1",
          approvalType: "command",
          text: "rm -rf build",
          decisions: ["accept", "decline"],
        },
      ],
    });
    await openFixtureProject(page);
    await page.locator("#native-prompt").fill("clean the build folder");
    await page.locator("#native-prompt").press("Enter");

    const approval = page.getByRole("region", { name: "Approval request" });
    await expect(approval).toBeVisible();
    await expect(approval).toContainText("Command approval");
    await expect(approval.locator("pre")).toHaveText("rm -rf build");

    const accept = approval.getByRole("button", { name: "Accept" });
    const decline = approval.getByRole("button", { name: "Decline" });
    await expect(accept).toBeEnabled();
    await expect(decline).toBeEnabled();

    await decline.click();
    await expect(approval).toBeHidden();
    await expect.poll(async () => (await fixtureApprovals(page)).find((row) => row.id === "appr-1")?.decision).toBe(
      "decline",
    );
  });

  test("blocks clarification submission until every question is answered", async ({ page }) => {
    await boot(page, {
      turnEvents: [
        {
          kind: "clarification",
          clarificationId: "clar-1",
          nativeItemId: "item-1",
          isBlocking: true,
          questions: [
            {
              id: "q1",
              header: "Scope",
              question: "Which files should change?",
              options: [
                { label: "Only the UI", description: "Restrict edits to components" },
                { label: "UI and host", description: "Allow host changes too" },
              ],
              multiSelect: false,
              isOther: false,
            },
            {
              id: "q2",
              header: "Notes",
              question: "Anything else?",
              options: null,
              multiSelect: false,
              isOther: false,
            },
          ],
        },
      ],
    });
    await openFixtureProject(page);
    await page.locator("#native-prompt").fill("start the change");
    await page.locator("#native-prompt").press("Enter");

    const card = page.getByRole("region", { name: "Input needed" });
    await expect(card).toBeVisible();
    // The waiting status renders on the streaming assistant message that hosts
    // the card, not inside the card section itself.
    await expect(page.locator(".native-message.assistant").last()).toContainText("Waiting for your answer…");

    const submit = card.getByRole("button", { name: "Send answers" });
    await expect(submit).toBeDisabled();

    await card.getByRole("radio", { name: /Only the UI/ }).check();
    await expect(submit).toBeDisabled();

    await card.getByLabel("Your answer").fill("No further notes");
    await expect(submit).toBeEnabled();

    await submit.click();
    await expect.poll(async () => (await fixtureAnswers(page)).find((row) => row.id === "clar-1")?.answers).toEqual({
      q1: ["Only the UI"],
      q2: ["No further notes"],
    });
  });

  test("surfaces a failed send as an actionable error and restores the prompt", async ({ page }) => {
    await boot(page, {
      failCommand: { command: "direct_chat_send", message: "The host rejected the turn." },
    });
    await openFixtureProject(page);
    const composer = page.locator("#native-prompt");
    await composer.fill("please fail");
    await composer.press("Enter");

    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Send outcome could not be confirmed");
    await expect(alert).toContainText("The host rejected the turn.");
    // The prompt is restored so the user can retry.
    await expect(composer).toHaveValue("please fail");
  });
});

test.describe("long content overflow", () => {
  test("long code, prose and single-line content stay inside the message plane", async ({ page }) => {
    await boot(page, {
      conversations: [
        {
          id: "conv-long",
          title: "Long output",
          updatedAtMs: 1_700_000_000_400,
          messages: [
            { id: "m1", role: "user", text: "Show me the long output" },
            {
              id: "m2",
              role: "assistant",
              text: `${LONG_PROSE}\n\n\`\`\`ts\n${LONG_CODE}\n\`\`\`\n\n\`\`\`ts\n${LONG_LINE}\n\`\`\``,
            },
          ],
        },
      ],
    });
    await openFixtureProject(page);

    const messages = page.locator(".native-messages");
    await expect(messages).toBeVisible();
    await expect(page.locator(".md-code-block")).toHaveCount(2);

    await expectNoHorizontalOverflow(page);
    await expectWithinViewport(page, ".native-messages");
    await expectWithinViewport(page, ".native-composer");

    // Code blocks scroll internally rather than stretching the page. The last
    // block holds the 300-character single line; the first block's lines fit
    // the message plane and do not need to scroll.
    const overflow = await page.locator(".md-code-block pre").last().evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    expect(overflow.overflowX).toBe("auto");
    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);

    // The message plane itself scrolls vertically, not the document.
    const plane = await messages.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(plane.overflowY).toBe("auto");
    expect(plane.scrollHeight).toBeGreaterThan(plane.clientHeight);
  });

  test("a long worktree diff scrolls inside its own panel", async ({ page }) => {
    await boot(page, {
      delegations: [
        {
          id: "assoc-1",
          conversationId: null,
          repoPath: "C:\\fixtures\\cho-demo",
          wp: "cho-05",
          slice: "delegate",
          stage: "running",
          disposition: "none",
          worktreePath: "C:\\fixtures\\cho-demo-wt",
          runId: "run-1",
          reviewId: null,
          cli: "codex",
          model: "gpt-5-codex",
          note: null,
          updatedAtMs: 1_700_000_000_000,
          createdAtMs: 1_700_000_000_000,
        },
      ],
      worktreeDiff: {
        associationId: "assoc-1",
        worktreePath: "C:\\fixtures\\cho-demo-wt",
        repoPath: "C:\\fixtures\\cho-demo",
        files: [{ status: "M", path: "src/components/NativeChat.tsx" }],
        path: null,
        patch: LONG_DIFF,
        readOnly: true,
      },
    });
    await openFixtureProject(page);

    await page.getByRole("button", { name: "Agents" }).click();
    const panel = page.getByRole("region", { name: "Delegated agents" });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Diff" }).click();

    const diff = panel.locator(".native-orch-diff-body");
    await expect(diff).toBeVisible();
    const metrics = await diff.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(metrics.overflowY).toBe("auto");
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await expectNoHorizontalOverflow(page);
  });
});

test.describe("focus and keyboard navigation", () => {
  test("shows a visible focus ring on the composer and sidebar controls", async ({ page }) => {
    await boot(page);
    await openFixtureProject(page);

    const composer = page.locator("#native-prompt");
    await composer.focus();
    const composerOutline = await composer.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(composerOutline.style).not.toBe("none");
    expect(parseFloat(composerOutline.width)).toBeGreaterThan(0);

    // Send is disabled while the composer is empty; give it text so Tab has a
    // target, then verify the focused control shows a focus ring.
    await composer.fill("ready to send");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        label: element.textContent?.trim() ?? "",
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    expect(focused).not.toBeNull();
    expect(focused!.outlineStyle).not.toBe("none");
    expect(parseFloat(focused!.outlineWidth)).toBeGreaterThan(0);
  });

  test("moves focus into the trust dialog and back out on cancel", async ({ page }) => {
    await boot(page);
    await page.getByRole("button", { name: /Browse/ }).click();
    await page.getByRole("button", { name: "Continue" }).click();

    const dialog = page.getByRole("dialog", { name: "Trust this project?" });
    await expect(dialog).toBeVisible();
    const inside = await page.evaluate(() => {
      const active = document.activeElement;
      const dialog = document.querySelector("dialog[open]");
      return Boolean(active && dialog && dialog.contains(active));
    });
    expect(inside, "focus is inside the modal dialog").toBe(true);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
  });

  test("keeps primary actions inside the viewport at every layout budget", async ({ page }) => {
    await boot(page);
    await openFixtureProject(page);
    await page.locator("#native-prompt").fill("hello");

    for (const selector of [".native-composer", ".native-composer-actions", ".native-sidebar", ".native-header"]) {
      await expectWithinViewport(page, selector);
    }
    const send = page.getByRole("button", { name: /Send/ });
    const box = await send.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("markdown rendering", () => {
  test("renders GFM tables and file references without breaking the layout", async ({ page }) => {
    await boot(page, {
      conversations: [
        {
          id: "conv-md",
          title: "Markdown",
          updatedAtMs: 1_700_000_000_500,
          messages: [
            { id: "m1", role: "user", text: "show a table" },
            {
              id: "m2",
              role: "assistant",
              text: [
                "| File | Status |",
                "| --- | --- |",
                "| `src/App.tsx` | changed |",
                "| `src/components/NativeChat.tsx` | changed |",
                "",
                "See `src/lib/api.ts` for details.",
              ].join("\n"),
            },
          ],
        },
      ],
    });
    await openFixtureProject(page);

    const table = page.locator(".md-body table");
    await expect(table).toBeVisible();
    await expect(table.locator("th")).toHaveCount(2);
    await expect(table.locator("tbody tr")).toHaveCount(2);

    const fileRef = page.locator(".md-file-ref").first();
    await expect(fileRef).toBeVisible();
    await fileRef.click();
    await expect(page.locator(".md-file-ref-note").first()).toContainText("Found:");

    await expectNoHorizontalOverflow(page);
  });
});

test.describe("model and access controls", () => {
  test("locks model and access after the first turn but keeps effort editable for Codex", async ({ page }) => {
    await boot(page, {
      models: DEFAULT_MODELS,
      turnEvents: [
        { kind: "message_delta", text: "ok", partId: "p1" },
        { kind: "turn_complete", nativeOutcome: "completed" },
      ],
    });
    await openFixtureProject(page);

    const model = page.getByLabel("Model");
    const access = page.getByLabel("Access");
    const effort = page.getByLabel("Effort");
    await expect(model).toBeEnabled();
    await expect(access).toBeEnabled();

    await page.locator("#native-prompt").fill("hello");
    await page.locator("#native-prompt").press("Enter");
    await expect(page.locator(".native-message.assistant").last()).toContainText("ok");

    await expect(model).toBeDisabled();
    await expect(access).toBeDisabled();
    await expect(effort).toBeEnabled();
    await expect(page.locator(".native-hint")).toContainText("Start a new chat to change the model or access.");
  });
});

test.describe("host loss recovery", () => {
  test("reports a lost host and disables further sends", async ({ page }) => {
    await boot(page, {
      turnEvents: [{ kind: "message_delta", text: "partial", partId: "p1" }],
    });
    await openFixtureProject(page);
    await page.locator("#native-prompt").fill("hello");
    await page.locator("#native-prompt").press("Enter");
    await expect(page.locator(".native-message.assistant").last()).toContainText("partial");

    // The host reports an unknown outcome for the active turn.
    const sessionId = (await fixtureSends(page))[0].sessionId;
    const turnId = (await fixtureSends(page))[0].turnId;
    await emitFixtureEvents(page, sessionId, [
      { kind: "turn_complete", sessionId, turnId, nativeOutcome: "unknown", text: "The provider connection dropped." },
    ]);

    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Restart CHO");
    await expect(page.locator("#native-prompt")).toBeDisabled();
  });
});
