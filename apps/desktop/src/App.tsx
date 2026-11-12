import React, { useEffect, useMemo, useRef, useState } from "react";
import type { HarnessId } from "@cho-desktop/acp-client";
import { Dialog, Icon } from "./components/Chrome";
import { FormattedMarkdown } from "./components/FormattedMarkdown";
import { NativeChat } from "./components/NativeChat";
import { startAgentTask } from "./lib/agent-task";
import {
  callHost,
  isTauriRuntime,
  subscribeStreamEvents,
  type HarnessInfo,
  type OrchCommandResult,
  type OrchDashboardData,
  type OrchRunDetail,
  type OrchRunSummary,
  type RepositoryInfo,
  type StreamEventPayload,
} from "./lib/api";

interface ToolStep {
  id: string;
  title: string;
  status: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  harness: HarnessId;
  modelRequested: string;
  modelVerified?: string | null;
  content: string;
  thought?: string;
  tools: ToolStep[];
  statusText?: string;
  isError?: boolean;
  isStreaming?: boolean;
  timestamp: string;
}

interface RepoSession {
  id: string;
  title: string;
  repoPath: string;
  repoName: string;
  orchestratorHarness: HarnessId;
  orchestratorModel: string;
  effort: "low" | "medium" | "high" | "xhigh";
  role: "implement" | "review";
  orchestrateMode: boolean;
  messages: ChatMessage[];
  createdAt: string;
}

const SESSIONS_STORAGE_KEY = "cho-desktop.repo-sessions.v2";

function CollapsibleMessageSteps({
  tools,
  thought,
}: {
  tools: ToolStep[];
  thought?: string;
}) {
  const [open, setOpen] = useState(false);
  if (tools.length === 0 && !thought) return null;

  return (
    <div className="msg-steps-box">
      <button
        type="button"
        className="msg-steps-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={open ? "steps-chevron open" : "steps-chevron"}>
          <Icon name="chevron" size={14} />
        </span>
        {tools.length > 0 && (
          <span className="steps-badge">
            {tools.length} tool {tools.length === 1 ? "call" : "calls"}
          </span>
        )}
        {thought && <span className="steps-badge">Reasoning</span>}
        <span className="steps-preview">
          {tools.length > 0
            ? tools[tools.length - 1].title
            : "Inspect internal steps"}
        </span>
      </button>
      {open && (
        <div className="msg-steps-content">
          {thought && (
            <div className="msg-thought-panel">
              <div className="msg-thought-label">Reasoning</div>
              <pre>{thought}</pre>
            </div>
          )}
          {tools.length > 0 && (
            <div className="msg-tools-list">
              {tools.map((t, idx) => (
                <div key={`${t.id}-${idx}`} className="msg-tool-row">
                  <span className="tool-check">
                    {t.status === "completed" ? (
                      <Icon name="check" size={14} />
                    ) : (
                      <Icon name="terminal" size={14} />
                    )}
                  </span>
                  <code className="tool-title">{t.title}</code>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BrowserApp() {
  const [dashboard, setDashboard] = useState<OrchDashboardData | null>(null);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [repositories, setRepositories] = useState<RepositoryInfo[]>([]);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 700);
  const [activityOpen, setActivityOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return localStorage.getItem("cho-desktop.theme") === "light"
        ? "light"
        : "dark";
    } catch {
      return "dark";
    }
  });
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const refreshingRef = useRef(false);
  const sendingRef = useRef(new Set<string>());
  const [sendingSessions, setSendingSessions] = useState<string[]>([]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("cho-desktop.theme", theme);
    } catch {
      /* Storage can be unavailable. */
    }
  }, [theme]);

  // Sessions bound to repositories
  const [sessions, setSessions] = useState<RepoSession[]>(() => {
    try {
      const saved = localStorage.getItem(SESSIONS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      /* ignore */
    }
    return [
      {
        id: "session-default",
        title: "CHO Desktop",
        repoPath: "",
        repoName: "Select a repository",
        orchestratorHarness: "agy",
        orchestratorModel: "gemini-4-argon-high",
        effort: "high",
        role: "implement",
        orchestrateMode: true,
        messages: [],
        createdAt: new Date().toLocaleTimeString(),
      },
    ];
  });
  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    return sessions[0]?.id || "session-default";
  });

  // Custom repo modal / input
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [customRepoInput, setCustomRepoInput] = useState("");

  // Prompt composer
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const promptInput = drafts[activeSessionId] || "";
  const setPromptInput = (value: string) =>
    setDrafts((previous) => ({ ...previous, [activeSessionId]: value }));
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  // Right dock: Sub-Agent CLI Fleet & Live Output
  const [repoFilterMode, setRepoFilterMode] = useState<"all" | "repo">("repo");
  const [cliFilter, setCliFilter] = useState<string>("all");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] =
    useState<OrchRunDetail | null>(null);
  const [agentOutputTab, setAgentOutputTab] = useState<
    "response" | "tools" | "gate" | "stderr"
  >("response");

  // Spawn Sub-Agent Drawer
  const [showSpawnModal, setShowSpawnModal] = useState(false);
  const [spawnRole, setSpawnRole] = useState<"implement" | "review">(
    "implement",
  );
  const [spawnCli, setSpawnCli] = useState<string>("agy");
  const [spawnModel, setSpawnModel] = useState<string>("gemini-4-argon-high");
  const [spawnWp, setSpawnWp] = useState<string>("WP-01");
  const [spawnSlice, setSpawnSlice] = useState<string>("s1");
  const [spawnPrompt, setSpawnPrompt] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [gateFeedback, setGateFeedback] = useState<string | null>(null);

  const activeSession = useMemo(() => {
    return sessions.find((s) => s.id === activeSessionId) || sessions[0];
  }, [sessions, activeSessionId]);

  const activeHarnessInfo = useMemo(() => {
    return (
      harnesses.find((h) => h.id === activeSession?.orchestratorHarness) ||
      harnesses[0] ||
      null
    );
  }, [harnesses, activeSession?.orchestratorHarness]);

  const spawnHarnessInfo = useMemo(() => {
    return harnesses.find((h) => h.id === spawnCli) || null;
  }, [harnesses, spawnCli]);

  // Persist sessions
  useEffect(() => {
    try {
      localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    } catch {
      /* ignore */
    }
  }, [sessions]);

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev));
    }, 4000);
  };

  const refreshDashboard = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const data = await callHost<OrchDashboardData>("orch_dashboard");
      setDashboard(data);
      setHarnesses(data.harnesses || []);
      if (data.repositories && data.repositories.length > 0) {
        setRepositories(data.repositories);
      }
      setConnectionError(null);
    } catch (e: any) {
      setConnectionError(e?.message || String(e));
      setDashboard(null);
    } finally {
      refreshingRef.current = false;
    }
  };

  useEffect(() => {
    refreshDashboard();
    const timer = setInterval(refreshDashboard, 3500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setSelectedRunDetail(null);
    setGateFeedback(null);
    if (!selectedRunId || !activityOpen) return;
    let disposed = false;
    const load = async () => {
      try {
        const detail = await callHost<OrchRunDetail>("orch_run_detail", {
          runId: selectedRunId,
        });
        if (!disposed) setSelectedRunDetail(detail);
      } catch {
        /* Keep the last successful observation. */
      }
    };
    load();
    const timer = setInterval(load, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [selectedRunId, activityOpen]);

  // Subscribe to SSE stream events for Orchestrator turns
  useEffect(() => {
    return subscribeStreamEvents((payload: StreamEventPayload) => {
      if (payload.kind === "turn_complete") {
        sendingRef.current.delete(payload.sessionId);
        setSendingSessions((previous) =>
          previous.filter((id) => id !== payload.sessionId),
        );
      }
      setSessions((prev) =>
        prev.map((sess) => {
          if (sess.id !== payload.sessionId) return sess;
          const msgs = [...sess.messages];
          let targetIdx = msgs.findIndex((m) => m.id === payload.turnId);
          if (targetIdx === -1) {
            msgs.push({
              id: payload.turnId,
              role: "assistant",
              harness: payload.harness,
              modelRequested: sess.orchestratorModel,
              modelVerified: null,
              content: "",
              thought: "",
              tools: [],
              isStreaming: true,
              timestamp: new Date().toLocaleTimeString(),
            });
            targetIdx = msgs.length - 1;
          }

          const current = { ...msgs[targetIdx] };
          if (payload.kind === "status" && payload.text) {
            current.statusText = payload.text;
          } else if (payload.kind === "message_delta" && payload.text) {
            current.content += payload.text;
          } else if (payload.kind === "thought_delta" && payload.text) {
            current.thought = (current.thought || "") + payload.text;
          } else if (payload.kind === "tool_call") {
            current.tools = [
              ...current.tools,
              {
                id: payload.toolCallId || `tool-${current.tools.length + 1}`,
                title: payload.toolTitle || "tool",
                status: payload.toolStatus || "completed",
              },
            ];
          } else if (payload.kind === "model_verified" && payload.model) {
            current.modelVerified = payload.model;
          } else if (payload.kind === "error" && payload.text) {
            current.isError = true;
            current.content = current.content
              ? `${current.content}\n\n**Error:** ${payload.text}`
              : `**Error:** ${payload.text}`;
          } else if (payload.kind === "turn_complete") {
            current.isStreaming = false;
            if (payload.model) current.modelVerified = payload.model;
            // Refresh sub-agents in case the orchestrator launched an orch run
            setTimeout(refreshDashboard, 400);
          }

          msgs[targetIdx] = current;
          return { ...sess, messages: msgs };
        }),
      );
    });
  }, []);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeSession?.messages]);

  const updateActiveSession = (patch: Partial<RepoSession>) => {
    if (!activeSession) return;
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSession.id ? { ...s, ...patch } : s)),
    );
  };

  const selectOrchestratorHarness = (harnessId: HarnessId) => {
    const h = harnesses.find((item) => item.id === harnessId);
    const defaultModel = h?.defaultModel || h?.suggestedModels?.[0] || "";
    updateActiveSession({
      orchestratorHarness: harnessId,
      orchestratorModel: defaultModel,
    });
  };

  const createNewRepoSession = (repoPath?: string) => {
    const targetRepo =
      repoPath ||
      activeSession?.repoPath ||
      dashboard?.repoRoot ||
      "";
    if (!targetRepo.trim()) {
      setShowRepoPicker(true);
      return;
    }
    const repoName =
      targetRepo.split(/[\\/]/).filter(Boolean).pop() || targetRepo;
    const defaultHarness =
      harnesses.find((h) => h.id === "agy" && h.installed)?.id ||
      harnesses.find((h) => h.installed)?.id ||
      "agy";
    const hInfo = harnesses.find((h) => h.id === defaultHarness);
    const newSession: RepoSession = {
      id: `session-${Date.now()}`,
      title: `${repoName} Session`,
      repoPath: targetRepo,
      repoName,
      orchestratorHarness: defaultHarness,
      orchestratorModel: hInfo?.defaultModel || "gemini-4-argon-high",
      effort: "high",
      role: "implement",
      orchestrateMode: true,
      messages: [],
      createdAt: new Date().toLocaleTimeString(),
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
    setShowRepoPicker(false);
  };

  const deleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (sessions.length <= 1) {
      updateActiveSession({ messages: [] });
      return;
    }
    const next = sessions.filter((s) => s.id !== id);
    setSessions(next);
    if (activeSessionId === id && next[0]) {
      setActiveSessionId(next[0].id);
    }
  };

  const sendOrchestratorMessage = async (overridePrompt?: string) => {
    if (!activeSession) return;
    if (!activeHarnessInfo?.installed) {
      setBannerError("Choose an available CLI before sending a message.");
      return;
    }
    if (
      sendingRef.current.has(activeSession.id) ||
      activeSession.messages.some((m) => m.isStreaming)
    )
      return;
    const text = (overridePrompt ?? promptInput).trim();
    if (!text) return;
    sendingRef.current.add(activeSession.id);
    setSendingSessions((previous) => [...previous, activeSession.id]);
    if (!overridePrompt) setPromptInput("");

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      harness: activeSession.orchestratorHarness,
      modelRequested: activeSession.orchestratorModel,
      content: text,
      tools: [],
      timestamp: new Date().toLocaleTimeString(),
    };

    const priorHistory = activeSession.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const autoTitle =
      activeSession.messages.length === 0
        ? `${activeSession.repoName}: ${text.slice(0, 28)}${text.length > 28 ? "…" : ""}`
        : activeSession.title;

    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSession.id
          ? { ...s, title: autoTitle, messages: [...s.messages, userMsg] }
          : s,
      ),
    );

    try {
      await callHost("direct_chat_send", {
        sessionId: activeSession.id,
        harness: activeSession.orchestratorHarness,
        model: activeSession.orchestratorModel,
        workspace: activeSession.repoPath,
        role: activeSession.role,
        effort: activeSession.effort,
        prompt: text,
        history: priorHistory,
        orchestrateMode: activeSession.orchestrateMode,
      });
    } catch (e: any) {
      sendingRef.current.delete(activeSession.id);
      setSendingSessions((previous) =>
        previous.filter((id) => id !== activeSession.id),
      );
      setBannerError(e?.message || String(e));
      if (!overridePrompt) setPromptInput(text);
    }
  };

  const stopOrchestratorTurn = async () => {
    if (!activeSession) return;
    try {
      await callHost("direct_chat_cancel", { sessionId: activeSession.id });
      notify("Stopped active orchestrator turn.");
    } catch (e: any) {
      setBannerError(e?.message || String(e));
    }
  };

  const handleAutoPickWorker = async () => {
    setBusyAction("pick");
    try {
      const res = await callHost<OrchCommandResult>("orch_pick", {
        workload: spawnRole,
        size: "S",
      });
      if (res.output?.cli && res.output?.model) {
        setSpawnCli(res.output.cli);
        setSpawnModel(res.output.model);
        notify(`orch pick selected ${res.output.cli} / ${res.output.model}`);
      } else {
        notify(res.text || "No eligible candidate returned by orch pick.");
      }
    } catch (e: any) {
      setBannerError(e?.message || String(e));
    } finally {
      setBusyAction(null);
    }
  };

  const handleSpawnSubAgent = async () => {
    if (!activeSession) return;
    setBusyAction("spawn");
    try {
      if (!spawnPrompt.trim())
        throw new Error("Add instructions for the agent first.");
      if (spawnRole === "review" && !selectedRunId)
        throw new Error("Select an agent run to review first.");
      if (spawnRole === "review" && selectedRunId) {
        const res = await callHost<OrchCommandResult>("orch_review", {
          run: selectedRunId,
          reviewer: spawnCli,
          model: spawnModel,
          promptText: spawnPrompt,
        });
        if (!res.ok)
          throw new Error(res.text || "The review could not be started.");
        notify("Review started.");
      } else {
        const res = await startAgentTask(
          (command, args) => callHost<OrchCommandResult>(command, args),
          {
            repo: activeSession.repoPath,
            cli: spawnCli,
            model: spawnModel,
            wp: spawnWp,
            slice: spawnSlice,
            handoffText: spawnPrompt,
            effort: activeSession.effort,
          },
        );
        const newRunId = res.output?.run_id || res.output?.id;
        if (newRunId) setSelectedRunId(newRunId);
        if (!res.ok)
          throw new Error(res.text || "The agent could not be started.");
        notify("Agent started in its own worktree.");
      }
      setShowSpawnModal(false);
      setActivityOpen(true);
      await refreshDashboard();
    } catch (e: any) {
      setBannerError(e?.message || String(e));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunGateAction = async (
    action: "scope" | "cancel" | "record" | "adopt",
  ) => {
    setBusyAction(action);
    try {
      if (action === "adopt") {
        const res = await callHost<OrchCommandResult>("orch_adopt", {
          repo: activeSession?.repoPath,
          dryRun: false,
          update: true,
        });
        notify(res.ok ? `Adopted ${activeSession?.repoName}` : res.text);
        await refreshDashboard();
        return;
      }
      if (!selectedRunId) return;
      if (action === "scope") {
        const res = await callHost<OrchCommandResult>("orch_scope", {
          runId: selectedRunId,
        });
        setGateFeedback(res.text || JSON.stringify(res.output, null, 2));
        setAgentOutputTab("gate");
      } else if (action === "cancel") {
        const res = await callHost<OrchCommandResult>("orch_cancel", {
          runId: selectedRunId,
        });
        setGateFeedback(res.text || "Cancellation requested.");
        await refreshDashboard();
      } else if (action === "record") {
        const res = await callHost<OrchCommandResult>("orch_record", {
          runId: selectedRunId,
          disposition: "accepted",
          notes: "Accepted via CHO-desktop",
        });
        setGateFeedback(res.text || "Recorded in ledger.");
        setAgentOutputTab("gate");
      }
    } catch (e: any) {
      setBannerError(e?.message || String(e));
    } finally {
      setBusyAction(null);
    }
  };

  const filteredRuns = useMemo(() => {
    const all = dashboard?.runs || [];
    return all.filter((r: OrchRunSummary) => {
      if (cliFilter !== "all" && r.cli !== cliFilter) return false;
      if (repoFilterMode === "repo" && activeSession?.repoPath) {
        const normalize = (value: string) =>
          value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const normRepo = normalize(activeSession.repoPath);
        const normDir = normalize(String(r.repository || r.dir || ""));
        if (normDir !== normRepo && !normDir.startsWith(`${normRepo}/`))
          return false;
      }
      return true;
    });
  }, [
    dashboard?.runs,
    cliFilter,
    repoFilterMode,
    activeSession?.repoPath,
    activeSession?.repoName,
  ]);

  const isSessionStreaming = useMemo(() => {
    return (
      sendingSessions.includes(activeSession?.id) ||
      Boolean(activeSession?.messages.some((m) => m.isStreaming))
    );
  }, [activeSession, sendingSessions]);

  const currentRepoInfo = useMemo(() => {
    return (
      repositories.find(
        (r) => r.path.toLowerCase() === activeSession?.repoPath.toLowerCase(),
      ) || {
        path: activeSession?.repoPath || "",
        name: activeSession?.repoName || "Select a repository",
        branch: "",
        adopted: false,
      }
    );
  }, [repositories, activeSession?.repoPath, activeSession?.repoName]);

  const installedCount = harnesses.filter((h) => h.installed).length;
  const hasMessages = activeSession.messages.length > 0;
  const labelFor = (id: string) =>
    harnesses.find((h) => h.id === id)?.label.replace(" (agy)", "") || id;
  const projectGroups = Array.from(new Set(sessions.map((s) => s.repoPath)))
    .map((path) => ({
      path,
      name: sessions.find((s) => s.repoPath === path)!.repoName,
      sessions: sessions.filter(
        (s) =>
          s.repoPath === path &&
          (!sessionQuery ||
            `${s.title} ${s.repoName}`
              .toLowerCase()
              .includes(sessionQuery.toLowerCase())),
      ),
    }))
    .filter((group) => group.sessions.length > 0);
  const visibleDetail = filteredRuns.some((run) => run.id === selectedRunId)
    ? selectedRunDetail
    : null;
  const draftPrompt = (text: string) => {
    setPromptInput(text);
    composerRef.current?.focus();
  };
  const starters = [
    {
      icon: "search" as const,
      title: "Explore the codebase",
      detail: "Find your bearings",
      prompt:
        "Give me an overview of this repository, its architecture, and the main entry points.",
    },
    {
      icon: "plan" as const,
      title: "Plan a change",
      detail: "Think it through first",
      prompt:
        "Help me plan a change in this repository. Start by asking what I want to build.",
    },
    {
      icon: "code" as const,
      title: "Review recent work",
      detail: "Get a second perspective",
      prompt:
        "Review the current uncommitted changes in this repository. Explain any concrete problems you find without changing files.",
    },
  ];

  const composer = (
    <div className="composer-area">
      <div className={`composer ${isSessionStreaming ? "is-working" : ""}`}>
        <textarea
          ref={composerRef}
          aria-label="Message"
          value={promptInput}
          rows={3}
          onChange={(e) => setPromptInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              if (!isSessionStreaming) sendOrchestratorMessage();
            }
          }}
          placeholder={
            hasMessages
              ? "Continue the conversation…"
              : "Ask a question, or describe what you’d like to build…"
          }
        />
        <div className="composer-controls">
          <div className="composer-options">
            <label
              className="quiet-select harness-control"
              title="Choose the CLI for this conversation"
            >
              <Icon name="terminal" size={15} />
              <span className="sr-only">Controller CLI</span>
              <select
                aria-label="Controller CLI"
                disabled={isSessionStreaming}
                value={activeSession.orchestratorHarness}
                onChange={(e) =>
                  selectOrchestratorHarness(e.target.value as HarnessId)
                }
              >
                {!harnesses.length && (
                  <option value={activeSession.orchestratorHarness}>
                    {labelFor(activeSession.orchestratorHarness)}
                  </option>
                )}
                {harnesses.map((h) => (
                  <option key={h.id} value={h.id} disabled={!h.installed}>
                    {h.label.replace(" (agy)", "")}
                    {!h.installed ? " · unavailable" : ""}
                  </option>
                ))}
              </select>
              <Icon name="down" size={12} />
            </label>
            <span className="control-divider" />
            <details className="model-picker">
              <summary title="Model and reasoning settings">
                <span>{activeSession.orchestratorModel || "Choose model"}</span>
                <Icon name="down" size={12} />
              </summary>
              <div className="model-popover">
                <label>
                  Model
                  <input
                    aria-label="Controller model"
                    list="controller-models"
                    disabled={isSessionStreaming}
                    value={activeSession.orchestratorModel}
                    onChange={(e) =>
                      updateActiveSession({ orchestratorModel: e.target.value })
                    }
                  />
                </label>
                <datalist id="controller-models">
                  {activeHarnessInfo?.suggestedModels.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <label>
                  Reasoning
                  <select
                    aria-label="Reasoning effort"
                    disabled={isSessionStreaming}
                    value={activeSession.effort}
                    onChange={(e) =>
                      updateActiveSession({
                        effort: e.target.value as RepoSession["effort"],
                      })
                    }
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="xhigh">Extra high</option>
                  </select>
                </label>
              </div>
            </details>
          </div>
          <div className="composer-actions">
            <label className="quiet-select mode-control">
              <span className="sr-only">Conversation mode</span>
              <select
                aria-label="Conversation mode"
                disabled={isSessionStreaming}
                value={activeSession.role}
                onChange={(e) =>
                  updateActiveSession({
                    role: e.target.value as RepoSession["role"],
                  })
                }
              >
                <option value="implement">Build</option>
                <option value="review">Plan only</option>
              </select>
              <Icon name="down" size={12} />
            </label>
            {isSessionStreaming ? (
              <button
                className="send-button"
                onClick={stopOrchestratorTurn}
                aria-label="Stop response"
                title="Stop response"
              >
                <Icon name="stop" size={16} />
              </button>
            ) : (
              <button
                className="send-button"
                onClick={() => sendOrchestratorMessage()}
                disabled={!promptInput.trim() || !activeHarnessInfo?.installed}
                aria-label="Send message"
                title={
                  !activeHarnessInfo?.installed
                    ? "Choose an available CLI to send a message"
                    : "Send message"
                }
              >
                <Icon name="arrow" size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="composer-caption">
        <span>
          <span className={`connection-dot ${dashboard ? "connected" : ""}`} />
          {activeSession.role === "review" ? "Planning in" : "Working in"}{" "}
          <button onClick={() => setShowRepoPicker(true)}>
            {currentRepoInfo.name}
            <Icon name="down" size={11} />
          </button>
        </span>
        <span>
          Enter to send <span className="caption-separator">·</span> Shift +
          Enter for a new line
        </span>
      </div>
    </div>
  );

  return (
    <div
      className={`desktop ${sidebarOpen ? "" : "sidebar-collapsed"} ${activityOpen ? "activity-visible" : ""}`}
    >
      {sidebarOpen && (
        <aside className="sidebar" aria-label="Projects and conversations">
          <div className="sidebar-brand">
            <span className="wordmark">
              <span className="brand-mark" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              cho<span className="wordmark-dot">.</span>
            </span>
            <button
              className="icon-button"
              aria-label="Hide sidebar"
              title="Hide sidebar"
              onClick={() => setSidebarOpen(false)}
            >
              <Icon name="panel" size={17} />
            </button>
          </div>
          <button
            className="new-conversation"
            onClick={() => createNewRepoSession()}
          >
            <Icon name="plus" size={17} />
            <span>New conversation</span>
            <span className="new-hint">+</span>
          </button>
          <label className="sidebar-search">
            <Icon name="search" size={15} />
            <input
              aria-label="Search conversations"
              placeholder="Search conversations"
              value={sessionQuery}
              onChange={(e) => setSessionQuery(e.target.value)}
            />
            {sessionQuery && (
              <button
                className="icon-button"
                aria-label="Clear search"
                onClick={() => setSessionQuery("")}
              >
                <Icon name="close" size={13} />
              </button>
            )}
          </label>
          <div className="section-label">
            <span>Projects</span>
            <button
              className="icon-button"
              aria-label="Open project"
              title="Open project"
              onClick={() => setShowRepoPicker(true)}
            >
              <Icon name="plus" size={15} />
            </button>
          </div>
          <nav className="project-list">
            {projectGroups.map((group) => (
              <div className="project-group" key={group.path}>
                <div className="project-row">
                  <button
                    className="project-name"
                    title={group.path}
                    onClick={() => {
                      setActiveSessionId(group.sessions[0].id);
                    }}
                  >
                    <Icon name="folder" size={17} />
                    <span>{group.name}</span>
                  </button>
                  <button
                    className="icon-button project-add"
                    aria-label={`New conversation in ${group.name}`}
                    onClick={() => createNewRepoSession(group.path)}
                  >
                    <Icon name="plus" size={14} />
                  </button>
                </div>
                {(group.path === activeSession.repoPath || sessionQuery) && (
                  <div className="conversation-list">
                    {group.sessions.map((session) => (
                      <div
                        className={`conversation-row ${session.id === activeSessionId ? "selected" : ""}`}
                        key={session.id}
                      >
                        <button
                          className="conversation-link"
                          aria-current={
                            session.id === activeSessionId ? "page" : undefined
                          }
                          onClick={() => {
                            setActiveSessionId(session.id);
                          }}
                        >
                          <span
                            className={
                              session.messages.some((m) => m.isStreaming)
                                ? "session-indicator working"
                                : "session-indicator"
                            }
                          />
                          <span>
                            {session.messages.length
                              ? session.title.replace(
                                  `${session.repoName}: `,
                                  "",
                                )
                              : "New conversation"}
                          </span>
                        </button>
                        <button
                          className="conversation-close icon-button"
                          aria-label={`Close ${session.title}`}
                          disabled={
                            session.messages.some((m) => m.isStreaming) ||
                            sendingSessions.includes(session.id)
                          }
                          onClick={(e) => deleteSession(session.id, e)}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {!projectGroups.length && (
              <p className="sidebar-empty">No conversations found.</p>
            )}
          </nav>
          <div className="sidebar-footer">
            <button
              className="connections-button"
              onClick={() => setConnectionsOpen(true)}
            >
              <span className="connection-symbol">
                <Icon name="settings" size={17} />
              </span>
              <span>
                <strong>Connections</strong>
                <small>
                  {dashboard
                    ? `${installedCount} CLIs available`
                    : "Host disconnected"}
                </small>
              </span>
            </button>
            <button
              className="icon-button theme-button"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} appearance`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} appearance`}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} size={17} />
            </button>
          </div>
        </aside>
      )}

      <section className="workspace">
        <header className="workspace-header">
          <div className="workspace-breadcrumb">
            {!sidebarOpen && (
              <button
                className="icon-button"
                aria-label="Show sidebar"
                onClick={() => setSidebarOpen(true)}
              >
                <Icon name="panel" />
              </button>
            )}
            <button
              className="breadcrumb-project"
              onClick={() => setShowRepoPicker(true)}
            >
              {currentRepoInfo.name}
              <Icon name="down" size={12} />
            </button>
            <span className="breadcrumb-slash">/</span>
            <span className="breadcrumb-conversation">
              {hasMessages
                ? activeSession.title.replace(`${activeSession.repoName}: `, "")
                : "New conversation"}
            </span>
          </div>
          <div className="header-actions">
            {currentRepoInfo.branch && (
              <span className="branch-label">
                <Icon name="branch" size={14} />
                {currentRepoInfo.branch}
              </span>
            )}
            <button
              className={`activity-toggle ${activityOpen ? "active" : ""}`}
              aria-expanded={activityOpen}
              onClick={() => setActivityOpen(!activityOpen)}
            >
              <Icon name="activity" size={16} />
              <span>Agents</span>
              {filteredRuns.length > 0 && (
                <span className="count">{filteredRuns.length}</span>
              )}
            </button>
          </div>
        </header>
        {(bannerError || connectionError) && (
          <div className="notice error-notice" role="alert">
            <span>{bannerError || connectionError}</span>
            <button className="text-button" onClick={refreshDashboard}>
              Retry
            </button>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => {
                setBannerError(null);
                setConnectionError(null);
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        <main
          className={`conversation-main ${hasMessages ? "has-conversation" : "is-empty"}`}
        >
          {hasMessages ? (
            <>
              <div className="conversation-scroll">
                <div className="message-column">
                  {activeSession.messages.map((message) => (
                    <article
                      key={message.id}
                      className={`message ${message.role} ${message.isError ? "message-error" : ""}`}
                    >
                      <div className="message-heading">
                        {message.role === "assistant" && (
                          <span className="assistant-mark">
                            <Icon name="terminal" size={14} />
                          </span>
                        )}
                        <strong>
                          {message.role === "user"
                            ? "You"
                            : labelFor(message.harness)}
                        </strong>
                        {message.role === "assistant" &&
                          message.modelVerified && (
                            <span
                              className="message-model"
                              title="Model reported by the CLI"
                            >
                              {message.modelVerified}
                            </span>
                          )}
                        <time>{message.timestamp}</time>
                      </div>
                      {message.role === "assistant" && (
                        <CollapsibleMessageSteps
                          tools={message.tools}
                          thought={message.thought}
                        />
                      )}
                      <div className="message-content">
                        {message.role === "user" ? (
                          <div className="user-prompt-text">
                            {message.content}
                          </div>
                        ) : (
                          <FormattedMarkdown text={message.content} />
                        )}
                      </div>
                      {message.isStreaming && (
                        <div className="working-label">
                          <span className="working-dot" />
                          {message.statusText || "Working"}
                        </div>
                      )}
                    </article>
                  ))}
                  {isSessionStreaming &&
                    !activeSession.messages.some((m) => m.isStreaming) && (
                      <div className="working-label">
                        <span className="working-dot" />
                        Starting {labelFor(activeSession.orchestratorHarness)}…
                      </div>
                    )}
                  <div ref={chatBottomRef} />
                </div>
              </div>
              <div className="conversation-composer">{composer}</div>
            </>
          ) : (
            <div className="welcome">
              <div className="welcome-heading">
                <div className="workspace-eyebrow">
                  <Icon name="folder" size={15} />
                  <span>{currentRepoInfo.name}</span>
                </div>
                <h1>What are we working on?</h1>
                <p>A question, a small fix, or your next big idea.</p>
              </div>
              {composer}
              <div className="starter-grid">
                {starters.map((starter) => (
                  <button
                    className="starter"
                    key={starter.title}
                    onClick={() => draftPrompt(starter.prompt)}
                  >
                    <Icon name={starter.icon} size={18} />
                    <strong>{starter.title}</strong>
                    <span>{starter.detail}</span>
                    <span className="starter-arrow">
                      <Icon name="chevron" size={13} />
                    </span>
                  </button>
                ))}
              </div>
              <div className="welcome-footnote">
                Your tools. Your subscriptions. One place to work.
              </div>
            </div>
          )}
        </main>
      </section>

      {activityOpen && (
        <aside className="activity-panel" aria-label="Agent activity">
          <header className="activity-heading">
            <div>
              <h2>Agents</h2>
              <span>
                {repoFilterMode === "repo"
                  ? currentRepoInfo.name
                  : "Across your projects"}
              </span>
            </div>
            <button
              className="icon-button"
              aria-label="Close agent activity"
              onClick={() => setActivityOpen(false)}
            >
              <Icon name="close" size={17} />
            </button>
          </header>
          <div className="activity-controls">
            <select
              aria-label="Agent project filter"
              value={repoFilterMode}
              onChange={(e) => {
                setRepoFilterMode(e.target.value as "all" | "repo");
                setSelectedRunId(null);
              }}
            >
              <option value="repo">This project</option>
              <option value="all">All projects</option>
            </select>
            <select
              aria-label="Agent CLI filter"
              value={cliFilter}
              onChange={(e) => setCliFilter(e.target.value)}
            >
              <option value="all">All CLIs</option>
              {harnesses.map((h) => (
                <option value={h.id} key={h.id}>
                  {labelFor(h.id)}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              title="Refresh activity"
              aria-label="Refresh activity"
              onClick={refreshDashboard}
            >
              <Icon name="refresh" size={15} />
            </button>
          </div>
          {filteredRuns.length ? (
            <div
              className={`agent-list ${visibleDetail ? "with-selection" : ""}`}
            >
              {filteredRuns.map((run) => {
                const status = run.derived_status || run.status || "unknown";
                return (
                  <button
                    className={`agent-row ${selectedRunId === run.id ? "selected" : ""}`}
                    key={run.id}
                    onClick={() => {
                      setSelectedRunId(run.id);
                      setAgentOutputTab("response");
                    }}
                  >
                    <span className="agent-row-top">
                      <strong>{labelFor(run.cli)}</strong>
                      <span
                        className={`run-state ${status === "completed" ? "success" : status === "running" ? "running" : ""}`}
                      >
                        <span />
                        {status.replace(/-/g, " ")}
                      </span>
                    </span>
                    <span className="agent-model">
                      {run.model_actual ||
                        run.model_requested ||
                        run.model_canonical}
                    </span>
                    <span className="agent-meta">
                      {run.role === "review" ? "Review" : "Implementation"}
                      {run.wp && ` · ${run.wp}`}
                      {run.slice && ` / ${run.slice}`}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="agent-empty">
              <div className="empty-symbol">
                <Icon name="activity" size={24} />
              </div>
              <h3>No agent activity yet</h3>
              <p>
                Delegated work will appear here, with responses and tool
                activity as it runs.
              </p>
              <button
                className="secondary-button"
                onClick={() => {
                  setSpawnRole("implement");
                  setShowSpawnModal(true);
                }}
              >
                <Icon name="plus" size={15} />
                New agent task
              </button>
            </div>
          )}
          {visibleDetail && (
            <div className="agent-detail">
              <div className="agent-detail-heading">
                <span>Run details</span>
                <button
                  className="icon-button"
                  aria-label="Close run details"
                  onClick={() => setSelectedRunId(null)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
              <div
                className="detail-tabs"
                role="tablist"
                aria-label="Run output"
              >
                {(
                  [
                    ["response", "Response"],
                    ["tools", "Activity"],
                    ["gate", "Checks"],
                    ["stderr", "Errors"],
                  ] as const
                ).map(([id, title]) => (
                  <button
                    role="tab"
                    aria-selected={agentOutputTab === id}
                    key={id}
                    className={agentOutputTab === id ? "selected" : ""}
                    onClick={() => setAgentOutputTab(id)}
                  >
                    {title}
                  </button>
                ))}
              </div>
              <div className="detail-body" role="tabpanel">
                {agentOutputTab === "response" && (
                  <FormattedMarkdown
                    text={
                      visibleDetail.cleanResponseText ||
                      "No response text recorded yet."
                    }
                  />
                )}
                {agentOutputTab === "tools" && (
                  <>
                    {visibleDetail.thoughts?.map((thought, i) => (
                      <details className="agent-thought" key={i}>
                        <summary>Reasoning</summary>
                        <pre>{thought}</pre>
                      </details>
                    ))}
                    {visibleDetail.toolCalls?.length ? (
                      visibleDetail.toolCalls.map((tool, i) => (
                        <div className="tool-entry" key={`${tool.id}-${i}`}>
                          <Icon name="terminal" size={14} />
                          <div>
                            <code>{tool.title}</code>
                            {tool.detail && <pre>{tool.detail}</pre>}
                            <small>{tool.status}</small>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="muted">No tool activity recorded.</p>
                    )}
                  </>
                )}
                {agentOutputTab === "gate" && (
                  <>
                    <dl className="run-facts">
                      <dt>Status</dt>
                      <dd>
                        {visibleDetail.status.derived_status ||
                          visibleDetail.status.status}
                      </dd>
                      <dt>Worktree</dt>
                      <dd>{visibleDetail.status.dir || "Unavailable"}</dd>
                      <dt>Reported model</dt>
                      <dd>{visibleDetail.verifiedModel || "Not reported"}</dd>
                    </dl>
                    <div className="run-actions">
                      <button
                        className="secondary-button"
                        onClick={() => handleRunGateAction("scope")}
                        disabled={!!busyAction}
                      >
                        Check scope
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setSpawnRole("review");
                          setShowSpawnModal(true);
                        }}
                      >
                        Request review
                      </button>
                      <button
                        className="text-button"
                        onClick={() => handleRunGateAction("record")}
                        disabled={!!busyAction}
                      >
                        Record accepted
                      </button>
                    </div>
                    {gateFeedback && (
                      <pre className="raw-output">{gateFeedback}</pre>
                    )}
                  </>
                )}
                {agentOutputTab === "stderr" && (
                  <pre className="raw-output">
                    {visibleDetail.logs?.stderr || "No error output recorded."}
                  </pre>
                )}
              </div>
              {visibleDetail.status.status === "running" && (
                <div className="detail-footer">
                  <button
                    className="text-button danger-text"
                    onClick={() => handleRunGateAction("cancel")}
                  >
                    Stop agent
                  </button>
                </div>
              )}
            </div>
          )}
          {filteredRuns.length > 0 && (
            <div className="activity-footer">
              <button
                className="secondary-button"
                onClick={() => {
                  setSpawnRole("implement");
                  setShowSpawnModal(true);
                }}
              >
                <Icon name="plus" size={15} />
                New agent task
              </button>
            </div>
          )}
        </aside>
      )}

      {showRepoPicker && (
        <Dialog
          title="Open a project"
          subtitle="Choose a repository to start a conversation."
          onClose={() => setShowRepoPicker(false)}
        >
          <div className="repository-list">
            {repositories.map((repo) => (
              <button
                className="repository-option"
                key={repo.path}
                onClick={() => createNewRepoSession(repo.path)}
              >
                <span className="repository-icon">
                  <Icon name="folder" size={20} />
                </span>
                <span>
                  <strong>{repo.name}</strong>
                  <small>{repo.path}</small>
                </span>
                {repo.branch && (
                  <span className="repository-branch">
                    <Icon name="branch" size={13} />
                    {repo.branch}
                  </span>
                )}
                <Icon name="chevron" size={15} />
              </button>
            ))}
          </div>
          <form
            className="custom-project"
            onSubmit={(e) => {
              e.preventDefault();
              if (customRepoInput.trim()) {
                createNewRepoSession(customRepoInput.trim());
                setCustomRepoInput("");
              }
            }}
          >
            <label htmlFor="project-path">Open another repository</label>
            <div>
              <input
                id="project-path"
                placeholder="Absolute path to a git repository"
                value={customRepoInput}
                onChange={(e) => setCustomRepoInput(e.target.value)}
              />
              <button
                className="primary-button"
                disabled={!customRepoInput.trim()}
              >
                Open project
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {connectionsOpen && (
        <Dialog
          title="Connections"
          subtitle="Use the coding CLIs already installed on your computer."
          onClose={() => setConnectionsOpen(false)}
        >
          <div className="connection-list">
            {harnesses.map((h) => (
              <div className="connection-row" key={h.id}>
                <span className="connection-avatar">
                  <Icon name="terminal" size={18} />
                </span>
                <div>
                  <strong>{labelFor(h.id)}</strong>
                  <small>
                    {h.installed ? "Installed locally" : "Not installed"}
                  </small>
                </div>
                <span
                  className={`availability ${h.installed ? "available" : ""}`}
                >
                  <span />
                  {h.installed ? "Available" : "Unavailable"}
                </span>
                {h.installed && (
                  <button
                    className="secondary-button"
                    disabled={isSessionStreaming}
                    onClick={() => {
                      selectOrchestratorHarness(h.id);
                      setConnectionsOpen(false);
                    }}
                  >
                    {h.id === activeSession.orchestratorHarness
                      ? "Selected"
                      : "Use"}
                  </button>
                )}
              </div>
            ))}
          </div>
          {!harnesses.length && (
            <p className="muted connection-empty">
              Connect the local host to discover your installed CLIs.
            </p>
          )}
          <div className="dialog-footer">
            <span className="muted">
              Availability does not verify sign-in or model access.
            </span>
            <button className="secondary-button" onClick={refreshDashboard}>
              <Icon name="refresh" size={14} />
              Refresh
            </button>
          </div>
        </Dialog>
      )}

      {showSpawnModal && (
        <Dialog
          title={spawnRole === "review" ? "Request a review" : "New agent task"}
          subtitle={
            spawnRole === "review"
              ? "A separate model will review the selected run."
              : `Delegate focused work in ${currentRepoInfo.name}.`
          }
          onClose={() => setShowSpawnModal(false)}
        >
          <form
            className="agent-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleSpawnSubAgent();
            }}
          >
            <div className="form-row">
              <label>
                CLI
                <select
                  value={spawnCli}
                  onChange={(e) => {
                    setSpawnCli(e.target.value);
                    const h = harnesses.find((h) => h.id === e.target.value);
                    if (h) setSpawnModel(h.defaultModel);
                  }}
                >
                  {harnesses
                    .filter((h) => h.installed)
                    .map((h) => (
                      <option key={h.id} value={h.id}>
                        {labelFor(h.id)}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Model
                <input
                  list="agent-models"
                  value={spawnModel}
                  onChange={(e) => setSpawnModel(e.target.value)}
                />
                <datalist id="agent-models">
                  {spawnHarnessInfo?.suggestedModels.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
            </div>
            {spawnRole === "implement" && (
              <div className="form-row">
                <label>
                  Work package
                  <input
                    value={spawnWp}
                    onChange={(e) => setSpawnWp(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Task ID
                  <input
                    value={spawnSlice}
                    onChange={(e) => setSpawnSlice(e.target.value)}
                    required
                  />
                </label>
              </div>
            )}
            <label>
              Instructions
              <textarea
                rows={6}
                value={spawnPrompt}
                onChange={(e) => setSpawnPrompt(e.target.value)}
                placeholder="Describe the task, allowed files, and how to verify the result…"
                required
              />
            </label>
            <p className="form-note">
              {spawnRole === "implement"
                ? "The task claims its work package and prepares an isolated worktree before launch."
                : "Select a different model from the implementation agent."}
            </p>
            {bannerError && (
              <p className="form-error" role="alert">
                {bannerError}
              </p>
            )}
            <div className="dialog-footer">
              <button
                type="button"
                className="text-button"
                onClick={handleAutoPickWorker}
                disabled={!!busyAction}
              >
                Choose from roster
              </button>
              <button
                className="primary-button"
                disabled={
                  !!busyAction ||
                  !spawnPrompt.trim() ||
                  !spawnHarnessInfo?.installed ||
                  (spawnRole === "review" && !selectedRunId)
                }
              >
                {busyAction === "spawn"
                  ? "Preparing…"
                  : spawnRole === "review"
                    ? "Start review"
                    : "Start task"}
                <Icon name="arrow" size={15} />
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" size={16} />
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

export function App() {
  return isTauriRuntime() ? <NativeChat /> : <BrowserApp />;
}
export default App;
