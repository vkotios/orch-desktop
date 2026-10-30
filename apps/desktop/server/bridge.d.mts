export interface DiscoveredHarness {
  id: string;
  label: string;
  provider: string;
  transport: string;
  defaultModel: string;
  suggestedModels: string[];
  roles: string[];
  envStripped: string[];
  installed: boolean;
  executablePath: string | null;
  authHint: string;
}

export interface DiscoveredRepository {
  path: string;
  name: string;
  branch: string;
  adopted: boolean;
}

export const REPO_ROOT: string;

export function discoverHarnesses(): DiscoveredHarness[];
export function discoverRepositories(): DiscoveredRepository[];
export function getOrchDashboard(): Promise<Record<string, any>>;

export function extractCleanRunOutput(
  cli: string,
  stdoutText: string,
  stderrText?: string,
  runDir?: string | null
): {
  cleanText: string;
  toolCalls: Array<{ id: string; title: string; detail: string; status: string }>;
  thoughts: string[];
  verifiedModel: string | null;
};

export function handleBridgeCommand(
  cmd: string,
  args?: Record<string, any>
): Promise<any>;

export function createBridgeServer(): import('node:http').Server;
