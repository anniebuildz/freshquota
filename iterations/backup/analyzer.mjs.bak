import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function defaultHistoryPath() {
  return join(homedir(), '.claude', 'history.jsonl');
}

export function parseHistory(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];
  const entries = [];
  for (const line of content.split('\n')) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

export function filterRecent(entries, days = 14) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return entries.filter(e => e.timestamp > cutoff);
}

export function buildDistribution(entries) {
  const hours = new Array(24).fill(0);
  for (const entry of entries) {
    const hour = new Date(entry.timestamp).getHours();
    hours[hour]++;
  }
  return hours;
}

export function findPeakPeriod(distribution) {
  const total = distribution.reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const mean = total / 24;

  // Find continuous runs of above-average hours
  let bestRun = null;
  let current = null;

  for (let h = 0; h < 24; h++) {
    if (distribution[h] > mean) {
      if (!current) current = { start: h, end: h, total: 0 };
      current.end = h;
      current.total += distribution[h];
    } else {
      if (current && (!bestRun || current.total > bestRun.total)) {
        bestRun = { ...current };
      }
      current = null;
    }
  }
  if (current && (!bestRun || current.total > bestRun.total)) {
    bestRun = { ...current };
  }

  if (!bestRun) return null;

  // Weighted midpoint within the peak
  let weightedSum = 0;
  let weightTotal = 0;
  for (let h = bestRun.start; h <= bestRun.end; h++) {
    weightedSum += h * distribution[h];
    weightTotal += distribution[h];
  }
  bestRun.midpoint = weightedSum / weightTotal;

  return bestRun;
}

export function computeAnchor(midpoint) {
  let anchor = midpoint - 5;
  if (anchor < 0) anchor += 24;
  return anchor;
}

export function isDistributionFlat(distribution) {
  const total = distribution.reduce((a, b) => a + b, 0);
  if (total === 0) return true;
  const mean = total / 24;
  const max = Math.max(...distribution);
  return max < mean * 2;
}

export function formatAnchor(decimalHours) {
  const h = Math.floor(decimalHours);
  const m = Math.round((decimalHours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
