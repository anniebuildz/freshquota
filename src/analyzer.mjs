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
  const result = findOptimalAnchor(distribution);
  if (!result) return null;
  return { start: 0, end: 23, midpoint: 12, ...result };
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

/**
 * Find the quietest continuous window of at least minHours.
 * Uses adaptive threshold with graceful degradation.
 * Accounts for window bleed: a call at hour H keeps the window active until H+5.
 *
 * Returns array of { start, end, length, totalUsage }.
 */
export function findGaps(distribution, minHours = 5) {
  const max = Math.max(...distribution);
  const total = distribution.reduce((a, b) => a + b, 0);
  if (max === 0 || total === 0) return [];

  // Adaptive: try progressively relaxed thresholds until we find a gap
  const thresholds = [0.02, 0.05, 0.10, 0.15, 0.25];

  for (const pct of thresholds) {
    const threshold = max * pct;
    const gaps = findGapsAtThreshold(distribution, threshold, minHours);
    if (gaps.length > 0) return gaps;
  }

  // Fallback: find the least-active sliding window of minHours
  return [findQuietestWindow(distribution, minHours)];
}

function findGapsAtThreshold(distribution, threshold, minHours) {
  const ext = [...distribution, ...distribution];
  const gaps = [];

  let gapStart = -1;
  for (let h = 0; h < 48; h++) {
    if (ext[h] <= threshold) {
      if (gapStart === -1) gapStart = h;
    } else {
      if (gapStart !== -1 && (h - gapStart) >= minHours) {
        gaps.push({
          start: gapStart % 24,
          end: (h - 1) % 24,
          length: h - gapStart,
          totalUsage: sumRange(distribution, gapStart % 24, (h - 1) % 24),
        });
      }
      gapStart = -1;
    }
  }
  if (gapStart !== -1 && (48 - gapStart) >= minHours) {
    gaps.push({
      start: gapStart % 24,
      end: 47 % 24,
      length: 48 - gapStart,
      totalUsage: sumRange(distribution, gapStart % 24, 47 % 24),
    });
  }

  // Deduplicate and keep only the best (least usage) if overlapping
  const seen = new Set();
  return gaps.filter(g => {
    const key = `${g.start}-${g.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findQuietestWindow(distribution, windowSize) {
  let bestStart = 0;
  let bestSum = Infinity;
  for (let s = 0; s < 24; s++) {
    let sum = 0;
    for (let h = 0; h < windowSize; h++) {
      sum += distribution[(s + h) % 24];
    }
    if (sum < bestSum) {
      bestSum = sum;
      bestStart = s;
    }
  }
  return {
    start: bestStart,
    end: (bestStart + windowSize - 1) % 24,
    length: windowSize,
    totalUsage: bestSum,
  };
}

function sumRange(distribution, start, end) {
  let sum = 0;
  if (end >= start) {
    for (let h = start; h <= end; h++) sum += distribution[h];
  } else {
    for (let h = start; h < 24; h++) sum += distribution[h];
    for (let h = 0; h <= end; h++) sum += distribution[h];
  }
  return sum;
}

/**
 * Simulate realistic window chain from a trigger time.
 * - Probability-weighted: resets only count if user is likely active
 * - First window scored modestly (trigger is a ping during a gap)
 * - No arbitrary diminishing weights (activityProb already models chain uncertainty)
 */
export function simulateWindowChain(triggerHour, distribution) {
  const total = distribution.reduce((a, b) => a + b, 0);
  if (total === 0) return { resets: [], totalScore: 0 };

  const mean = total / 24;
  let t = triggerHour;
  let totalScore = 0;
  const resets = [];

  // Score the first window (trigger to trigger+5h)
  let firstWindowUsage = 0;
  for (let h = 0; h < 5; h++) {
    firstWindowUsage += distribution[(Math.floor(t) + h) % 24];
  }
  totalScore += firstWindowUsage * 0.3;

  // Independent probability model: each reset scored by its OWN activity
  // probability, not the product of all prior resets. This avoids the
  // "chain death" problem where one low-activity intermediate hour zeros
  // all subsequent resets.
  for (let i = 0; i < 4; i++) {
    const resetAt = (t + 5) % 24;
    const resetHour = Math.floor(resetAt) % 24;

    const activityProb = Math.min(1, distribution[resetHour] / mean);

    let freshUsage = 0;
    for (let h = 0; h < 5; h++) {
      freshUsage += distribution[(resetHour + h) % 24];
    }

    totalScore += activityProb * freshUsage;
    resets.push(resetAt);
    t = resetAt;
  }

  return { resets, totalScore };
}

/**
 * Find the optimal anchor time.
 *
 * For each candidate trigger time within detected gaps:
 * 1. Account for window bleed: trigger must be >= 5h after the last active hour
 *    before the gap (to ensure the window from that activity has expired)
 * 2. Simulate realistic window chain with probability-weighted scoring
 * 3. Return the best trigger time
 */
export function findOptimalAnchor(distribution) {
  const total = distribution.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  if (isDistributionFlat(distribution)) return null;

  const gaps = findGaps(distribution);
  if (gaps.length === 0) return null;

  let bestAnchor = null;
  let bestScore = -1;
  let bestResets = [];

  const mean = total / 24;
  const days = 14; // must match filterRecent's default

  for (const gap of gaps) {
    const gapEnd = gap.end < gap.start ? gap.end + 24 : gap.end;

    for (let h = gap.start; ; h += 0.25) {
      const hNorm = h % 24;
      const triggerHour = Math.floor(hNorm) % 24;

      // Bleed zone: check 4 hours before (not 5 — window from h-5 expires at h)
      // Poisson model: P(window still active from hour H) = 1 - e^(-events/days)
      // Distance-weighted: closer activity contributes more to bleed risk
      let bleedPenalty = 0;
      for (let b = 1; b <= 4; b++) {
        const checkHour = (triggerHour - b + 24) % 24;
        const pWindowActive = 1 - Math.exp(-distribution[checkHour] / days);
        const distanceWeight = (4 - b) / 3; // 1.0 for b=1, 0.33 for b=3, 0 for b=4
        bleedPenalty += distanceWeight * pWindowActive;
      }

      // Organic collision: probability user already uses Claude at this hour
      // P(no organic use) ≈ e^(-events/days) (Poisson model)
      const eventsAtHour = distribution[triggerHour];
      const pTriggerUseful = Math.exp(-eventsAtHour / days);

      // Skip if bleed penalty is very high (almost certainly in active window)
      if (bleedPenalty > 0.5) {
        if (h >= gapEnd) break;
        continue;
      }

      const result = simulateWindowChain(hNorm, distribution);

      // Effective score: chain value * P(trigger is useful) * (1 - bleedPenalty)
      const effectiveScore = result.totalScore * pTriggerUseful * (1 - bleedPenalty);

      if (effectiveScore > bestScore) {
        bestScore = effectiveScore;
        bestAnchor = hNorm;
        bestResets = result.resets;
      }

      if (h >= gapEnd) break;
    }
  }

  if (bestAnchor === null) return null;

  return {
    anchor: formatAnchor(bestAnchor),
    score: bestScore,
    resets: bestResets.map(r => formatAnchor(r)),
    gaps: gaps,
  };
}

export function formatAnchor(decimalHours) {
  const h = Math.floor(decimalHours);
  const m = Math.round((decimalHours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
