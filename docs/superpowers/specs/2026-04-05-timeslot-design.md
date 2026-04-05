# Timeslot - Claude Code Rolling Window Optimizer

**Date:** 2026-04-05
**Status:** Draft

## Problem

Claude Code subscribers have a 5-hour rolling window quota. The window starts on first API use and resets 5 hours later. If the reset falls outside your working hours, you get one full quota during peak usage. If the reset falls in the middle of your peak, you effectively get a quota refresh when you need it most.

Currently there is no tool that:
1. Automatically analyzes your usage patterns to find the optimal window anchor point
2. Triggers the window while your machine is asleep (lid closed) so the reset lands during peak hours
3. Checks whether the window is already active before triggering

## Solution

A local CLI tool (`timeslot`) that:
1. Analyzes your Claude Code usage history to determine when you work most intensely
2. Calculates the optimal time to pre-trigger the 5-hour window so the reset falls mid-peak
3. Uses macOS `pmset schedule wake` to wake the machine at that time (even with lid closed)
4. Uses macOS `launchd` to execute a minimal Claude CLI call that activates the window
5. Self-chains: each execution registers the next day's wake + launchd schedule

## Scope

- **In scope:** Claude Code only (single provider)
- **Out of scope for v1:** Codex support, multi-provider, cross-platform (Linux/Windows)
- **Future:** Codex support can be added later by extending the analyzer and trigger modules

## Architecture

Four modules, single data flow, no persistent daemon:

```
Analyzer → Scheduler → Trigger → Notifier
   ↑                                  ↓
   └──── State Store (JSON) ──────────┘
```

Each execution is a short-lived process: trigger, register next schedule, exit. No daemon, no Login Item.

### Module Responsibilities

**Analyzer** (`src/analyzer.mjs`)
- Reads `~/.claude/history.jsonl`
- Takes the most recent 14 days of data (configurable)
- Aggregates by hour (24 buckets) in the user's local timezone
- Finds the most concentrated continuous usage period (any duration)
- Computes: midpoint of that period - 5 hours = anchor time
- If distribution is too flat (peak hour < 2x average), prompts user to set anchor manually

**Scheduler** (`src/scheduler.mjs`)
- Writes launchd plist to `~/Library/LaunchAgents/com.timeslot.trigger.plist`
- Plist uses `StartCalendarInterval` targeting tomorrow's anchor time, with `RunAtLoad: true` as safety net
- Calls `sudo pmset schedule wake` for anchor time minus 2 minutes (startup margin)
- Each execution generates and registers the next day's schedule (self-chaining)

**Trigger** (`src/trigger.mjs`)
- Step 1: Read last entry in `~/.claude/history.jsonl` — if timestamp is within last 5 hours, window is already active, skip and log reason, proceed to register next day
- Step 2: Wait up to 30 seconds for network connectivity (WiFi may not be connected immediately after wake). Skip on timeout.
- Step 3: Execute `claude -p --output-format stream-json --no-session-persistence --tools "" --no-chrome "Reply with exactly OK."`
- Timeout: 180 seconds max for CLI execution
- On success or skip: call Scheduler to register next day
- On failure: log error, still register next day (don't break the chain)

**Notifier** (`src/notifier.mjs`)
- macOS system notification via `osascript`: "Claude Code window activated, resets at HH:MM"
- Updates `~/.timeslot/state.json` with trigger result

**State Store** (`src/state.mjs`)
- Reads/writes `~/.timeslot/state.json`
- Schema:

```json
{
  "anchor": "08:00",
  "lastTrigger": "2026-04-05T08:00:12+08:00",
  "lastResult": "triggered",
  "lastSkipReason": null,
  "windowResetAt": "2026-04-05T13:00:12+08:00",
  "analyzedAt": "2026-04-04T22:30:00+08:00",
  "distribution": [0, 0, 0, 0, 0, 0, 0, 2, 5, 12, 18, 15, 14, 10, 8, 6, 3, 1, 0, 0, 0, 0, 0, 0],
  "lastError": null
}
```

## CLI Commands

```
timeslot analyze      Analyze usage patterns, show results, confirm and save anchor
timeslot install      Register launchd + first pmset wake (requires sudo)
timeslot uninstall    Remove launchd plist, cancel pmset schedules, delete state
timeslot status       Show current window state, next trigger time, last trigger result
timeslot trigger      Manual immediate trigger (skips time check, still checks window active)
timeslot doctor       Verify launchd plist exists, pmset schedule registered, chain intact — fix if broken
```

### `timeslot analyze` Flow

1. Read `~/.claude/history.jsonl`, filter to last 14 days
2. Convert timestamps to local timezone, bucket by hour
3. Find most concentrated continuous usage period
4. Calculate anchor = midpoint - 5 hours
5. Display to user:
   ```
   Usage distribution (last 14 days):
   06:00  ▏
   07:00  ██
   08:00  █████
   09:00  ████████████
   10:00  ██████████████████
   11:00  ███████████████
   ...

   Peak usage: 09:00 - 16:00
   Optimal reset point: 12:30
   Recommended anchor: 07:30

   Use this anchor? (y/n)
   ```
6. On confirm, write to state.json

### `timeslot install` Flow

1. Check state.json has an anchor (if not, prompt to run `analyze` first)
2. Write launchd plist to `~/Library/LaunchAgents/`
3. `launchctl bootstrap gui/<uid> <plist path>`
4. `sudo pmset schedule wake <tomorrow anchor - 2min>`
5. Confirm success

## Error Handling

**Network not ready after wake:** Wait up to 30 seconds with 1-second polling for connectivity (ping or DNS check). Skip trigger on timeout, log reason, still register next day.

**Claude CLI not found or fails:** Log error to state.json `lastError` field. `timeslot status` surfaces it. Don't break the chain — always register next day's schedule.

**pmset permission lost:** `timeslot doctor` detects missing pmset schedule and prompts user to re-run `timeslot install`.

**launchd chain broken:** If plist is missing or unloaded, `timeslot doctor` regenerates and re-registers it.

**Insufficient history data:** `timeslot analyze` requires at least 3 days of data. If less, suggests manual anchor or waiting.

**Timezone change:** Anchor "08:00" is always interpreted in the system's current local timezone. If user travels, the trigger time shifts with the local clock automatically.

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Node.js (v18+) | Claude Code users have it; ESM modules; built-in parseArgs |
| Dependencies | Zero npm deps | Simpler install, smaller attack surface, follows optimize-ai-limits pattern |
| Module format | ESM (.mjs) | Modern, tree-shakable, top-level await |
| Scheduling | launchd + pmset | Only way to execute during lid-closed sleep on macOS |
| Architecture | Self-chaining one-shot | No daemon, no Login Item, each run schedules the next |
| Data source | ~/.claude/history.jsonl | Millisecond timestamps, one record per interaction, sufficient for hourly analysis |
| Trigger command | claude -p --no-session-persistence --tools "" --no-chrome | Minimal footprint, no side effects, borrowed from optimize-ai-limits |
| State location | ~/.timeslot/ | Separate from Claude's own state, won't conflict |
| Distribution | npm global install | Natural for Node.js CLI tools targeting developers |

## Project Structure

```
timeslot/
├── src/
│   ├── cli.mjs           # Entry point, command routing (node:util parseArgs)
│   ├── analyzer.mjs      # Read history.jsonl, compute distribution and anchor
│   ├── trigger.mjs       # Execute Claude CLI trigger + window activation check
│   ├── scheduler.mjs     # pmset wake + launchd plist generation and registration
│   ├── notifier.mjs      # macOS system notification + state update
│   └── state.mjs         # ~/.timeslot/state.json read/write
├── bin/
│   └── timeslot.mjs      # #!/usr/bin/env node shim
├── package.json
├── LICENSE
└── README.md
```

## Competitive Landscape

| Tool | Approach | Our Advantage |
|------|----------|---------------|
| claude-warmup (110 stars) | GitHub Actions cron, manual time config | We auto-analyze patterns; we work offline with pmset |
| optimize-ai-limits (4 stars) | launchd self-chain, manual config | We auto-analyze patterns; we use pmset for lid-closed wake |
| ccusage (12K stars) | Usage analytics only | We act on the data, not just display it |

## Open Questions

None. Design is complete and approved through iterative discussion.
