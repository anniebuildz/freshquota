# Fresh Your Quota

Optimize your Claude Code 5-hour rolling window quota by automatically triggering the window at the best time — even while your Mac is asleep.

## How it works

Claude Code subscribers have a usage quota that resets every 5 hours from first use. If you start using Claude at 9 AM, your quota resets at 2 PM. But if you could trigger that window at 7 AM (before you wake up), the reset would happen at noon — right in the middle of your productive hours.

**freshquota** analyzes your usage patterns, finds the optimal trigger time, and wakes your Mac to activate the window automatically.

## Requirements

- macOS (uses launchd + pmset for scheduling)
- Node.js >= 18
- Claude Code CLI installed and authenticated
- sudo access (one-time, for pmset wake scheduling)

## Install

```bash
npm install -g freshquota
```

## Usage

### 1. Analyze your usage patterns

```bash
freshquota analyze
```

Shows your hourly usage distribution and recommends an anchor time. Confirm to save.

To set manually:

```bash
freshquota analyze --anchor 07:30
```

### 2. Activate scheduling

```bash
freshquota install
```

Registers the launchd job and schedules the first pmset wake. Requires sudo for pmset.

### 3. Check status

```bash
freshquota status
```

### 4. Manual trigger

```bash
freshquota trigger
```

### 5. Health check

```bash
freshquota doctor
```

Verifies the scheduling chain is intact and repairs if needed.

### 6. Uninstall

```bash
freshquota uninstall
```

## How scheduling works

1. `pmset schedule wake` wakes your Mac at the anchor time (works with lid closed)
2. `launchd` detects the wake and runs `freshquota run`
3. The tool checks if the window is already active — if so, skips
4. Otherwise, sends a minimal Claude CLI request to activate the window
5. Schedules tomorrow's pmset wake
6. Mac goes back to sleep

## License

MIT
