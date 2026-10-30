// CHO-desktop Host Bridge Server (Node 24 ES Module, zero external dependencies).
// Bridges the Desktop UI to:
//  1. Orchestrator & Direct Subscription CLI Sessions (claude, codex, agy, grok, muse, copilot, vibe, opencode)
//     with shell:false, stripped metered API environment variables, and STRICT clean-text extraction (never raw JSONL).
//  2. Bundled `orch` (cli-agentic-coordinator) worker/reviewer fleet with live sub-agent streaming output.
//  3. Local Git repository discovery, session persistence, and workspace trust store.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveCliExe } from '../../../orch/src/exe.mjs';
import { resolveClaudeExe } from '../../../orch/src/adapters/claude.mjs';
import { resolveGrokExe } from '../../../orch/src/adapters/grok.mjs';
import { resolveMuseExe, museAuthPath } from '../../../orch/src/adapters/muse.mjs';
import { resolveCopilotExe } from '../../../orch/src/adapters/copilot.mjs';
import { resolveOpencodeExe } from '../../../orch/src/adapters/opencode.mjs';
import { resolveAgyExe, extractAgyModel } from '../../../orch/src/adapters/agy.mjs';
import { messageText as vibeMessageText } from '../../../orch/src/adapters/vibe.mjs';
import { deletedEnvironment, parseJsonl } from '../../../orch/src/adapters/subscription-cli.mjs';
import { extractCodexModel } from '../../../orch/src/adapters/codex.mjs';
import { getAdapter } from '../../../orch/src/adapters/index.mjs';
import { resolveStateRoot } from '../../../orch/src/config.mjs';
import { listWorktreeRecords } from '../../../orch/src/worktrees.mjs';
import { callTool } from '../../../orch/src/mcp.mjs';
import { parseArgs, runCommand } from '../../../orch/src/cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_PORT = Number(process.env.CHO_BRIDGE_PORT || 1421);

/** Connected SSE clients receiving real-time stream & coordinator events. */
const sseClients = new Set();

export function broadcastEvent(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

/* ============================================================================
 * 1. HARNESS DISCOVERY & SUBSCRIPTION AUTH INSPECTION
 * ========================================================================= */

const HARNESS_CATALOG = [
  {
    id: 'claude',
    label: 'Claude Code',
    provider: 'Anthropic Subscription',
    transport: 'claude -p (stream-json -> text extracted)',
    defaultModel: 'claude-sonnet-4-5',
    suggestedModels: [
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-haiku-4-5',
      'sonnet',
      'opus',
    ],
    roles: ['chat', 'controller', 'worker', 'reviewer'],
    envStripped: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    provider: 'ChatGPT Subscription',
    transport: 'codex exec --json (agent_message extracted)',
    defaultModel: 'gpt-5.6-terra',
    suggestedModels: [
      'gpt-5.6-terra',
      'gpt-5.6-sol',
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-5.4',
      'o3',
    ],
    roles: ['chat', 'controller', 'worker', 'reviewer'],
    envStripped: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  },
  {
    id: 'agy',
    label: 'Antigravity (agy)',
    provider: 'Google Gemini / Antigravity Subscription',
    transport: 'agy.exe -p (native print text + log provenance)',
    defaultModel: 'gemini-4-argon-high',
    suggestedModels: [
      'gemini-4-argon-high',
      'gemini-4-argon-medium',
      'gemini-4-argon-low',
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-low',
      'claude-opus-5-5-high',
      'claude-opus-5-5-medium',
      'claude-sonnet-5-5-high',
      'claude-sonnet-5-5-medium',
      'gpt-oss-120b-medium',
    ],
    roles: ['chat', 'controller', 'worker', 'reviewer'],
    envStripped: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  {
    id: 'grok',
    label: 'Grok Build CLI',
    provider: 'xAI Grok Subscription',
    transport: 'grok -p (stream-json -> text extracted)',
    defaultModel: 'grok-4.20',
    suggestedModels: ['grok-4.20', 'grok-4.20-fast', 'grok-code-fast-1'],
    roles: ['chat', 'controller', 'worker', 'reviewer'],
    envStripped: ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY'],
  },
  {
    id: 'muse',
    label: 'Meta Muse CLI',
    provider: 'Meta Device OAuth Subscription',
    transport: 'muse exec --json (run.output.delta extracted)',
    defaultModel: 'muse-spark-1.3',
    suggestedModels: ['muse-spark-1.3'],
    roles: ['chat', 'controller', 'worker', 'reviewer'],
    envStripped: ['META_API_KEY', 'MUSE_API_KEY', 'META_BASE_URL'],
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    provider: 'GitHub Copilot Subscription',
    transport: 'copilot -p (assistant.message extracted)',
    defaultModel: 'auto',
    suggestedModels: ['auto', 'claude-sonnet-4.5', 'gpt-5'],
    roles: ['chat', 'controller', 'worker', 'reviewer'],
    envStripped: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_PROVIDER_API_KEY'],
  },
  {
    id: 'vibe',
    label: 'Mistral Vibe CLI',
    provider: 'Vibe Subscription / Plan',
    transport: 'vibe -p --output streaming (assistant text extracted)',
    defaultModel: 'zai-glm-5-3',
    suggestedModels: ['zai-glm-5-3', 'mistral-medium-3.5', 'mistral-large-latest'],
    roles: ['chat', 'controller', 'worker', 'reviewer'],
    envStripped: ['MISTRAL_API_KEY'],
  },
  {
    id: 'opencode',
    label: 'OpenCode CLI',
    provider: 'Local Gateway (igm-local)',
    transport: 'opencode run --print-logs (clean stdout)',
    defaultModel: 'igm-local/qwen3-coder-30b',
    suggestedModels: [
      'igm-local/qwen3-coder-30b',
      'igm-local/deepseek-v4-flash',
      'igm-local/qwen3.8-flash-next',
      'igm-local/gpt-oss-120b',
      'igm-local/qwen3.8-27b',
      'igm-local/minimax-m2.7',
      'igm-local/nemotron3.5-super-vl',
      'igm-local/qwen3.5-122b',
    ],
    roles: ['chat', 'controller', 'worker', 'reviewer'],
    envStripped: [],
  },
];

const exePathCache = new Map();
function resolveHarnessExecutable(id) {
  if (exePathCache.has(id)) return exePathCache.get(id);
  let resolved = null;
  try {
    if (id === 'claude') resolved = resolveClaudeExe();
    else if (id === 'grok') resolved = resolveGrokExe();
    else if (id === 'muse') resolved = resolveMuseExe();
    else if (id === 'copilot') resolved = resolveCopilotExe();
    else if (id === 'opencode') resolved = resolveOpencodeExe();
    else if (id === 'agy') {
      try {
        resolved = resolveAgyExe();
      } catch {
        const fallback = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe');
        if (fs.existsSync(fallback)) resolved = fallback;
      }
    } else if (id === 'vibe') {
      resolved = resolveCliExe('vibe', {
        fallbacks: (env) => [
          path.join(env.USERPROFILE || os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'vibe.exe' : 'vibe'),
        ],
      });
    } else {
      resolved = resolveCliExe(id);
    }
  } catch {
    resolved = null;
  }
  exePathCache.set(id, resolved);
  return resolved;
}

function checkSubscriptionAuthHint(id) {
  const home = os.homedir();
  try {
    if (id === 'claude') {
      const claudeJson = path.join(home, '.claude.json');
      const credsJson = path.join(home, '.claude', '.credentials.json');
      if (fs.existsSync(credsJson) || fs.existsSync(claudeJson)) return 'saved-login-detected';
      return 'run `claude auth login`';
    }
    if (id === 'codex') {
      const authJson = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'auth.json');
      if (fs.existsSync(authJson)) return 'saved-login-detected';
      return 'run `codex login`';
    }
    if (id === 'agy') {
      return 'saved-login-detected';
    }
    if (id === 'grok') {
      const authJson = path.join(process.env.GROK_HOME || path.join(home, '.grok'), 'auth.json');
      if (fs.existsSync(authJson)) return 'saved-login-detected';
      return 'run `grok login`';
    }
    if (id === 'muse') {
      const authJson = museAuthPath();
      if (fs.existsSync(authJson)) return 'saved-login-detected';
      return 'run `muse login`';
    }
    if (id === 'copilot') {
      return 'subscription-cli';
    }
    if (id === 'vibe') {
      const vibeDir = process.env.VIBE_HOME || path.join(home, '.vibe');
      if (fs.existsSync(vibeDir)) return 'saved-login-detected';
      return 'configured-cli';
    }
    if (id === 'opencode') {
      return 'local-gateway';
    }
  } catch {
    /* ignore */
  }
  return 'unverified';
}

function loadRosterModelsByCli() {
  const byCli = new Map();
  const rosterPath = fs.existsSync(path.join(REPO_ROOT, 'orch/roster.json'))
    ? path.join(REPO_ROOT, 'orch/roster.json')
    : path.join(REPO_ROOT, 'orch/roster.example.json');
  try {
    const models = JSON.parse(fs.readFileSync(rosterPath, 'utf8')).models || [];
    for (const m of models) {
      if (!m || !m.cli || !m.model) continue;
      if (!byCli.has(m.cli)) byCli.set(m.cli, []);
      const list = byCli.get(m.cli);
      if (!list.includes(m.model)) list.push(m.model);
    }
  } catch {
    /* ignore */
  }
  return byCli;
}

/**
 * Passive harness overview: static catalog + configured roster models only.
 * Performs no model-catalog subprocess and no network/provider calls.
 */
export function discoverHarnesses() {
  const rosterModels = loadRosterModelsByCli();
  return HARNESS_CATALOG.map((item) => {
    const executablePath = resolveHarnessExecutable(item.id);
    const fromRoster = rosterModels.get(item.id) || [];
    const mergedModels = [...new Set([...fromRoster, ...item.suggestedModels])];
    const defaultModel = mergedModels[0] || item.defaultModel;
    return {
      ...item,
      defaultModel,
      suggestedModels: mergedModels,
      installed: Boolean(executablePath),
      executablePath,
      authHint: executablePath ? checkSubscriptionAuthHint(item.id) : 'not-installed',
    };
  });
}

/* ============================================================================
 * 2. CLEAN RESPONSE TEXT EXTRACTOR (STRIPS ALL RAW JSONL ENVELOPES)
 * ========================================================================= */

/**
 * Extracts ONLY human-readable assistant response text, structured tool calls,
 * thinking blocks, and verified model IDs from any CLI's stdout/stderr log.
 * Never returns raw JSONL lines.
 */
export function extractCleanRunOutput(cli, stdoutText, stderrText = '', runDir = null) {
  const raw = String(stdoutText || '');
  const err = String(stderrText || '');
  const textParts = [];
  const toolCalls = [];
  const thoughts = [];
  let verifiedModel = null;

  if (!raw.trim()) {
    return {
      cleanText: '',
      toolCalls,
      thoughts,
      verifiedModel,
    };
  }

  // Plain-text CLIs (agy, opencode without --format json)
  if (cli === 'agy') {
    if (runDir) {
      try {
        const agyLog = fs.readFileSync(path.join(runDir, 'agy.log'), 'utf8');
        const m = extractAgyModel(agyLog);
        if (m.model) verifiedModel = m.model;
      } catch {
        /* ignore */
      }
    }
    return {
      cleanText: raw.trim(),
      toolCalls,
      thoughts,
      verifiedModel,
    };
  }

  const lines = raw.split(/\r?\n/);
  let nonJsonLines = [];
  let sawJsonEvent = false;
  let museTerminalText = null;
  const museDeltas = [];
  let claudeResultText = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (!sawJsonEvent) nonJsonLines.push('');
      continue;
    }
    if (trimmed[0] !== '{') {
      if (!sawJsonEvent) nonJsonLines.push(line);
      continue;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      if (!sawJsonEvent) nonJsonLines.push(line);
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    sawJsonEvent = true;

    if (cli === 'claude' || cli === 'grok') {
      if (parsed.type === 'assistant' && parsed.message) {
        if (parsed.message.model && parsed.message.model !== '<synthetic>' && !verifiedModel) {
          verifiedModel = parsed.message.model;
        }
        for (const block of parsed.message.content || []) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            textParts.push(block.text.trim());
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
            thoughts.push(block.thinking.trim());
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id || `tool-${toolCalls.length + 1}`,
              title: block.name || 'Tool',
              detail: block.input ? JSON.stringify(block.input).slice(0, 140) : '',
              status: 'completed',
            });
          }
        }
      } else if (parsed.type === 'result' && typeof parsed.result === 'string' && parsed.result.trim()) {
        claudeResultText = parsed.result.trim();
      }
    } else if (cli === 'codex') {
      if (parsed.model && !verifiedModel) verifiedModel = String(parsed.model);
      if (parsed.type === 'item.completed' && parsed.item) {
        const item = parsed.item;
        if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
          textParts.push(item.text.trim());
        } else if (item.type === 'reasoning' && typeof item.text === 'string' && item.text.trim()) {
          thoughts.push(item.text.trim());
        } else if (item.type === 'command_execution') {
          toolCalls.push({
            id: item.id || `cmd-${toolCalls.length + 1}`,
            title: item.command || 'command',
            detail: item.exit_code != null ? `exit ${item.exit_code}` : '',
            status: item.status || 'completed',
          });
        }
      }
    } else if (cli === 'vibe') {
      if (parsed.type === 'message' && parsed.role === 'assistant') {
        const msg = vibeMessageText(parsed);
        if (msg) textParts.push(msg);
      } else if (parsed.type === 'effect') {
        toolCalls.push({
          id: parsed.id || `effect-${toolCalls.length + 1}`,
          title: parsed.title || parsed.detail?.toolName || 'tool',
          detail: '',
          status: parsed.generationStatus || 'completed',
        });
      }
    } else if (cli === 'muse') {
      if (parsed.payload_type === 'run.model.configured' && parsed.payload?.model_id) {
        verifiedModel = String(parsed.payload.model_id);
      } else if (parsed.payload_type === 'run.output.delta' && typeof parsed.payload?.text === 'string') {
        museDeltas.push(parsed.payload.text);
      } else if (parsed.payload_type === 'run.terminal.completed' && typeof parsed.payload?.text === 'string') {
        museTerminalText = parsed.payload.text.trim();
      } else if (parsed.payload_type === 'task.lifecycle.proposed') {
        const kind = parsed.payload?.event?.task_kind;
        if (kind && kind !== 'model.meta.response') {
          toolCalls.push({
            id: parsed.payload?.task_id || `task-${toolCalls.length + 1}`,
            title: kind,
            detail: '',
            status: 'completed',
          });
        }
      }
    } else if (cli === 'copilot') {
      if ((parsed.type === 'assistant.usage' || parsed.type === 'model.call_start') && parsed.data?.model && !verifiedModel) {
        verifiedModel = String(parsed.data.model);
      } else if (parsed.type === 'assistant.message' && !parsed.agentId && !parsed.data?.agentId && typeof parsed.data?.content === 'string') {
        if (parsed.data.content.trim()) textParts.push(parsed.data.content.trim());
      } else if (parsed.type === 'tool.execution_start') {
        toolCalls.push({
          id: parsed.data?.toolCallId || `tool-${toolCalls.length + 1}`,
          title: parsed.data?.toolName || 'tool',
          detail: '',
          status: 'completed',
        });
      }
    } else if (cli === 'opencode') {
      if (parsed.type === 'text' && typeof parsed.part?.text === 'string') {
        textParts.push(parsed.part.text);
      } else if (parsed.type === 'tool' || parsed.type === 'tool_use') {
        toolCalls.push({
          id: parsed.part?.id || `tool-${toolCalls.length + 1}`,
          title: parsed.part?.tool || parsed.name || 'tool',
          detail: '',
          status: 'completed',
        });
      }
    }
  }

  let cleanText = '';
  if (!sawJsonEvent) {
    cleanText = nonJsonLines.join('\n').trim();
  } else if (cli === 'muse') {
    cleanText = museTerminalText != null ? museTerminalText : museDeltas.join('').trim();
  } else if ((cli === 'claude' || cli === 'grok') && textParts.length === 0 && claudeResultText) {
    cleanText = claudeResultText;
  } else {
    cleanText = textParts.join('\n\n').trim();
  }

  // Fallback to adapter's extractFinalMessage if needed, but ONLY if it isn't raw JSONL
  if (!cleanText && sawJsonEvent) {
    try {
      const adapter = getAdapter(cli);
      if (adapter && typeof adapter.extractFinalMessage === 'function') {
        const candidate = String(adapter.extractFinalMessage(raw) || '').trim();
        if (candidate && !candidate.startsWith('{"')) {
          cleanText = candidate;
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (cli === 'codex' && !verifiedModel && err) {
    const m = extractCodexModel(err, []);
    if (m.model) verifiedModel = m.model;
  }

  return {
    cleanText,
    toolCalls,
    thoughts,
    verifiedModel,
  };
}

/* ============================================================================
 * 3. ORCHESTRATOR & DIRECT SUBSCRIPTION CHAT ENGINE
 * ========================================================================= */

const activeChatProcesses = new Map();

/**
 * Builds the Orchestrator context preamble when the user is talking to an
 * Orchestrating Model on a repository session.
 */
function buildOrchestratorPrompt({ workspace, userPrompt, history = [], orchestrateMode = true }) {
  const transcriptLines = [];
  const recentHistory = Array.isArray(history) ? history.slice(-6) : [];
  for (const msg of recentHistory) {
    if (!msg || !msg.content) continue;
    const roleLabel = msg.role === 'user' ? 'User' : 'Orchestrator';
    transcriptLines.push(`${roleLabel}:\n${String(msg.content).trim()}`);
  }

  if (!orchestrateMode) {
    if (transcriptLines.length === 0) return String(userPrompt);
    return `Previous conversation in this session:\n\n${transcriptLines.join('\n\n---\n\n')}\n\n---\n\nUser:\n${userPrompt}`;
  }

  const orchBin = path.join(REPO_ROOT, 'orch', 'bin', 'orch.mjs');
  const preamble = [
    `[CHO-desktop Orchestrator Context]`,
    `- Active Repository: ${workspace || REPO_ROOT}`,
    `- Coordinator CLI: node "${orchBin}"`,
    `- You are the Orchestrator for this repository session.`,
    `- For questions, planning, or inspection, answer directly and concisely in clean Markdown.`,
    `- When delegating coding or review work to worker CLIs (opencode, vibe, codex, agy, muse, copilot, claude, grok), use \`node "${orchBin}"\` commands (e.g. \`claim\`, \`pick\`, \`worktree create\`, \`run --no-window\`, \`status\`, \`scope\`, \`review --no-wait\`). Never launch worker CLIs directly outside orch.`,
  ].join('\n');

  if (transcriptLines.length > 0) {
    return `${preamble}\n\nRecent session conversation:\n${transcriptLines.join('\n\n---\n\n')}\n\nUser request:\n${userPrompt}`;
  }
  return `${preamble}\n\nUser request:\n${userPrompt}`;
}

function buildDirectChatSpawn({ harness, model, workspace, role, effort }) {
  const exe = resolveHarnessExecutable(harness);
  if (!exe) {
    throw new Error(`${harness} native executable not found on this machine. Install ${harness} or configure exe.${harness} in orch.config.json.`);
  }
  const cwd = workspace && fs.existsSync(workspace) ? path.resolve(workspace) : REPO_ROOT;
  const readOnly = role === 'review' || role === 'plan';

  if (harness === 'claude') {
    const tools = readOnly ? 'Read,Grep,Glob' : 'Read,Grep,Glob,Edit,Write,Bash';
    const perm = readOnly ? 'default' : 'bypassPermissions';
    const args = [
      '-p',
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--setting-sources', '',
      '--disable-slash-commands',
      '--tools', tools,
      '--permission-mode', perm,
    ];
    const envDelete = deletedEnvironment(
      ['ANTHROPIC_', 'CLAUDE_CODE_USE_'],
      ['AWS_BEARER_TOKEN_BEDROCK', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'NODE_OPTIONS'],
    );
    return { exe, args, cwd, envDelete, stdinPrompt: true };
  }

  if (harness === 'codex') {
    const sandbox = readOnly ? 'read-only' : 'workspace-write';
    const args = [
      'exec',
      '--cd', cwd,
      '--sandbox', sandbox,
      '--json',
      '--color', 'never',
      ...(model ? ['-m', model] : []),
      '-c', `model_reasoning_effort=${effort || 'medium'}`,
      '--skip-git-repo-check',
      '-',
    ];
    const envDelete = deletedEnvironment(['OPENAI_'], ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'NODE_OPTIONS']);
    return { exe, args, cwd, envDelete, stdinPrompt: true };
  }

  if (harness === 'agy') {
    const agyLogFile = path.join(os.tmpdir(), `cho-agy-${crypto.randomBytes(6).toString('hex')}.log`);
    const mode = readOnly ? 'plan' : 'auto';
    const args = [
      '--model', model || 'gemini-4-argon-high',
      '--mode', mode,
      ...(effort ? ['--effort', effort] : []),
      '--dangerously-skip-permissions',
      '--print-timeout', '45m',
      '--log-file', agyLogFile,
      '-p',
    ];
    const envDelete = deletedEnvironment(['GEMINI_', 'GOOGLE_API_'], ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'NODE_OPTIONS']);
    return { exe, args, cwd, envDelete, stdinPrompt: false, appendPromptArg: true, agyLogFile };
  }

  if (harness === 'grok') {
    const tools = readOnly ? 'Read,Grep,Glob' : 'Read,Grep,Glob,Edit,Write,Bash';
    const args = [
      '-p',
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--reasoning-effort', effort] : []),
      '--output-format', 'stream-json',
      '--no-leader',
      '--no-session-persistence',
      '--disable-mcp',
      '--tools', tools,
      '--mode', readOnly ? 'plan' : 'agent',
      '--approval-mode', readOnly ? 'default' : 'full-auto',
    ];
    const envDelete = deletedEnvironment(
      ['XAI_', 'GROK_API_', 'GROK_CODE_XAI_'],
      ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY', 'XAI_BASE_URL', 'GROK_BASE_URL', 'NODE_OPTIONS'],
    );
    return { exe, args, cwd, envDelete, stdinPrompt: true };
  }

  if (harness === 'muse') {
    const tmpPrompt = path.join(os.tmpdir(), `cho-muse-prompt-${crypto.randomBytes(6).toString('hex')}.txt`);
    const args = [
      'exec',
      '--provider', 'meta',
      '--json',
      '--workspace', cwd,
      '--prompt-file', tmpPrompt,
      '--model', model || 'muse-spark-1.3',
      '--reasoning-effort', effort || 'medium',
      '--worktree', 'off',
      '--approval-mode', 'never',
      '--approval-judge', 'off',
      '--disable-reminders',
      '--disable-web-tools',
      '--no-foreign-personal-context',
      '--trust-workspace',
      ...(readOnly ? ['--disable-write', '--disable-shell'] : []),
      '--no-session-log',
    ];
    const envDelete = deletedEnvironment(
      [],
      ['META_API_KEY', 'META_BASE_URL', 'META_API_BASE', 'MUSE_API_KEY', 'MUSE_BASE_URL', 'MUSE_TRANSPORT_TRACE', 'NODE_OPTIONS'],
    );
    return { exe, args, cwd, envDelete, stdinPrompt: false, tmpPrompt };
  }

  if (harness === 'copilot') {
    const args = [
      '-C', cwd,
      '--model', model || 'auto',
      ...(effort && model !== 'auto' ? ['--reasoning-effort', effort] : []),
      '--output-format', 'json',
      '--no-ask-user',
      '--no-color',
      '--no-auto-update',
      '--no-remote-export',
      '--disable-builtin-mcps',
      '--available-tools', readOnly ? 'view,glob,grep' : 'view,glob,grep,edit,create,powershell,bash',
      '--allow-all-tools',
      '--log-level', 'none',
    ];
    const envDelete = deletedEnvironment(
      ['COPILOT_PROVIDER_'],
      ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'NODE_OPTIONS'],
    );
    return { exe, args, cwd, envDelete, stdinPrompt: false, appendPromptFlag: '-p' };
  }

  if (harness === 'vibe') {
    const args = [
      '-p',
      '--workdir', cwd,
      '--output', 'streaming',
      '--max-turns', '25',
      ...(readOnly ? ['--enabled-tools', 'read_file,grep,glob'] : ['--auto-approve', '--trust']),
    ];
    const envDelete = deletedEnvironment(['MISTRAL_'], ['MISTRAL_API_KEY', 'NODE_OPTIONS']);
    return { exe, args, cwd, envDelete, stdinPrompt: true };
  }

  if (harness === 'opencode') {
    const args = [
      'run',
      ...(model ? ['--model', model] : []),
      '--dir', cwd,
      '--print-logs',
    ];
    return { exe, args, cwd, envDelete: ['NODE_OPTIONS'], stdinPrompt: true };
  }

  throw new Error(`Unsupported harness: ${harness}`);
}

export async function startDirectChatTurn({
  sessionId,
  harness,
  model,
  workspace,
  role = 'implement',
  effort = 'medium',
  prompt,
  history = [],
  orchestrateMode = true,
}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error('Prompt cannot be empty.');
  }
  const fullPrompt = buildOrchestratorPrompt({
    workspace,
    userPrompt: String(prompt),
    history,
    orchestrateMode,
  });

  const spec = buildDirectChatSpawn({ harness, model, workspace, role, effort });
  const args = [...spec.args];
  if (spec.tmpPrompt) {
    fs.writeFileSync(spec.tmpPrompt, fullPrompt, 'utf8');
  } else if (spec.appendPromptFlag) {
    args.push(spec.appendPromptFlag, fullPrompt.slice(0, 11500));
  } else if (spec.appendPromptArg) {
    args.push(fullPrompt.slice(0, 29000));
  }

  const childEnv = { ...process.env, PWD: spec.cwd, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  for (const key of spec.envDelete || []) {
    delete childEnv[key];
  }

  const turnId = `turn-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const child = spawn(spec.exe, args, {
    cwd: spec.cwd,
    env: childEnv,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  activeChatProcesses.set(sessionId, child);

  broadcastEvent('cho:stream', {
    sessionId,
    turnId,
    harness,
    kind: 'status',
    text: `${path.basename(spec.exe)} active (PID ${child.pid})`,
    executablePath: spec.exe,
    pid: child.pid,
  });

  if (spec.stdinPrompt) {
    child.stdin.write(fullPrompt);
  }
  child.stdin.end();

  let stdoutBuf = '';
  let stderrFull = '';
  let verifiedModel = null;
  let emittedAnyText = false;
  let emittedMuseDelta = false;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const emitDelta = (text) => {
    if (!text) return;
    const prefix = emittedAnyText && !text.startsWith('\n') && (harness === 'codex' || harness === 'vibe') ? '\n\n' : '';
    emittedAnyText = true;
    broadcastEvent('cho:stream', {
      sessionId,
      turnId,
      harness,
      kind: 'message_delta',
      text: prefix + text,
    });
  };

  // For plain-text stdout CLIs (`agy` and `opencode`), stream stdout chunks directly as clean response text!
  if (harness === 'agy' || harness === 'opencode') {
    child.stdout.on('data', (chunk) => {
      if (!chunk) return;
      emittedAnyText = true;
      broadcastEvent('cho:stream', {
        sessionId,
        turnId,
        harness,
        kind: 'message_delta',
        text: String(chunk),
      });
      if (harness === 'agy' && spec.agyLogFile && !verifiedModel) {
        try {
          const logText = fs.readFileSync(spec.agyLogFile, 'utf8');
          const m = extractAgyModel(logText);
          if (m.model) {
            verifiedModel = m.model;
            broadcastEvent('cho:stream', { sessionId, turnId, harness, kind: 'model_verified', model: verifiedModel });
          }
        } catch {
          /* ignore */
        }
      }
    });
  } else {
    // JSONL protocol CLIs (`claude`, `grok`, `codex`, `muse`, `copilot`, `vibe`):
    // Parse strictly and emit ONLY clean response text, thoughts, and tool calls — NEVER raw JSONL!
    const processJsonLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed[0] !== '{') {
        // Non-JSON line on stdout
        emitDelta(line + '\n');
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;

      if (harness === 'claude' || harness === 'grok') {
        if (parsed.type === 'assistant' && parsed.message) {
          if (parsed.message.model && parsed.message.model !== '<synthetic>' && !verifiedModel) {
            verifiedModel = parsed.message.model;
            broadcastEvent('cho:stream', { sessionId, turnId, harness, kind: 'model_verified', model: verifiedModel });
          }
          for (const block of parsed.message.content || []) {
            if (block.type === 'thinking' && block.thinking) {
              broadcastEvent('cho:stream', { sessionId, turnId, harness, kind: 'thought_delta', text: block.thinking });
            } else if (block.type === 'text' && block.text) {
              emitDelta(block.text);
            } else if (block.type === 'tool_use') {
              broadcastEvent('cho:stream', {
                sessionId,
                turnId,
                harness,
                kind: 'tool_call',
                toolCallId: block.id || 'tool',
                toolTitle: block.name || 'Tool',
                toolStatus: 'completed',
              });
            }
          }
        } else if (parsed.type === 'result') {
          if (parsed.is_error) {
            broadcastEvent('cho:stream', {
              sessionId,
              turnId,
              harness,
              kind: 'error',
              text: String(parsed.result || 'CLI returned an error result'),
            });
          } else if (!emittedAnyText && typeof parsed.result === 'string' && parsed.result.trim()) {
            emitDelta(parsed.result);
          }
        }
      } else if (harness === 'codex') {
        if (parsed.model && !verifiedModel) {
          verifiedModel = String(parsed.model);
          broadcastEvent('cho:stream', { sessionId, turnId, harness, kind: 'model_verified', model: verifiedModel });
        }
        if (parsed.type === 'item.completed' && parsed.item) {
          const item = parsed.item;
          if (item.type === 'agent_message' && item.text) {
            emitDelta(item.text);
          } else if (item.type === 'reasoning' && item.text) {
            broadcastEvent('cho:stream', { sessionId, turnId, harness, kind: 'thought_delta', text: item.text });
          } else if (item.type === 'command_execution') {
            broadcastEvent('cho:stream', {
              sessionId,
              turnId,
              harness,
              kind: 'tool_call',
              toolCallId: item.id || 'cmd',
              toolTitle: item.command || 'command',
              toolStatus: item.status || 'completed',
            });
          } else if (item.type === 'error' && item.message && !String(item.message).startsWith('Codex is ignoring')) {
            broadcastEvent('cho:stream', {
              sessionId,
              turnId,
              harness,
              kind: 'error',
              text: String(item.message),
            });
          }
        } else if (parsed.type === 'error' || parsed.type === 'turn.failed') {
          broadcastEvent('cho:stream', {
            sessionId,
            turnId,
            harness,
            kind: 'error',
            text: String(parsed.message || parsed.error?.message || 'Codex error'),
          });
        }
      } else if (harness === 'muse') {
        if (parsed.payload_type === 'run.model.configured' && parsed.payload?.model_id) {
          verifiedModel = parsed.payload.model_id;
          broadcastEvent('cho:stream', { sessionId, turnId, harness, kind: 'model_verified', model: verifiedModel });
        } else if (parsed.payload_type === 'run.output.delta' && typeof parsed.payload?.text === 'string') {
          emittedMuseDelta = true;
          emittedAnyText = true;
          broadcastEvent('cho:stream', { sessionId, turnId, harness, kind: 'message_delta', text: parsed.payload.text });
        } else if (parsed.payload_type === 'run.terminal.completed' && typeof parsed.payload?.text === 'string') {
          if (!emittedMuseDelta) {
            emitDelta(parsed.payload.text);
          }
        } else if (parsed.payload_type === 'task.lifecycle.proposed') {
          const kind = parsed.payload?.event?.task_kind;
          if (kind && kind !== 'model.meta.response') {
            broadcastEvent('cho:stream', {
              sessionId,
              turnId,
              harness,
              kind: 'tool_call',
              toolCallId: parsed.payload?.task_id || 'task',
              toolTitle: kind,
              toolStatus: 'completed',
            });
          }
        } else if (parsed.payload_type === 'run.terminal.failed') {
          broadcastEvent('cho:stream', {
            sessionId,
            turnId,
            harness,
            kind: 'error',
            text: String(parsed.payload?.reason || parsed.payload?.message || 'Muse error'),
          });
        }
      } else if (harness === 'copilot') {
        if ((parsed.type === 'assistant.usage' || parsed.type === 'model.call_start') && parsed.data?.model && !verifiedModel) {
          verifiedModel = parsed.data.model;
          broadcastEvent('cho:stream', { sessionId, turnId, harness, kind: 'model_verified', model: verifiedModel });
        } else if (parsed.type === 'assistant.message' && !parsed.agentId && !parsed.data?.agentId && typeof parsed.data?.content === 'string') {
          emitDelta(parsed.data.content);
        } else if (parsed.type === 'tool.execution_start') {
          broadcastEvent('cho:stream', {
            sessionId,
            turnId,
            harness,
            kind: 'tool_call',
            toolCallId: parsed.data?.toolCallId || 'tool',
            toolTitle: parsed.data?.toolName || 'tool',
            toolStatus: 'completed',
          });
        } else if (parsed.type === 'session.error') {
          broadcastEvent('cho:stream', {
            sessionId,
            turnId,
            harness,
            kind: 'error',
            text: String(parsed.data?.message || parsed.message || 'Copilot error'),
          });
        }
      } else if (harness === 'vibe') {
        if (parsed.type === 'message' && parsed.role === 'assistant') {
          const text = vibeMessageText(parsed);
          if (text) emitDelta(text);
        } else if (parsed.type === 'effect') {
          broadcastEvent('cho:stream', {
            sessionId,
            turnId,
            harness,
            kind: 'tool_call',
            toolCallId: parsed.id || 'effect',
            toolTitle: parsed.title || parsed.detail?.toolName || 'tool',
            toolStatus: 'completed',
          });
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      while (true) {
        const idx = stdoutBuf.indexOf('\n');
        if (idx === -1) break;
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        processJsonLine(line);
      }
    });

    child.on('close', () => {
      if (stdoutBuf.trim()) {
        processJsonLine(stdoutBuf);
        stdoutBuf = '';
      }
    });
  }

  child.stderr.on('data', (chunk) => {
    stderrFull += chunk;
    if (harness === 'codex' && !verifiedModel) {
      const extracted = extractCodexModel(stderrFull, []);
      if (extracted.model) {
        verifiedModel = extracted.model;
        broadcastEvent('cho:stream', { sessionId, turnId, harness, kind: 'model_verified', model: verifiedModel });
      }
    }
  });

  child.on('close', (code) => {
    activeChatProcesses.delete(sessionId);
    if (harness === 'agy' && spec.agyLogFile) {
      try {
        const logText = fs.readFileSync(spec.agyLogFile, 'utf8');
        const m = extractAgyModel(logText);
        if (m.model && !verifiedModel) {
          verifiedModel = m.model;
          broadcastEvent('cho:stream', { sessionId, turnId, harness, kind: 'model_verified', model: verifiedModel });
        }
        fs.unlinkSync(spec.agyLogFile);
      } catch {
        /* ignore */
      }
    }
    if (spec.tmpPrompt && fs.existsSync(spec.tmpPrompt)) {
      try { fs.unlinkSync(spec.tmpPrompt); } catch { /* ignore */ }
    }
    if (code !== 0 && stderrFull.trim()) {
      broadcastEvent('cho:stream', {
        sessionId,
        turnId,
        harness,
        kind: 'error',
        text: stderrFull.trim().slice(-1200),
      });
    }
    broadcastEvent('cho:stream', {
      sessionId,
      turnId,
      harness,
      kind: 'turn_complete',
      exitCode: code ?? 0,
      model: verifiedModel,
    });
  });

  return {
    sessionId,
    turnId,
    harness,
    executablePath: spec.exe,
    pid: child.pid,
    cwd: spec.cwd,
    strippedEnvCount: (spec.envDelete || []).length,
  };
}

export function cancelDirectChatTurn({ sessionId }) {
  const proc = activeChatProcesses.get(sessionId);
  if (!proc) return { cancelled: false, detail: 'No active process for session' };
  try {
    proc.kill();
    activeChatProcesses.delete(sessionId);
    return { cancelled: true };
  } catch (e) {
    return { cancelled: false, detail: String(e.message || e) };
  }
}

/* ============================================================================
 * 4. REPOSITORY DISCOVERY & ORCH COORDINATOR CONTROL PLANE
 * ========================================================================= */

export function discoverRepositories() {
  const rootsToScan = new Set([
    path.dirname(REPO_ROOT),
    REPO_ROOT,
  ]);
  const repos = [];
  const seen = new Set();

  const addRepoIfValid = (dirPath) => {
    try {
      const resolved = path.resolve(dirPath);
      const key = resolved.toLowerCase();
      if (seen.has(key)) return;
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return;
      if (!fs.existsSync(path.join(resolved, '.git'))) return;
      seen.add(key);

      let branch = 'HEAD';
      try {
        const headFile = path.join(resolved, '.git', 'HEAD');
        if (fs.existsSync(headFile)) {
          const headTxt = fs.readFileSync(headFile, 'utf8').trim();
          const m = /^ref:\s*refs\/heads\/(.+)$/.exec(headTxt);
          branch = m ? m[1] : headTxt.slice(0, 8);
        }
      } catch {
        /* ignore */
      }

      const adopted =
        fs.existsSync(path.join(resolved, 'ORCHESTRATOR.md')) ||
        fs.existsSync(path.join(resolved, '.claude', 'settings.json')) ||
        fs.existsSync(path.join(resolved, 'AGENTS.md'));

      repos.push({
        path: resolved,
        name: path.basename(resolved),
        branch,
        adopted,
      });
    } catch {
      /* ignore */
    }
  };

  addRepoIfValid(REPO_ROOT);
  for (const parentDir of rootsToScan) {
    try {
      for (const entry of fs.readdirSync(parentDir)) {
        addRepoIfValid(path.join(parentDir, entry));
      }
    } catch {
      /* ignore */
    }
  }

  return repos;
}

async function execOrchTool(toolName, args = {}) {
  const prevViewer = process.env.ORCH_VIEWER;
  process.env.ORCH_VIEWER = 'none';
  try {
    const res = await callTool(toolName, args);
    return {
      ok: !res.isError && res.structuredContent?.exit_code === 0,
      exitCode: res.structuredContent?.exit_code ?? (res.isError ? 2 : 0),
      output: res.structuredContent?.output ?? null,
      text: res.content?.map((c) => c.text).join('\n') || '',
      error: res.structuredContent?.error || null,
    };
  } finally {
    if (prevViewer === undefined) delete process.env.ORCH_VIEWER;
    else process.env.ORCH_VIEWER = prevViewer;
  }
}

async function execOrchCli(cmd, argvList) {
  const lines = [];
  const io = { log: (s) => lines.push(String(s)) };
  const prevViewer = process.env.ORCH_VIEWER;
  process.env.ORCH_VIEWER = 'none';
  try {
    const parsed = parseArgs([...argvList, '--json']);
    const res = await runCommand(cmd, parsed, io);
    const text = lines.join('\n');
    let output = null;
    try { output = JSON.parse(text); } catch { output = null; }
    return {
      ok: (res?.exitCode ?? 0) === 0,
      exitCode: res?.exitCode ?? 0,
      output,
      text,
    };
  } catch (e) {
    return {
      ok: false,
      exitCode: 2,
      output: null,
      text: e.message || String(e),
      error: e.code || 'orch-error',
    };
  } finally {
    if (prevViewer === undefined) delete process.env.ORCH_VIEWER;
    else process.env.ORCH_VIEWER = prevViewer;
  }
}

function loadRecentRunsFast(limit = 45, worktrees = []) {
  const runsDir = path.join(resolveStateRoot(), 'runs');
  if (!fs.existsSync(runsDir)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(runsDir).sort().reverse().slice(0, limit);
  } catch {
    return [];
  }
  const out = [];
  for (const id of entries) {
    const runDir = path.join(runsDir, id);
    const recPath = path.join(runDir, 'run.json');
    if (!fs.existsSync(recPath)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
      const normalize = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const worktree = worktrees.find(item => normalize(item.path) === normalize(rec.dir));
      out.push({
        id: rec.id || id,
        cli: rec.cli || 'opencode',
        lane: rec.lane || 'cloud',
        model_requested: rec.model_requested || rec.model_canonical || '',
        model_canonical: rec.model_canonical || '',
        model_actual: rec.model_actual || null,
        role: rec.role || 'implement',
        status: rec.status || 'unknown',
        derived_status: rec.status || 'unknown',
        derived_reason: rec.reason || null,
        wp: rec.wp || null,
        slice: rec.slice || null,
        dir: rec.dir || '',
        repository: worktree?.repo || null,
        worker_pid: rec.worker_pid || null,
        created_at: rec.created_at || rec.started_at || '',
        ended_at: rec.ended_at || null,
        exit_code: rec.exit_code ?? null,
        paths: {
          dir: runDir,
          record: recPath,
          stdout: path.join(runDir, 'stdout.log'),
          stderr: path.join(runDir, 'stderr.log'),
          keeper: path.join(runDir, 'keeper.ndjson'),
        },
      });
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Passive coordinator overview. Launches no model-catalog subprocess and
 * makes no network/provider calls; harnesses come from discoverHarnesses().
 */
export async function getOrchDashboard() {
  // The overview needs ownership records, not a Git status in every worktree.
  // Explicit scope checks still use the coordinator's live verification path.
  const claimsRes = await execOrchTool('claims', {});
  const worktrees = listWorktreeRecords({ stateRoot: resolveStateRoot() });

  const rosterPath = fs.existsSync(path.join(REPO_ROOT, 'orch/roster.json'))
    ? path.join(REPO_ROOT, 'orch/roster.json')
    : path.join(REPO_ROOT, 'orch/roster.example.json');
  const rosterSource = path.relative(REPO_ROOT, rosterPath).replace(/\\/g, '/');
  let roster;
  try {
    roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8')).models || [];
  } catch {
    roster = [];
  }

  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'model-catalog.json'), 'utf8')).models || [];
  } catch {
    catalog = [];
  }

  const sortedRuns = loadRecentRunsFast(50, worktrees);

  return {
    repoRoot: REPO_ROOT,
    repositories: discoverRepositories(),
    rosterSource,
    claims: claimsRes.output?.claims || (Array.isArray(claimsRes.output) ? claimsRes.output : []),
    worktrees: worktrees.map(({ id, wp, slice, repo, path: worktreePath, branch, baseline, removed_at }) => ({
      id, wp, slice, repo, path: worktreePath, branch, baseline, removed_at: removed_at || null,
    })),
    runs: sortedRuns,
    roster,
    catalog,
    harnesses: discoverHarnesses(),
  };
}

export async function launchOrchRun(params) {
  const {
    cli,
    model,
    dir,
    handoffText,
    handoffPath,
    wp,
    slice,
    by,
    effort,
    size,
    allow,
    ownerApprovedModel,
  } = params;

  let effectiveHandoff = handoffPath;
  if (!effectiveHandoff && handoffText) {
    const handoffDir = path.join(REPO_ROOT, 'orch', '.state', 'ui-handoffs');
    fs.mkdirSync(handoffDir, { recursive: true });
    effectiveHandoff = path.join(handoffDir, `handoff-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.md`);
    fs.writeFileSync(effectiveHandoff, String(handoffText), 'utf8');
  }

  const toolArgs = {
    cli,
    model,
    dir: dir || REPO_ROOT,
    handoff: effectiveHandoff,
    'no-window': true,
    ...(wp ? { wp } : {}),
    ...(slice ? { slice } : {}),
    ...(by ? { by } : {}),
    ...(effort ? { effort } : {}),
    ...(size ? { size } : {}),
    ...(Array.isArray(allow) && allow.length ? { allow } : {}),
    ...(ownerApprovedModel ? { 'owner-approved-model': true } : {}),
  };

  return execOrchTool('run', toolArgs);
}

export async function getOrchRunDetail({ runId }) {
  const [statusRes, resultRes, stderrTail, keeperTail] = await Promise.all([
    execOrchTool('status', { id: runId }),
    execOrchTool('result', { id: runId }),
    execOrchTool('log_tail', { id: runId, stream: 'stderr', tail: 120 }),
    execOrchTool('log_tail', { id: runId, stream: 'keeper', tail: 80 }),
  ]);

  const statusObj = statusRes.output?.runs?.[0] || statusRes.output || {};
  const cli = statusObj.cli || resultRes.output?.cli || 'opencode';
  const stdoutPath = statusObj.paths?.stdout;
  const runDir = statusObj.paths?.dir;

  let rawStdout = '';
  if (stdoutPath && fs.existsSync(stdoutPath)) {
    try {
      const st = fs.statSync(stdoutPath);
      if (st.size <= 8 * 1024 * 1024) {
        rawStdout = fs.readFileSync(stdoutPath, 'utf8');
      }
    } catch {
      /* ignore */
    }
  }

  const extracted = extractCleanRunOutput(cli, rawStdout, stderrTail.text, runDir);
  const cleanResponseText =
    extracted.cleanText ||
    (typeof resultRes.output?.final_message === 'string' && !resultRes.output.final_message.startsWith('{"')
      ? resultRes.output.final_message
      : '');

  return {
    runId,
    status: statusObj,
    result: resultRes.output,
    cleanResponseText,
    toolCalls: extracted.toolCalls,
    thoughts: extracted.thoughts,
    verifiedModel: extracted.verifiedModel || statusObj.model_actual || null,
    logs: {
      // Notice: stdout is now ALWAYS the clean extracted response text, never raw JSONL!
      stdout: cleanResponseText,
      stderr: stderrTail.text,
      keeper: keeperTail.text,
    },
  };
}

export async function launchOrchReview(params) {
  const { run, ref = 'HEAD', reviewer, model, promptText, promptPath, by = 'owner', effort } = params;
  let effectivePrompt = promptPath;
  if (!effectivePrompt) {
    const promptDir = path.join(REPO_ROOT, 'orch', '.state', 'ui-handoffs');
    fs.mkdirSync(promptDir, { recursive: true });
    effectivePrompt = path.join(promptDir, `review-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.md`);
    const defaultTemplate =
      promptText ||
      `Review commit ${ref} in worktree {{WORKTREE}}.\nInspect changed files, verify correctness and regressions, and report findings with severity (critical/high/medium/low).\n`;
    fs.writeFileSync(effectivePrompt, defaultTemplate, 'utf8');
  }

  return execOrchTool('review', {
    run,
    ref,
    reviewer,
    model,
    prompt: effectivePrompt,
    by,
    'no-window': true,
    ...(effort ? { effort } : {}),
  });
}

/* ============================================================================
 * 5. WORKSPACE TRUST & SESSION PERSISTENCE
 * ========================================================================= */

function grokHomeDir() {
  if (process.env.GROK_HOME) return path.resolve(process.env.GROK_HOME);
  return path.join(os.homedir(), '.grok');
}

function grokTrustStorePath() {
  return path.join(grokHomeDir(), 'desktop-trusted-workspaces.json');
}

export function isWorkspaceTrusted({ workspace }) {
  try {
    const canonical = fs.existsSync(workspace) ? fs.realpathSync(workspace) : path.resolve(workspace);
    const storeFile = grokTrustStorePath();
    if (!fs.existsSync(storeFile)) return false;
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    return Boolean(store?.trusted?.[canonical]);
  } catch {
    return false;
  }
}

export function setWorkspaceTrusted({ workspace, trusted }) {
  const canonical = fs.existsSync(workspace) ? fs.realpathSync(workspace) : path.resolve(workspace);
  const storeFile = grokTrustStorePath();
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  let store = { trusted: {} };
  if (fs.existsSync(storeFile)) {
    try { store = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { store = { trusted: {} }; }
  }
  if (!store.trusted) store.trusted = {};
  if (trusted) {
    store.trusted[canonical] = { trusted_at_unix: Math.floor(Date.now() / 1000) };
  } else {
    delete store.trusted[canonical];
  }
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

/* ============================================================================
 * 6. UNIFIED RPC COMMAND ROUTER
 * ========================================================================= */

export async function handleBridgeCommand(command, args = {}) {
  switch (command) {
    case 'discover_harnesses':
      return discoverHarnesses();
    case 'discover_repositories':
      return discoverRepositories();
    case 'direct_chat_send':
      return startDirectChatTurn(args);
    case 'direct_chat_cancel':
      return cancelDirectChatTurn(args);
    case 'orch_dashboard':
      return getOrchDashboard();
    case 'orch_claim':
      return execOrchTool('claim', { wp: args.wp, by: args.by || 'owner', ...(args.note ? { note: args.note } : {}) });
    case 'orch_release':
      return execOrchTool('release', {
        wp: args.wp,
        by: args.by || 'owner',
        ...(args.force ? { force: true, reason: args.reason || 'released from CHO-desktop' } : {}),
      });
    case 'orch_worktree_create':
      return execOrchTool('worktree_create', {
        repo: args.repo || REPO_ROOT,
        wp: args.wp,
        slice: args.slice,
        by: args.by || 'owner',
        ...(args.base ? { base: args.base } : {}),
      });
    case 'orch_pick':
      return execOrchTool('pick', {
        workload: args.workload || 'implement',
        size: args.size || 'S',
        ...(args.forRun ? { 'for-run': args.forRun } : {}),
      });
    case 'orch_run':
      return launchOrchRun(args);
    case 'orch_run_detail':
      return getOrchRunDetail(args);
    case 'orch_cancel':
      return execOrchTool('cancel', { id: args.runId });
    case 'orch_scope':
      return execOrchTool('scope', { run_id: args.runId });
    case 'orch_review':
      return launchOrchReview(args);
    case 'orch_review_finish':
      return execOrchTool('review_finish', { review_id: args.reviewId, by: args.by || 'owner' });
    case 'orch_gate_status':
      return execOrchTool('gate_status', { wp: args.wp, slice: args.slice });
    case 'orch_gate_record':
      return execOrchTool('gate_record', {
        wp: args.wp,
        slice: args.slice,
        round: args.round ?? 1,
        findings: typeof args.findings === 'string' ? args.findings : JSON.stringify(args.findings || []),
        verification: args.verification || 'pass',
        ...(args.scopeRun ? { 'scope-run': args.scopeRun } : { scope: args.scope || 'pass' }),
        by: args.by || 'owner',
      });
    case 'orch_record':
      return execOrchTool('record', {
        run_id: args.runId,
        disposition: args.disposition || 'accepted',
        ...(args.notes ? { notes: args.notes } : {}),
      });
    case 'orch_cleanup':
      return execOrchTool('cleanup', {
        wp: args.wp,
        ...(args.apply ? { apply: true } : { 'dry-run': true }),
        ...(args.by ? { by: args.by } : {}),
      });
    case 'orch_finish':
      return execOrchTool('finish', { wp: args.wp, by: args.by || 'owner' });
    case 'orch_adopt':
      return execOrchCli('adopt', [
        '--repo', args.repo || REPO_ROOT,
        ...(args.dryRun !== false ? ['--dry-run'] : []),
        ...(args.update ? ['--update'] : []),
        ...(args.harness ? ['--harness', args.harness] : []),
      ]);
    case 'orch_usage':
      return execOrchTool('usage', { ...(args.refresh ? { refresh: true } : {}) });
    case 'orch_quota':
      return execOrchTool('quota', { ...(args.refresh ? { refresh: true } : {}) });
    case 'is_workspace_trusted':
      return isWorkspaceTrusted(args);
    case 'set_workspace_trusted':
      setWorkspaceTrusted(args);
      return { ok: true };
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

/* ============================================================================
 * 7. HTTP + SSE SERVER
 * ========================================================================= */

export function createBridgeServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/invoke') {
      let body = '';
      req.setEncoding('utf8');
      for await (const chunk of req) body += chunk;
      try {
        const { command, args } = JSON.parse(body || '{}');
        const result = await handleBridgeCommand(command, args || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createBridgeServer();
  server.listen(DEFAULT_PORT, '0.0.0.0', () => {
    console.log(`[CHO-desktop Bridge] Listening on http://0.0.0.0:${DEFAULT_PORT} (repo: ${REPO_ROOT})`);
  });
}
