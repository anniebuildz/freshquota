import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlist, computeNextWake } from '../src/scheduler.mjs';

describe('buildPlist', () => {
  it('generates valid plist XML with correct anchor time', () => {
    const plist = buildPlist('08:30', '/usr/local/bin/freshquota', '/tmp/logs');
    assert.ok(plist.includes('<integer>8</integer>'));   // Hour
    assert.ok(plist.includes('<integer>30</integer>'));   // Minute
    assert.ok(plist.includes('com.freshquota.trigger'));
    assert.ok(plist.includes('/usr/local/bin/freshquota'));
    assert.ok(plist.includes('<true/>'));                 // RunAtLoad
    assert.ok(plist.includes('/tmp/logs'));
  });

  it('handles midnight anchor', () => {
    const plist = buildPlist('00:00', '/usr/local/bin/freshquota', '/tmp/logs');
    assert.ok(plist.includes('<integer>0</integer>'));
  });
});

describe('computeNextWake', () => {
  it('returns tomorrow if anchor already passed today', () => {
    const now = new Date('2026-04-05T10:00:00');
    const wake = computeNextWake('08:00', now);
    assert.equal(wake.getFullYear(), 2026);
    assert.equal(wake.getMonth(), 3); // April = 3
    assert.equal(wake.getDate(), 6);
    assert.equal(wake.getHours(), 7);
    assert.equal(wake.getMinutes(), 58); // anchor - 2 min
  });

  it('returns today if anchor has not passed', () => {
    const now = new Date('2026-04-05T06:00:00');
    const wake = computeNextWake('08:00', now);
    assert.equal(wake.getDate(), 5);
    assert.equal(wake.getHours(), 7);
    assert.equal(wake.getMinutes(), 58);
  });
});
