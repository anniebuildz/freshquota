import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseHistory, filterRecent, buildDistribution, findOptimalAnchor, computeAnchor, isDistributionFlat, formatAnchor } from '../src/analyzer.mjs';

describe('parseHistory', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'timeslot-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses JSONL entries', () => {
    const filePath = join(tempDir, 'history.jsonl');
    const lines = [
      JSON.stringify({ display: 'hello', timestamp: 1000000, sessionId: 'a' }),
      JSON.stringify({ display: 'world', timestamp: 2000000, sessionId: 'b' }),
    ];
    writeFileSync(filePath, lines.join('\n') + '\n');

    const entries = parseHistory(filePath);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].timestamp, 1000000);
    assert.equal(entries[1].display, 'world');
  });

  it('returns empty array for nonexistent file', () => {
    const entries = parseHistory(join(tempDir, 'nope.jsonl'));
    assert.deepEqual(entries, []);
  });

  it('skips malformed lines', () => {
    const filePath = join(tempDir, 'history.jsonl');
    writeFileSync(filePath, '{"timestamp":1000}\nBAD LINE\n{"timestamp":2000}\n');

    const entries = parseHistory(filePath);
    assert.equal(entries.length, 2);
  });
});

describe('filterRecent', () => {
  it('keeps entries within the last N days', () => {
    const now = Date.now();
    const entries = [
      { timestamp: now - 2 * 86400000 },  // 2 days ago
      { timestamp: now - 10 * 86400000 }, // 10 days ago
      { timestamp: now - 20 * 86400000 }, // 20 days ago
    ];
    const recent = filterRecent(entries, 14);
    assert.equal(recent.length, 2);
  });

  it('returns empty for no recent entries', () => {
    const entries = [{ timestamp: 0 }]; // epoch
    const recent = filterRecent(entries, 14);
    assert.equal(recent.length, 0);
  });
});

describe('buildDistribution', () => {
  it('buckets entries by local hour', () => {
    // Create entries at known hours in local timezone
    const makeEntry = (hour) => {
      const d = new Date();
      d.setHours(hour, 30, 0, 0);
      return { timestamp: d.getTime() };
    };

    const entries = [
      makeEntry(9), makeEntry(9), makeEntry(9),
      makeEntry(10), makeEntry(10),
      makeEntry(14),
    ];

    const dist = buildDistribution(entries);
    assert.equal(dist[9], 3);
    assert.equal(dist[10], 2);
    assert.equal(dist[14], 1);
    assert.equal(dist[0], 0);
    assert.equal(dist.length, 24);
  });

  it('returns all zeros for empty input', () => {
    const dist = buildDistribution([]);
    assert.equal(dist.length, 24);
    assert.equal(dist.reduce((a, b) => a + b, 0), 0);
  });
});

describe('findOptimalAnchor', () => {
  it('finds anchor for single peak distribution', () => {
    const dist = [0, 0, 0, 0, 0, 0, 0, 2, 5, 12,18,15,14,10, 8, 6, 3, 1, 0, 0, 0, 0, 0, 0];
    const result = findOptimalAnchor(dist);
    assert.ok(result);
    assert.ok(result.anchor); // should return a valid HH:MM string
    const anchorH = parseInt(result.anchor.split(':')[0]);
    // Anchor should be in the gap (18:00-08:00)
    assert.ok(anchorH >= 18 || anchorH <= 7, `anchor ${result.anchor} outside expected gap`);
  });

  it('finds anchor for two-peak distribution', () => {
    const dist = [0, 0, 0, 0, 0, 0, 0, 0, 10,15,12, 0, 0, 0, 0, 0, 0, 0, 0, 3, 5, 4, 0, 0];
    const result = findOptimalAnchor(dist);
    assert.ok(result);
    assert.ok(result.anchor);
  });

  it('returns null for all-zero distribution', () => {
    const dist = new Array(24).fill(0);
    assert.equal(findOptimalAnchor(dist), null);
  });

  it('returns null for flat distribution', () => {
    const dist = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
    assert.equal(findOptimalAnchor(dist), null);
  });
});

describe('computeAnchor', () => {
  it('subtracts 5 hours from midpoint', () => {
    assert.equal(computeAnchor(13), 8);     // 13:00 - 5h = 08:00
    assert.equal(computeAnchor(12.5), 7.5); // 12:30 - 5h = 07:30
  });

  it('wraps around midnight', () => {
    assert.equal(computeAnchor(3), 22);     // 03:00 - 5h = 22:00 previous day
  });
});

describe('isDistributionFlat', () => {
  it('returns true when no hour is 2x the average', () => {
    const dist = [4, 5, 4, 5, 4, 5, 4, 5, 4, 5, 4, 5, 4, 5, 4, 5, 4, 5, 4, 5, 4, 5, 4, 5];
    assert.equal(isDistributionFlat(dist), true);
  });

  it('returns false when a clear peak exists', () => {
    const dist = [0, 0, 0, 0, 0, 0, 0, 0, 5, 20, 18, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    assert.equal(isDistributionFlat(dist), false);
  });

  it('returns true for all zeros', () => {
    assert.equal(isDistributionFlat(new Array(24).fill(0)), true);
  });
});

describe('formatAnchor', () => {
  it('formats decimal hours as HH:MM', () => {
    assert.equal(formatAnchor(8), '08:00');
    assert.equal(formatAnchor(7.5), '07:30');
    assert.equal(formatAnchor(22.75), '22:45');
    assert.equal(formatAnchor(0), '00:00');
  });
});
