import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  discoverHarnesses,
  discoverRepositories,
  extractCleanRunOutput,
  handleBridgeCommand,
} from '../server/bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

describe('CHO Desktop Host Bridge', () => {
  it('discovers all 8 harnesses including agy and grok with orchestrator/chat roles and stripped API env vars', () => {
    const harnesses = discoverHarnesses();
    expect(harnesses.map((h) => h.id)).toEqual([
      'claude',
      'codex',
      'agy',
      'grok',
      'muse',
      'copilot',
      'vibe',
      'opencode',
    ]);

    const agy = harnesses.find((h) => h.id === 'agy');
    expect(agy).toBeDefined();
    expect(agy?.roles).toContain('chat');
    expect(agy?.roles).toContain('controller');
    expect(agy?.suggestedModels).toContain('gemini-4-argon-high');

    const grok = harnesses.find((h) => h.id === 'grok');
    expect(grok).toBeDefined();
    expect(grok?.envStripped).toContain('XAI_API_KEY');
    expect(grok?.envStripped).toContain('GROK_API_KEY');
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

  it('loads the orch coordinator dashboard and local repositories', async () => {
    const repos = discoverRepositories();
    expect(repos.some((r) => r.name === 'CHO-desktop')).toBe(true);

    const dashboard = await handleBridgeCommand('orch_dashboard', {});
    expect(dashboard.repoRoot).toBe(repoRoot);
    expect(Array.isArray(dashboard.repositories)).toBe(true);
    expect(Array.isArray(dashboard.runs)).toBe(true);
    expect(Array.isArray(dashboard.roster)).toBe(true);
  });
});
