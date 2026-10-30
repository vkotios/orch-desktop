import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REPO_ROOT,
  discoverHarnesses,
  extractCleanRunOutput,
  getOrchDashboard,
  handleBridgeCommand,
} from '../server/bridge.mjs';

// Hermetic module-boundary mocks: passive discovery must never reach a real
// subprocess, installed CLI, home directory, credential file, or coordinator
// state directory. Anything outside the fixtures below throws or reads empty.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const blocked = (name: string) => () => {
    throw new Error(`${name} blocked (isolated fixture)`);
  };
  return {
    ...actual,
    spawn: vi.fn(blocked('spawn')),
    spawnSync: vi.fn(blocked('spawnSync')),
    execFileSync: vi.fn(blocked('execFileSync')),
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = vi.fn(() => '/fixtures/home');
  const defaultExport = { ...((actual as unknown as { default?: object }).default ?? actual), homedir };
  return { ...actual, homedir, default: defaultExport };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const norm = (p: unknown) => String(p).replace(/\\/g, '/');
  const rosterJson = JSON.stringify({
    models: [
      { cli: 'claude', model: 'fixture-claude-pro' },
      { cli: 'agy', model: 'fixture-agy-model' },
    ],
  });
  const catalogJson = JSON.stringify({ models: [{ id: 'fixture-catalog-entry' }] });
  const enoent = (p: unknown) =>
    Object.assign(new Error(`ENOENT (isolated fixture): ${String(p)}`), { code: 'ENOENT' });
  // Bridge (`import fs from 'node:fs'`) and this file both read through the
  // default export, so named and default views must share one spy per method.
  const existsSync = vi.fn((p: unknown) => norm(p).endsWith('/orch/roster.example.json'));
  const readFileSync = vi.fn(((p: unknown) => {
    const n = norm(p);
    if (n.endsWith('/orch/roster.example.json')) return rosterJson;
    if (n.endsWith('/model-catalog.json')) return catalogJson;
    throw enoent(p);
  }) as typeof actual.readFileSync);
  const readdirSync = vi.fn((() => []) as unknown as typeof actual.readdirSync);
  const statSync = vi.fn(((p: unknown) => {
    throw enoent(p);
  }) as unknown as typeof actual.statSync);
  const defaultExport = {
    ...((actual as unknown as { default?: object }).default ?? actual),
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
  };
  return {
    ...actual,
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
    default: defaultExport,
  };
});

vi.mock('../../../orch/src/exe.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveCliExe: () => {
      throw new Error('cli-not-found (isolated fixture)');
    },
  };
});

vi.mock('../../../orch/src/adapters/claude.mjs', async (importOriginal) => {
  const actual =
    await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveClaudeExe: () => '/fixtures/bin/claude' };
});

vi.mock('../../../orch/src/adapters/grok.mjs', async (importOriginal) => {
  const actual =
    await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveGrokExe: () => {
      throw new Error('cli-not-found (isolated fixture)');
    },
  };
});

vi.mock('../../../orch/src/adapters/muse.mjs', async (importOriginal) => {
  const actual =
    await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveMuseExe: () => {
      throw new Error('cli-not-found (isolated fixture)');
    },
    museAuthPath: () => '/fixtures/home/.muse/auth.json',
  };
});

vi.mock('../../../orch/src/adapters/copilot.mjs', async (importOriginal) => {
  const actual =
    await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveCopilotExe: () => {
      throw new Error('cli-not-found (isolated fixture)');
    },
  };
});

vi.mock('../../../orch/src/adapters/opencode.mjs', async (importOriginal) => {
  const actual =
    await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveOpencodeExe: () => {
      throw new Error('cli-not-found (isolated fixture)');
    },
  };
});

vi.mock('../../../orch/src/adapters/agy.mjs', async (importOriginal) => {
  const actual =
    await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveAgyExe: () => '/fixtures/bin/agy' };
});

vi.mock('../../../orch/src/config.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveStateRoot: () => '/fixtures/state' };
});

vi.mock('../../../orch/src/worktrees.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, listWorktreeRecords: () => [] };
});

vi.mock('../../../orch/src/mcp.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    callTool: async () => ({
      isError: false,
      structuredContent: {
        exit_code: 0,
        output: { claims: [{ wp: 'CHO-01', slice: 'discovery', by: 'owner' }] },
      },
      content: [{ type: 'text', text: '{}' }],
    }),
  };
});

const HARNESS_IDS = [
  'claude',
  'codex',
  'agy',
  'grok',
  'muse',
  'copilot',
  'vibe',
  'opencode',
];

beforeEach(() => {
  vi.mocked(spawn).mockClear();
  vi.mocked(spawnSync).mockClear();
  vi.mocked(execFileSync).mockClear();
  vi.mocked(fs.existsSync).mockClear();
  vi.mocked(fs.readFileSync).mockClear();
  vi.mocked(fs.readdirSync).mockClear();
});

describe('CHO Desktop Host Bridge (isolated fixtures)', () => {
  it('discovers all 8 harnesses with orchestrator/chat roles and stripped API env vars', () => {
    const harnesses = discoverHarnesses();
    expect(harnesses.map((h) => h.id)).toEqual(HARNESS_IDS);
    for (const h of harnesses) {
      expect(h.roles).toContain('chat');
      expect(Array.isArray(h.envStripped)).toBe(true);
    }

    const agy = harnesses.find((h) => h.id === 'agy');
    expect(agy?.roles).toContain('controller');
    expect(agy?.envStripped).toContain('GEMINI_API_KEY');
    expect(agy?.installed).toBe(true);
    expect(agy?.executablePath).toBe('/fixtures/bin/agy');
    expect(agy?.authHint).toBe('saved-login-detected');

    // No real credential files are visible, so an installed CLI without
    // fixture credentials reports its login hint instead of saved-login.
    const claude = harnesses.find((h) => h.id === 'claude');
    expect(claude?.installed).toBe(true);
    expect(claude?.authHint).toBe('run `claude auth login`');

    const grok = harnesses.find((h) => h.id === 'grok');
    expect(grok?.envStripped).toContain('XAI_API_KEY');
    expect(grok?.envStripped).toContain('GROK_API_KEY');
    expect(grok?.installed).toBe(false);
    expect(grok?.authHint).toBe('not-installed');
  });

  it('prefers configured roster models and falls back to static defaults', () => {
    const harnesses = discoverHarnesses();

    const agy = harnesses.find((h) => h.id === 'agy');
    expect(agy?.defaultModel).toBe('fixture-agy-model');
    expect(agy?.suggestedModels[0]).toBe('fixture-agy-model');
    expect(agy?.suggestedModels).toContain('gemini-4-argon-high');

    const grok = harnesses.find((h) => h.id === 'grok');
    expect(grok?.defaultModel).toBe('grok-4.20');
    expect(grok?.suggestedModels).toContain('grok-4.20');

    // The roster preference came from the mocked roster boundary, not statics.
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('roster.example.json'),
      'utf8',
    );
  });

  it('cold passive discovery launches no subprocess through the real router path', async () => {
    const viaRouter = await handleBridgeCommand('discover_harnesses', {});
    expect(viaRouter.map((h: { id: string }) => h.id)).toEqual(HARNESS_IDS);

    const dashboard = await handleBridgeCommand('orch_dashboard', {});
    expect(dashboard.harnesses.map((h: { id: string }) => h.id)).toEqual(HARNESS_IDS);

    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it('returns the orch dashboard shape from the real default path', async () => {
    const dashboard = await getOrchDashboard();

    expect(dashboard.roster).toEqual([
      { cli: 'claude', model: 'fixture-claude-pro' },
      { cli: 'agy', model: 'fixture-agy-model' },
    ]);
    expect(dashboard.rosterSource).toBe('orch/roster.example.json');
    expect(dashboard.catalog).toEqual([{ id: 'fixture-catalog-entry' }]);
    expect(dashboard.claims).toEqual([{ wp: 'CHO-01', slice: 'discovery', by: 'owner' }]);
    expect(dashboard.worktrees).toEqual([]);
    expect(dashboard.runs).toEqual([]);
    expect(dashboard.repositories).toEqual([]);
    expect(dashboard.harnesses.map((h: { id: string }) => h.id)).toEqual(HARNESS_IDS);

    // Repository discovery scanned only the two expected roots.
    const norm = (p: string) => p.replace(/\\/g, '/');
    const dirs = vi
      .mocked(fs.readdirSync)
      .mock.calls.map((args) => norm(String(args[0])))
      .sort();
    expect(dirs).toEqual([norm(REPO_ROOT), norm(path.dirname(REPO_ROOT))].sort());

    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it('rejects unknown bridge commands', async () => {
    await expect(handleBridgeCommand('orch_nope_missing', {})).rejects.toThrow(
      'Unknown command',
    );
  });

  it('extracts ONLY clean assistant response text from JSONL streams (never raw JSONL)', () => {
    const vibeJsonl = [
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Secret handoff prompt' }] }),
      JSON.stringify({ type: 'effect', id: 'eff-1', title: 'file_system.read_file' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Clean assistant answer from Vibe.' }] }),
    ].join('\n');

    const vibeOut = extractCleanRunOutput('vibe', vibeJsonl);
    expect(vibeOut.cleanText).toBe('Clean assistant answer from Vibe.');
    expect(vibeOut.cleanText).not.toContain('{"type"');
    expect(vibeOut.cleanText).not.toContain('Secret handoff prompt');
    expect(vibeOut.toolCalls).toHaveLength(1);
    expect(vibeOut.toolCalls[0].title).toBe('file_system.read_file');

    const museJsonl = [
      JSON.stringify({ schema_version: 1, payload_type: 'run.model.configured', payload: { model_id: 'muse-spark-1.3' } }),
      JSON.stringify({ schema_version: 1, payload_type: 'run.output.delta', payload: { text: 'Hello ' } }),
      JSON.stringify({ schema_version: 1, payload_type: 'run.terminal.completed', payload: { text: 'Hello from Muse cleanly.' } }),
    ].join('\n');

    const museOut = extractCleanRunOutput('muse', museJsonl);
    expect(museOut.cleanText).toBe('Hello from Muse cleanly.');
    expect(museOut.verifiedModel).toBe('muse-spark-1.3');
  });
});
