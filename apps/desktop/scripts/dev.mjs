// Unified dev launcher for CHO-desktop: starts the Node 24 host bridge and Vite dev server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');

const bridge = spawn(process.execPath, [path.join(desktopDir, 'server', 'bridge.mjs')], {
  cwd: desktopDir,
  stdio: 'inherit',
  windowsHide: true,
});

const localViteBin = path.join(desktopDir, 'node_modules', 'vite', 'bin', 'vite.js');
const rootViteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const viteBin = fs.existsSync(localViteBin) ? localViteBin : rootViteBin;

const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', '1420', '--strictPort'], {
  cwd: desktopDir,
  stdio: 'inherit',
  windowsHide: true,
});

const cleanup = () => {
  try { bridge.kill(); } catch { /* ignore */ }
  try { vite.kill(); } catch { /* ignore */ }
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
