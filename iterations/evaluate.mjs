/**
 * Brute-force evaluator for anchor algorithm.
 *
 * For each test case:
 * 1. Enumerate all possible trigger times (every 15 min in gaps)
 * 2. Simulate the window chain from each trigger
 * 3. Score each by how many resets fall during dense usage
 * 4. Compare algorithm output to brute-force optimal
 */

import { findOptimalAnchor, simulateWindowChain } from '../src/analyzer.mjs';

// --- Test Cases ---

const CASES = [
  {
    name: "Case 1: Single peak 09-17, gap 18-08",
    //       0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23
    dist:   [0, 0, 0, 0, 0, 0, 0, 0, 5,12,18,20,20,18,15,12, 8, 5, 0, 0, 0, 0, 0, 0],
    desc: "Classic workday. Gap 18:00-08:00. Peak at 11-12. Optimal trigger should place a reset around 11-13.",
  },
  {
    name: "Case 2: Real user — heavy 13-02, sporadic 08-12",
    dist:   [126,114,54,17, 0, 0, 0, 0, 9, 1, 2, 9,24,93,117,109,178,91,79,94,100,116,191,159],
    desc: "Densest at 22:00. Gap ~03:00-08:00 (only 5h). Sporadic morning use complicates gap detection.",
  },
  {
    name: "Case 3: Two peaks 09-12 + 20-23",
    dist:   [0, 0, 0, 0, 0, 0, 0, 0, 5,15,20,18, 8, 2, 0, 0, 0, 0, 0, 5,18,22,15, 3],
    desc: "Two distinct peaks with gap 13-19. Should optimize for the larger peak (evening).",
  },
  {
    name: "Case 4: Near-uniform usage",
    dist:   [8, 7, 6, 5, 4, 3, 3, 4, 8, 9,10,10,10,10, 9, 9, 8, 8, 7, 7, 8, 8, 9, 8],
    desc: "No clear gap. Algorithm should either find the small dip at 04-07 or report no viable anchor.",
  },
  {
    name: "Case 5: Midnight-wrapping peak 22-04",
    dist:   [20,18,15,12, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 5,18,25],
    desc: "Peak wraps midnight. Gap 05-20. Should handle circular distribution correctly.",
  },
  {
    name: "Case 6: Case 2 perturbed (+1 event at h8)",
    dist:   [126,114,54,17, 0, 0, 0, 0,10, 1, 2, 9,24,93,117,109,178,91,79,94,100,116,191,159],
    desc: "Adversarial: h8 goes from 9 to 10. Should NOT cause total failure. Gap should still be found.",
  },
  {
    name: "Case 7: Barely 5h gap with non-zero edges",
    dist:   [0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 2, 15,20,25,20,15,10, 5, 0, 0, 0],
    desc: "Gap has non-zero values at edges (h8=3, h13=2). Should still detect gap and avoid bleed.",
  },
  {
    name: "Case 8: All usage in one hour",
    dist:   [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    desc: "Extreme concentration. 23h gap. Trigger should place reset right at h12.",
  },
  {
    name: "Case 9: Tight 5h gap with moderate lead-in",
    dist:   [25,18,12, 0, 0, 0, 0, 0,30,40,45,50,45,40,35,30,25,20,18,20,22,25,28,27],
    desc: "Adversarial: h2=12 could cause bleed into gap. Should NOT return null.",
  },
  {
    name: "Case 10: Two gaps, one is a trap",
    dist:   [20,15,10, 0, 0, 0, 0, 0,25,30,35,30,25,20,15, 2, 1, 8, 1, 2,15,25,30,25],
    desc: "Adversarial: bimodal with messy second gap. First gap (h3-h7) should work.",
  },
];

// --- Brute Force Optimal Finder ---

function simulateWindows(triggerHour, dist) {
  // Simulate window chain starting from trigger.
  // Returns array of reset times and a score.
  const windows = [];
  let t = triggerHour;

  // Simulate 24 hours of windows from trigger point
  for (let i = 0; i < 4; i++) { // max 4 windows in 24h
    const resetAt = (t + 5) % 24;

    // Score: how much usage happens in the hour of the reset (user benefits from reset during heavy use)
    // Better metric: sum of usage in the 2 hours after reset (fresh quota utilization)
    let freshQuotaUsage = 0;
    for (let h = 0; h < 3; h++) {
      freshQuotaUsage += dist[(resetAt + h) % 24];
    }

    windows.push({ start: t, resetAt, freshQuotaUsage });
    t = resetAt;
  }

  // Total score: sum of usage that benefits from fresh quota after each reset
  const totalScore = windows.reduce((s, w) => s + w.freshQuotaUsage, 0);
  return { windows, totalScore };
}

function bruteForceOptimal(dist) {
  // True brute-force: try every 15-min slot across all 24 hours.
  // A slot is "valid" if the 5 hours before it have low cumulative usage
  // (bottom 30% of the distribution's hourly average).
  const total = dist.reduce((a, b) => a + b, 0);
  if (total === 0) return { anchor: null, score: 0 };

  const mean = total / 24;
  const lowThreshold = mean * 0.3; // per-hour threshold for "quiet"

  let bestAnchor = null;
  let bestScore = -1;

  for (let h = 0; h < 24; h += 0.25) {
    // Check if preceding 5 hours are quiet enough for window to have expired
    let quietCount = 0;
    for (let b = 1; b <= 5; b++) {
      const checkH = (Math.floor(h) - b + 24) % 24;
      if (dist[checkH] <= lowThreshold) quietCount++;
    }
    // Need at least 3 of 5 preceding hours to be quiet
    if (quietCount < 3) continue;

    const result = simulateWindows(h, dist);
    if (result.totalScore > bestScore) {
      bestScore = result.totalScore;
      bestAnchor = h;
    }
  }

  if (bestAnchor === null) return { anchor: null, score: 0 };
  return { anchor: bestAnchor, score: bestScore };
}

// --- Run Evaluation ---

export function evaluate() {
  const results = [];

  for (const testCase of CASES) {
    const bf = bruteForceOptimal(testCase.dist);

    let algoResult;
    try {
      algoResult = findOptimalAnchor(testCase.dist);
    } catch (e) {
      algoResult = { anchor: null, error: e.message };
    }

    const algoAnchorNum = algoResult?.anchor
      ? parseFloat(algoResult.anchor.split(':')[0]) + parseFloat(algoResult.anchor.split(':')[1]) / 60
      : null;

    // Score the algo's answer using BOTH models for comparison
    let algoScore = 0;
    let algoChainScore = 0;
    if (algoAnchorNum !== null) {
      algoScore = simulateWindows(algoAnchorNum, testCase.dist).totalScore;
      algoChainScore = simulateWindowChain(algoAnchorNum, testCase.dist).totalScore;
    }

    const optimalityRatio = bf.score > 0 ? algoScore / bf.score : (algoAnchorNum === null && bf.anchor === null ? 1 : 0);

    // Also compute brute-force score using the algo's chain model
    let bfChainScore = 0;
    if (bf.anchor !== null) {
      bfChainScore = simulateWindowChain(bf.anchor, testCase.dist).totalScore;
    }

    results.push({
      name: testCase.name,
      desc: testCase.desc,
      bruteForce: { anchor: bf.anchor !== null ? formatH(bf.anchor) : 'none', score: bf.score, chainScore: bfChainScore },
      algorithm: { anchor: algoResult?.anchor || 'none', score: algoScore, chainScore: algoChainScore, details: algoResult },
      optimalityRatio,
      chainOptimalityRatio: bfChainScore > 0 ? algoChainScore / bfChainScore : (algoChainScore > 0 ? 1 : (algoScore === 0 && bf.score === 0 ? 1 : 0)),
    });
  }

  return results;
}

function formatH(h) {
  const hours = Math.floor(h);
  const mins = Math.round((h - hours) * 60);
  return `${String(hours).padStart(2,'0')}:${String(mins).padStart(2,'0')}`;
}

// Run if called directly
const results = evaluate();
console.log('\n=== Evaluation Results ===\n');
for (const r of results) {
  const pct = (r.optimalityRatio * 100).toFixed(0);
  const chainPct = (r.chainOptimalityRatio * 100).toFixed(0);
  const match = r.chainOptimalityRatio >= 0.9 ? 'GOOD' : r.chainOptimalityRatio >= 0.7 ? 'OK' : 'POOR';
  console.log(`${r.name}`);
  console.log(`  Brute-force: anchor=${r.bruteForce.anchor}, simple=${r.bruteForce.score}, chain=${r.bruteForce.chainScore.toFixed(0)}`);
  console.log(`  Algorithm:   anchor=${r.algorithm.anchor}, simple=${r.algorithm.score}, chain=${r.algorithm.chainScore.toFixed(0)}`);
  console.log(`  Optimality: simple=${pct}%, chain=${chainPct}% [${match}]`);
  console.log(`  ${r.desc}`);
  console.log();
}
