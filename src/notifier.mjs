import { execSync } from 'node:child_process';

export function sendNotification(title, message) {
  try {
    const escaped = message.replace(/"/g, '\\"');
    execSync(
      `osascript -e 'display notification "${escaped}" with title "${title}"'`,
      { stdio: 'ignore' }
    );
  } catch {
    // notification is best-effort, don't crash
  }
}

export function notifyTriggerResult(result, resetAt) {
  if (result === 'triggered') {
    sendNotification('FreshQuota', `Claude Code window activated. Resets at ${resetAt}.`);
  } else if (result === 'skipped') {
    sendNotification('FreshQuota', 'Window already active, trigger skipped.');
  } else if (result === 'error') {
    sendNotification('FreshQuota', 'Trigger failed. Run freshquota status for details.');
  }
}
