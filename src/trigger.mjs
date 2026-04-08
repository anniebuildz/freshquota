import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { promises as dns } from 'node:dns';

const WINDOW_HOURS = 5;
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;

export function isWindowActive(historyPath) {
  if (!existsSync(historyPath)) return false;
  const content = readFileSync(historyPath, 'utf-8').trim();
  if (!content) return false;

  const lines = content.split('\n');
  const lastLine = lines[lines.length - 1];
  try {
    const entry = JSON.parse(lastLine);
    return (Date.now() - entry.timestamp) < WINDOW_MS;
  } catch {
    return false;
  }
}

export function alreadyTriggeredToday(state) {
  if (!state.lastTrigger) return false;
  const last = new Date(state.lastTrigger);
  const now = new Date();
  return last.toDateString() === now.toDateString();
}

async function checkNetwork() {
  try {
    await dns.lookup('api.anthropic.com');
    return true;
  } catch {
    return false;
  }
}

export async function waitForNetwork(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkNetwork()) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

export function executeClaude() {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p',
      '--model', 'haiku',
      '--no-session-persistence',
      '--tools', '',
      '--no-chrome',
      'Reply with exactly OK.',
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`claude exited with code ${code}: ${stderr}`));
    });

    child.on('error', reject);
  });
}
