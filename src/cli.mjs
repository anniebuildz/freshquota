import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';
import { readState, writeState, defaultStatePath } from './state.mjs';
import {
  parseHistory, filterRecent, buildDistribution,
  findOptimalAnchor, isDistributionFlat,
  formatAnchor, defaultHistoryPath,
} from './analyzer.mjs';
import { isWindowActive, alreadyTriggeredToday, waitForNetwork, executeClaude } from './trigger.mjs';
import {
  buildPlist, registerLaunchd, schedulePmsetWake,
  unregisterLaunchd, cancelPmsetSchedules, plistPath, computeNextWake,
} from './scheduler.mjs';
import { notifyTriggerResult } from './notifier.mjs';

const statePath = defaultStatePath();

function printUsage() {
  console.log(`Usage: freshquota <command>

Commands:
  analyze     Analyze usage patterns and set anchor time
  install     Register launchd + pmset (requires sudo for pmset)
  uninstall   Remove all schedules and state
  status      Show current state and next trigger time
  trigger     Manually trigger now (checks window first)
  doctor      Verify scheduling chain is intact
  run         Internal: called by launchd (not for manual use)`);
}

function printDistribution(dist) {
  const max = Math.max(...dist);
  if (max === 0) return;
  for (let h = 0; h < 24; h++) {
    const bar = max > 0 ? '\u2588'.repeat(Math.round((dist[h] / max) * 30)) : '';
    const label = `${String(h).padStart(2, '0')}:00`;
    const count = String(dist[h]).padStart(4);
    console.log(`  ${label} ${count} ${bar}`);
  }
}

async function cmdAnalyze() {
  const historyPath = defaultHistoryPath();
  if (!existsSync(historyPath)) {
    console.error('No history file found at', historyPath);
    console.error('Use Claude Code for a few days first, then re-run.');
    process.exit(1);
  }

  const entries = parseHistory(historyPath);
  const recent = filterRecent(entries, 14);

  if (recent.length < 20) {
    console.error(`Only ${recent.length} entries in last 14 days. Need at least 20 for reliable analysis.`);
    console.error('Use Claude Code more, or set anchor manually: freshquota analyze --anchor HH:MM');
    process.exit(1);
  }

  const dist = buildDistribution(recent);

  console.log('\nUsage distribution (last 14 days):\n');
  printDistribution(dist);

  const result = findOptimalAnchor(dist);
  if (!result) {
    console.log('\nNo clear usage pattern detected. Set anchor manually:');
    console.log('  freshquota analyze --anchor HH:MM');
    process.exit(1);
  }

  const anchor = result.anchor;

  console.log(`\nGap detected: ${String(result.gaps[0].start).padStart(2, '0')}:00 - ${String(result.gaps[0].end).padStart(2, '0')}:00 (${result.gaps[0].length}h)`);
  console.log(`Recommended anchor: ${anchor}`);
  console.log(`Window resets at: ${result.resets.join(', ')}`);
  console.log(`\nThis means the tool will trigger Claude Code at ${anchor} daily,`);
  console.log(`so your quota refreshes at ${result.resets.slice(0, 3).join(', ')} during your peak.\n`);

  const state = readState(statePath);
  state.anchor = anchor;
  state.distribution = dist;
  state.analyzedAt = new Date().toISOString();
  writeState(statePath, state);
  console.log(`Anchor saved: ${anchor}`);
  console.log('Run "freshquota install" to activate scheduling.');
}

async function cmdInstall() {
  const state = readState(statePath);
  if (!state.anchor) {
    console.error('No anchor set. Run "freshquota analyze" first.');
    process.exit(1);
  }

  const scriptPath = resolve(process.argv[1]);
  const stateDir = resolve(defaultStatePath(), '..');
  const logDir = join(stateDir, 'logs');
  mkdirSync(logDir, { recursive: true });

  const nodePath = process.execPath;
  let claudePath = null;
  try {
    claudePath = execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch { /* claude not on PATH — will rely on node dir only */ }

  const plist = buildPlist(state.anchor, scriptPath, logDir, nodePath, claudePath);
  registerLaunchd(plist);
  console.log('launchd registered.');

  const wake = schedulePmsetWake(state.anchor);
  console.log(`pmset wake scheduled: ${wake.toLocaleString()}`);
  console.log('\nTimeslot is active. Run "freshquota status" to verify.');
}

async function cmdUninstall() {
  unregisterLaunchd();
  cancelPmsetSchedules();

  const stateDir = resolve(defaultStatePath(), '..');
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch { /* ignore */ }

  console.log('Timeslot uninstalled. All schedules and state removed.');
}

async function cmdStatus() {
  const state = readState(statePath);

  if (!state.anchor) {
    console.log('Not configured. Run "freshquota analyze" to get started.');
    return;
  }

  console.log(`Anchor: ${state.anchor}`);
  console.log(`Analyzed: ${state.analyzedAt || 'never'}`);
  console.log(`Last trigger: ${state.lastTrigger || 'never'}`);
  console.log(`Last result: ${state.lastResult || 'n/a'}`);
  if (state.lastSkipReason) console.log(`Skip reason: ${state.lastSkipReason}`);
  if (state.lastError) console.log(`Last error: ${state.lastError}`);
  if (state.windowResetAt) console.log(`Window resets at: ${state.windowResetAt}`);

  const nextWake = computeNextWake(state.anchor);
  console.log(`Next wake: ${nextWake.toLocaleString()}`);

  const plist = plistPath();
  console.log(`launchd plist: ${existsSync(plist) ? 'OK' : 'MISSING'}`);
}

async function cmdTrigger() {
  const historyPath = defaultHistoryPath();

  if (isWindowActive(historyPath)) {
    console.log('Window is already active. Skipping.');
    return;
  }

  console.log('Checking network...');
  const network = await waitForNetwork(30000);
  if (!network) {
    console.error('Network not available after 30s. Aborting.');
    process.exit(1);
  }

  console.log('Triggering Claude Code...');
  try {
    await executeClaude();
    const resetAt = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const state = readState(statePath);
    state.lastTrigger = new Date().toISOString();
    state.lastResult = 'triggered';
    state.lastSkipReason = null;
    state.lastError = null;
    state.windowResetAt = resetAt.toISOString();
    writeState(statePath, state);

    const resetTime = `${String(resetAt.getHours()).padStart(2, '0')}:${String(resetAt.getMinutes()).padStart(2, '0')}`;
    console.log(`Window activated. Resets at ${resetTime}.`);
    notifyTriggerResult('triggered', resetTime);
  } catch (err) {
    const state = readState(statePath);
    state.lastResult = 'error';
    state.lastError = err.message;
    writeState(statePath, state);

    console.error('Trigger failed:', err.message);
    notifyTriggerResult('error', null);
  }
}

async function cmdRun() {
  // Called by launchd. Guard against spurious RunAtLoad triggers.
  const state = readState(statePath);

  if (!state.anchor) {
    process.exit(0);
  }

  if (alreadyTriggeredToday(state)) {
    process.exit(0);
  }

  const historyPath = defaultHistoryPath();

  if (isWindowActive(historyPath)) {
    state.lastResult = 'skipped';
    state.lastSkipReason = 'window already active';
    state.lastTrigger = new Date().toISOString();
    writeState(statePath, state);
    notifyTriggerResult('skipped', null);
  } else {
    const network = await waitForNetwork(30000);
    if (!network) {
      state.lastResult = 'error';
      state.lastError = 'network unavailable after 30s';
      writeState(statePath, state);
      notifyTriggerResult('error', null);
    } else {
      try {
        await executeClaude();
        const resetAt = new Date(Date.now() + 5 * 60 * 60 * 1000);
        state.lastTrigger = new Date().toISOString();
        state.lastResult = 'triggered';
        state.lastSkipReason = null;
        state.lastError = null;
        state.windowResetAt = resetAt.toISOString();
        writeState(statePath, state);

        const resetTime = `${String(resetAt.getHours()).padStart(2, '0')}:${String(resetAt.getMinutes()).padStart(2, '0')}`;
        notifyTriggerResult('triggered', resetTime);
      } catch (err) {
        state.lastResult = 'error';
        state.lastError = err.message;
        writeState(statePath, state);
        notifyTriggerResult('error', null);
      }
    }
  }

  // Always schedule next day's pmset wake to keep the chain alive
  try {
    schedulePmsetWake(state.anchor);
  } catch {
    // pmset may fail if sudo isn't cached — non-fatal
  }
}

async function cmdDoctor() {
  const state = readState(statePath);
  let healthy = true;

  if (!state.anchor) {
    console.log('[FAIL] No anchor configured. Run "freshquota analyze".');
    process.exit(1);
  }
  console.log(`[OK] Anchor: ${state.anchor}`);

  const plist = plistPath();
  if (existsSync(plist)) {
    console.log('[OK] launchd plist exists');
  } else {
    console.log('[FAIL] launchd plist missing. Run "freshquota install" to fix.');
    healthy = false;
  }

  try {
    const output = execSync('pmset -g sched', { encoding: 'utf-8' });
    if (output.includes('wake')) {
      console.log('[OK] pmset wake schedule found');
    } else {
      console.log('[WARN] No pmset wake schedule. Run "freshquota install" to fix.');
      healthy = false;
    }
  } catch {
    console.log('[WARN] Could not check pmset schedule');
    healthy = false;
  }

  if (state.lastError) {
    console.log(`[WARN] Last trigger had error: ${state.lastError}`);
  }

  console.log(healthy ? '\nAll checks passed.' : '\nIssues found. Run "freshquota install" to repair.');
}

export async function run(args) {
  const command = args[0];

  // Handle --anchor flag for analyze
  if (command === 'analyze' && args.includes('--anchor')) {
    const idx = args.indexOf('--anchor');
    const anchor = args[idx + 1];
    if (!anchor || !/^\d{2}:\d{2}$/.test(anchor)) {
      console.error('Invalid anchor format. Use HH:MM (e.g., 08:00)');
      process.exit(1);
    }
    const state = readState(statePath);
    state.anchor = anchor;
    state.analyzedAt = new Date().toISOString();
    writeState(statePath, state);
    console.log(`Anchor set manually: ${anchor}`);
    console.log('Run "freshquota install" to activate scheduling.');
    return;
  }

  switch (command) {
    case 'analyze':   return cmdAnalyze();
    case 'install':   return cmdInstall();
    case 'uninstall': return cmdUninstall();
    case 'status':    return cmdStatus();
    case 'trigger':   return cmdTrigger();
    case 'doctor':    return cmdDoctor();
    case 'run':       return cmdRun();
    default:          printUsage();
  }
}
