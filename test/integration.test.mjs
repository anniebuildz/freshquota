import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseHistory, filterRecent, buildDistribution,
  findOptimalAnchor, formatAnchor,
} from '../src/analyzer.mjs';
import { isWindowActive } from '../src/trigger.mjs';
import { readState, writeState } from '../src/state.mjs';
import { buildPlist, computeNextWake } from '../src/scheduler.mjs';

describe('end-to-end: analyze → schedule → trigger check', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'timeslot-e2e-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('full flow from history to plist', () => {
    // 1. Generate realistic history data
    const historyPath = join(tempDir, 'history.jsonl');
    const entries = [];
    const now = Date.now();
    for (let day = 0; day < 14; day++) {
      // Simulate peak at 9-16 with most activity 10-13
      for (const hour of [9, 10, 10, 10, 11, 11, 11, 12, 12, 13, 14, 15]) {
        const ts = now - day * 86400000;
        const d = new Date(ts);
        d.setHours(hour, Math.floor(Math.random() * 60), 0, 0);
        entries.push({ display: 'test', timestamp: d.getTime(), sessionId: 'x' });
      }
    }
    writeFileSync(historyPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    // 2. Analyze
    const parsed = parseHistory(historyPath);
    const recent = filterRecent(parsed, 14);
    const dist = buildDistribution(recent);
    const result = findOptimalAnchor(dist);

    assert.ok(result);
    assert.ok(result.anchor);

    // Anchor should be in the gap (16:00-08:00 range)
    const anchor = result.anchor;
    const anchorHour = parseInt(anchor.split(':')[0]);
    assert.ok(anchorHour >= 16 || anchorHour <= 8, `anchor ${anchor} outside expected gap`);

    // 4. Save state
    const statePath = join(tempDir, 'state.json');
    writeState(statePath, { anchor, distribution: dist, analyzedAt: new Date().toISOString() });
    const state = readState(statePath);
    assert.equal(state.anchor, anchor);

    // 5. Generate plist
    const plist = buildPlist(anchor, '/usr/local/bin/timeslot', join(tempDir, 'logs'),
      '/usr/local/bin/node', '/usr/local/bin/claude');
    assert.ok(plist.includes(String(anchorHour)));

    // 6. Window check
    const oldHistoryPath = join(tempDir, 'old_history.jsonl');
    writeFileSync(oldHistoryPath, JSON.stringify({ timestamp: now - 7 * 3600000 }) + '\n');
    assert.equal(isWindowActive(oldHistoryPath), false);

    const recentHistoryPath = join(tempDir, 'recent_history.jsonl');
    writeFileSync(recentHistoryPath, JSON.stringify({ timestamp: now - 3600000 }) + '\n');
    assert.equal(isWindowActive(recentHistoryPath), true);
  });
});
