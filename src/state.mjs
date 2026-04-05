import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_STATE = {
  anchor: null,
  lastTrigger: null,
  lastResult: null,
  lastSkipReason: null,
  windowResetAt: null,
  analyzedAt: null,
  distribution: null,
  lastError: null,
};

export function defaultStatePath() {
  return join(homedir(), '.freshquota', 'state.json');
}

export function readState(filePath) {
  if (!existsSync(filePath)) return { ...DEFAULT_STATE };
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeState(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n');
}
