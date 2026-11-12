/**
 * Deterministic Tauri IPC doubles for the rendered browser journeys.
 *
 * The real app boots `NativeChat` only when `isTauriRuntime()` is true, and the
 * real `@tauri-apps/api` core calls `window.__TAURI_INTERNALS__.invoke(cmd,
 * args, options)`. This module installs that surface with `page.addInitScript`
 * *before* the app bundle runs, so the production component tree renders
 * unchanged — no bypass flag, no mirrored shell, no host admission change.
 *
 * Everything below is a browser-side double:
 *   - it is NOT WebView2, NOT the installed app, NOT a live provider;
 *   - it does not exercise Rust, the Node host, or any CLI;
 *   - it answers the same command names and payload shapes the real host uses
 *     (see apps/desktop/src-tauri/src/lib.rs and apps/desktop/server/host.mjs).
 *
 * The scripted host is a small state machine: validate -> prepare -> poll,
 * with send/approval/clarification/draft/conversation commands driven by the
 * scenario. Every invoke is recorded on `window.__CHO_FIXTURE__` so specs can
 * assert what the UI actually asked for.
 */
import type { Page } from "@playwright/test";

export type FixtureController = "codex" | "claude";

export interface FixtureModel {
  id: string;
  name: string;
  isDefault?: boolean;
  supportedEfforts?: string[];
}

export interface FixtureConversation {
  id: string;
  title: string;
  controller?: FixtureController;
  modelRequested?: string | null;
  role?: "implement" | "review" | null;
  effort?: string | null;
  updatedAtMs?: number;
  archived?: boolean;
  messages?: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    tools?: Array<{ id: string; title: string; status: string }>;
    outcome?: string;
    isError?: boolean;
    isStreaming?: boolean;
  }>;
  hasMoreEvents?: boolean;
}

export interface FixtureScenario {
  /** Folder returned by the native folder picker. */
  pickPath?: string | null;
  /** Project name shown in the sidebar/header. */
  projectName?: string;
  /** Absolute project path echoed by validate/prepare. */
  projectPath?: string;
  controller?: FixtureController;
  models?: FixtureModel[];
  /** Stored conversations returned by list/hydrate. */
  conversations?: FixtureConversation[];
  /** Draft text keyed by conversation id, returned by get_draft. */
  drafts?: Record<string, string>;
  /** Events the host emits for the first send, in order. */
  turnEvents?: FixtureEvent[];
  /** Force a command to reject with this message. */
  failCommand?: { command: string; message: string };
  /** Orch dashboard payload for the Agents panel. */
  orchDashboard?: Record<string, unknown>;
  /** Delegation associations for the Agents panel. */
  delegations?: Array<Record<string, unknown>>;
  /** Worktree diff payload for the Agents panel Diff action. */
  worktreeDiff?: Record<string, unknown>;
}

export type FixtureEvent =
  | { kind: "message_delta"; text: string; partId?: string }
  | { kind: "status"; text: string }
  | { kind: "tool_call"; toolCallId: string; toolTitle: string; toolStatus?: string }
  | {
      kind: "approval";
      approvalId: string;
      approvalType: "command" | "file" | "tool";
      text: string;
      decisions?: Array<"accept" | "decline" | "cancel">;
    }
  | {
      kind: "clarification";
      clarificationId: string;
      nativeItemId: string;
      isBlocking?: boolean;
      questions: Array<{
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }> | null;
        multiSelect: boolean;
        isOther: boolean;
      }>;
    }
  | { kind: "turn_complete"; nativeOutcome?: "completed" | "failed" | "interrupted" | "unknown"; text?: string }
  | { kind: "error"; text: string };

export const DEFAULT_MODELS: FixtureModel[] = [
  { id: "gpt-5-codex", name: "GPT-5 Codex", isDefault: true },
  { id: "gpt-5-codex-mini", name: "GPT-5 Codex Mini" },
];

/**
 * Installs the doubles. Must be awaited before `page.goto`.
 */
export async function installTauriFixture(page: Page, scenario: FixtureScenario = {}) {
  await page.addInitScript(
    ({ scenarioJson }) => {
      const scenario = JSON.parse(scenarioJson) as Record<string, any>;
      const log: Array<{ command: string; args: any; at: number }> = [];
      const callbacks = new Map<number, (payload: unknown) => void>();
      let nextCallbackId = 1;

      const projectPath = scenario.projectPath ?? "C:\\fixtures\\cho-demo";
      const projectName = scenario.projectName ?? "cho-demo";
      const controller = scenario.controller ?? "codex";
      const generation = "gen-fixture-1";
      const projectToken = "token-fixture-1";
      const models = scenario.models ?? [
        { id: "gpt-5-codex", name: "GPT-5 Codex", isDefault: true },
        { id: "gpt-5-codex-mini", name: "GPT-5 Codex Mini" },
      ];

      // --- scripted host state -------------------------------------------
      const drafts = new Map<string, { text: string; version: number }>();
      for (const [id, text] of Object.entries(scenario.drafts ?? {})) {
        drafts.set(id, { text: String(text), version: 1 });
      }
      const conversations = new Map<string, Record<string, any>>();
      for (const row of scenario.conversations ?? []) {
        conversations.set(row.id, {
          controller,
          modelRequested: models[0]?.id ?? null,
          role: "implement",
          effort: "medium",
          updatedAtMs: 1_700_000_000_000,
          archived: false,
          messages: [],
          ...row,
        });
      }
      /** Events queued for the next poll, keyed by conversation id. */
      const pending = new Map<string, Array<Record<string, any>>>();
      const sentTurns: Array<{ sessionId: string; turnId: string; prompt: string }> = [];
      const approvals = new Map<string, { sessionId: string; turnId: string; decision?: string }>();
      const clarifications = new Map<string, { sessionId: string; turnId: string; answers?: Record<string, string[]> }>();
      let closed = false;

      const queue = (conversationId: string, events: Array<Record<string, any>>) => {
        const list = pending.get(conversationId) ?? [];
        list.push(...events);
        pending.set(conversationId, list);
      };

      const turnEvents = (sessionId: string, turnId: string, events: Array<Record<string, any>>) =>
        events.map((event) => ({ generation, sessionId, turnId, ...event }));

      function fail(command: string): never {
        throw new Error(scenario.failCommand?.message ?? `fixture failure for ${command}`);
      }

      function handle(command: string, args: Record<string, any>): unknown {
        if (scenario.failCommand && scenario.failCommand.command === command) fail(command);
        switch (command) {
          case "native_pick_project_folder":
            return scenario.pickPath === undefined ? projectPath : scenario.pickPath;
          case "native_chat_validate_project":
            return { generation, controller, path: args.path ?? projectPath, name: projectName, projectToken };
          case "native_chat_prepare_project":
            return {
              generation,
              controller,
              projectToken,
              path: projectPath,
              name: projectName,
              models,
            };
          case "native_chat_poll": {
            const conversationId = args.conversationId as string | undefined;
            const events = conversationId ? pending.get(conversationId) ?? [] : [];
            if (conversationId) pending.set(conversationId, []);
            return {
              generation,
              events,
              cursor: conversationId ? { instanceId: "inst-1", conversationId, seq: 1 } : null,
              tip: 1,
              hasMore: false,
              ...(conversationId ? { conversationId } : {}),
            };
          }
          case "direct_chat_send": {
            const sessionId = String(args.sessionId);
            const turnId = String(args.turnId);
            sentTurns.push({ sessionId, turnId, prompt: String(args.prompt ?? "") });
            const events = (scenario.turnEvents ?? []) as Array<Record<string, any>>;
            queue(sessionId, turnEvents(sessionId, turnId, events));
            for (const event of events) {
              if (event.kind === "approval") {
                approvals.set(String(event.approvalId), { sessionId, turnId });
              }
              if (event.kind === "clarification") {
                clarifications.set(String(event.clarificationId), { sessionId, turnId });
              }
            }
            return {
              generation,
              controller,
              sessionId,
              turnId,
              nativeThreadId: "thread-fixture-1",
              nativeTurnId: `native-${turnId.slice(0, 8)}`,
            };
          }
          case "native_chat_respond": {
            const record = approvals.get(String(args.approvalId));
            if (record) record.decision = String(args.decision);
            return { generation, ok: true };
          }
          case "native_chat_answer": {
            const record = clarifications.get(String(args.clarificationId));
            if (record) record.answers = args.answers;
            return {
              generation,
              controller,
              sessionId: args.sessionId,
              turnId: args.turnId,
              clarificationId: args.clarificationId,
              queued: true,
            };
          }
          case "direct_chat_cancel":
            return { cancelling: true };
          case "native_chat_close":
            closed = true;
            return { closed: true };
          case "native_chat_forget_session":
            return { forgotten: true };
          case "native_chat_save_draft": {
            const conversationId = String(args.conversationId);
            const prior = drafts.get(conversationId);
            const version = (prior?.version ?? 0) + 1;
            drafts.set(conversationId, { text: String(args.text ?? ""), version });
            return { generation, saved: true, receipt: { version } };
          }
          case "native_chat_get_draft": {
            const conversationId = String(args.conversationId);
            const record = drafts.get(conversationId);
            return {
              generation,
              draft: record
                ? { conversationId, text: record.text, version: record.version, updatedAtMs: 1_700_000_000_000 }
                : null,
            };
          }
          case "native_chat_list_draft_conflicts":
            return { generation, conflicts: [] };
          case "native_chat_resolve_draft_conflict":
            return { generation, receipt: { resolved: true } };
          case "native_chat_list_conversations": {
            const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
            const includeArchived = args.includeArchived === true;
            const rows = [...conversations.values()]
              .filter((row) => includeArchived || !row.archived)
              .filter((row) => !query || String(row.title).toLowerCase().includes(query))
              .sort((a, b) => Number(b.updatedAtMs) - Number(a.updatedAtMs))
              .map((row) => ({
                id: row.id,
                controller: row.controller,
                title: row.title,
                modelRequested: row.modelRequested,
                role: row.role,
                effort: row.effort,
                updatedAtMs: row.updatedAtMs,
                archived: row.archived,
              }));
            return { generation, conversations: rows, hasMore: false };
          }
          case "native_chat_hydrate_conversation": {
            const row = conversations.get(String(args.conversationId));
            if (!row) return { generation, conversation: null };
            return {
              generation,
              conversation: {
                conversationId: row.id,
                projectId: "project-fixture",
                controller: row.controller,
                model: row.modelRequested,
                role: row.role,
                effort: row.effort,
                title: row.title,
                nativeThreadId: "thread-fixture-1",
                nativeSessionUuid: null,
                messages: (row.messages ?? []).map((message: Record<string, any>) => ({
                  tools: [],
                  isStreaming: false,
                  ...message,
                })),
                eventTip: 1,
                eventCursor: { instanceId: "inst-1", conversationId: row.id, seq: 1 },
                hasMoreEvents: Boolean(row.hasMoreEvents),
                hasMoreTurns: false,
                hasMoreBytes: false,
              },
            };
          }
          case "native_chat_rename_conversation": {
            const row = conversations.get(String(args.conversationId));
            if (row) row.title = String(args.title);
            return { generation, conversation: row ?? null };
          }
          case "native_chat_archive_conversation": {
            const row = conversations.get(String(args.conversationId));
            if (row) row.archived = Boolean(args.archived);
            return { generation, conversation: row ?? null };
          }
          case "native_chat_export_conversation": {
            const row = conversations.get(String(args.conversationId));
            return {
              generation,
              export: {
                format: "cho-transcript/1",
                conversation: {
                  title: row?.title ?? "Chat",
                  controller,
                  eventTip: 1,
                  messages: (row?.messages ?? []).map((message: Record<string, any>) => ({
                    role: message.role,
                    text: message.text,
                  })),
                  historicalApprovals: [],
                  historicalClarifications: [],
                },
                pagination: {},
                truncated: false,
              },
            };
          }
          case "native_chat_import_transcript":
            return { generation, created: true, conversationId: "imported-1", importBatchId: "batch-1" };
          case "native_chat_acknowledge_stranded":
            return { generation, acknowledged: true, recoveryUnresolved: [] };
          case "project_resolve_path":
            return {
              path: String(args.path ?? ""),
              absolutePath: `${projectPath}\\${String(args.path ?? "").replace(/\//g, "\\")}`,
              exists: true,
            };
          case "host_invoke": {
            const inner = String(args.command ?? "");
            if (inner === "orch_dashboard") {
              return (
                scenario.orchDashboard ?? {
                  repoRoot: projectPath,
                  repositories: [],
                  rosterSource: "fixture",
                  claims: [],
                  worktrees: [],
                  runs: [],
                  roster: [],
                  catalog: [],
                  harnesses: [],
                }
              );
            }
            if (inner === "delegation_list") {
              return { associations: scenario.delegations ?? [] };
            }
            if (inner === "delegation_worktree_diff") {
              return (
                scenario.worktreeDiff ?? {
                  associationId: String(args.args?.id ?? ""),
                  worktreePath: `${projectPath}-wt`,
                  repoPath: projectPath,
                  files: [],
                  path: null,
                  patch: "",
                  readOnly: true,
                }
              );
            }
            if (inner === "orch_gate_status" || inner === "orch_run_detail" || inner === "orch_scope" || inner === "orch_cleanup") {
              return { ok: true, exitCode: 0, output: {}, text: `${inner} fixture`, error: null };
            }
            return { ok: true, exitCode: 0, output: {}, text: `${inner} fixture`, error: null };
          }
          default:
            throw new Error(`fixture: unhandled command ${command}`);
        }
      }

      const internals = {
        invoke(command: string, args: Record<string, any> = {}) {
          log.push({ command, args, at: Date.now() });
          // The real app wraps native payloads as `{ args: payload }` (see
          // invokeNative in src/lib/api.ts) while host_invoke passes
          // `{ command, args }` unwrapped — mirror both shapes exactly.
          const payload =
            args && typeof args === "object" && "args" in args && !("command" in args)
              ? args.args
              : args;
          return new Promise((resolve, reject) => {
            // Async like the real IPC bridge, but resolved on the microtask queue
            // so React state updates stay deterministic.
            Promise.resolve()
              .then(() => handle(command, payload ?? {}))
              .then(resolve, (error) => reject(error instanceof Error ? error.message : String(error)));
          });
        },
        transformCallback(callback: (payload: unknown) => void, once = false) {
          const id = nextCallbackId++;
          callbacks.set(id, (payload) => {
            if (once) callbacks.delete(id);
            callback(payload);
          });
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        convertFileSrc(path: string) {
          return path;
        },
      };

      (window as any).__TAURI_INTERNALS__ = internals;
      (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener() {},
      };
      (window as any).__CHO_FIXTURE__ = {
        log,
        sentTurns,
        approvals,
        clarifications,
        drafts,
        conversations,
        isClosed: () => closed,
        /** Push extra host events into the next poll for a conversation. */
        emit(conversationId: string, events: Array<Record<string, any>>) {
          queue(conversationId, events.map((event) => ({ generation, ...event })));
        },
        generation,
        projectPath,
        projectName,
      };
    },
    { scenarioJson: JSON.stringify(scenario) },
  );
}

/** Reads the recorded invoke log from the page. */
export async function fixtureLog(page: Page) {
  return page.evaluate(() => (window as any).__CHO_FIXTURE__.log as Array<{ command: string; args: any }>);
}

/** Reads the scripted host's recorded sends. */
export async function fixtureSends(page: Page) {
  return page.evaluate(
    () => (window as any).__CHO_FIXTURE__.sentTurns as Array<{ sessionId: string; turnId: string; prompt: string }>,
  );
}

/** Reads the scripted host's recorded approval decisions. */
export async function fixtureApprovals(page: Page) {
  return page.evaluate(
    () =>
      [...((window as any).__CHO_FIXTURE__.approvals as Map<string, { decision?: string }>).entries()].map(
        ([id, record]) => ({ id, decision: record.decision ?? null }),
      ),
  );
}

/** Reads the scripted host's recorded clarification answers. */
export async function fixtureAnswers(page: Page) {
  return page.evaluate(
    () =>
      [...((window as any).__CHO_FIXTURE__.clarifications as Map<string, { answers?: Record<string, string[]> }>).entries()].map(
        ([id, record]) => ({ id, answers: record.answers ?? null }),
      ),
  );
}

/** Reads the scripted host's draft store. */
export async function fixtureDrafts(page: Page) {
  return page.evaluate(
    () =>
      [...((window as any).__CHO_FIXTURE__.drafts as Map<string, { text: string; version: number }>).entries()].map(
        ([id, record]) => ({ id, text: record.text, version: record.version }),
      ),
  );
}

/** Pushes extra host events into the next poll for a conversation. */
export async function emitFixtureEvents(page: Page, conversationId: string, events: Array<Record<string, unknown>>) {
  await page.evaluate(
    ({ conversationId, events }) => (window as any).__CHO_FIXTURE__.emit(conversationId, events),
    { conversationId, events },
  );
}

/** Opens the project through the real UI path: pick folder, continue, trust. */
export async function openFixtureProject(page: Page) {
  await page.getByRole("button", { name: /Browse/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("dialog", { name: "Trust this project?" }).waitFor();
  await page.getByRole("button", { name: "Trust and continue" }).click();
  await page.getByRole("navigation", { name: "Chats" }).waitFor();
}
