const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFlexibleSchedule, computeNextRun } = require('../src/utils/time');

test('parses interval schedules', () => {
  const schedule = parseFlexibleSchedule('every 97 minutes tell me stars');
  assert.equal(schedule.type, 'interval');
  assert.equal(schedule.everyMinutes, 97);
});

test('parses weekly schedules', () => {
  const schedule = parseFlexibleSchedule('every Monday at 9 compare stars');
  assert.equal(schedule.type, 'weekly');
  assert.equal(schedule.dayOfWeek, 1);
  assert.equal(schedule.hour, 9);
});

test('computes daily next run in the future', () => {
  const next = computeNextRun({ type: 'daily', hour: 6, minute: 30 }, new Date('2026-06-11T07:00:00Z'));
  assert.ok(new Date(next) > new Date('2026-06-11T07:00:00Z'));
});
