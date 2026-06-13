const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFlexibleSchedule, computeNextRun } = require('../src/utils/time');

test('parses interval schedules', () => {
  const schedule = parseFlexibleSchedule('every 97 minutes tell me stars', 'UTC', new Date('2026-06-13T00:00:00Z'));
  assert.equal(schedule.type, 'interval');
  assert.equal(schedule.everyMinutes, 97);
});

test('parses weekly schedules', () => {
  const schedule = parseFlexibleSchedule('every Monday at 9 compare stars', 'UTC', new Date('2026-06-13T00:00:00Z'));
  assert.equal(schedule.type, 'weekly');
  assert.equal(schedule.dayOfWeek, 1);
  assert.equal(schedule.hour, 9);
});

test('parses compound interval schedules', () => {
  const schedule = parseFlexibleSchedule('every 1 hour and 37 minutes check stars', 'UTC', new Date('2026-06-13T00:00:00Z'));
  assert.equal(schedule.type, 'interval');
  assert.equal(schedule.everyMinutes, 97);
});

test('parses one-time month schedules', () => {
  const schedule = parseFlexibleSchedule('on June 21 at 4:37 PM tell me stats', 'Asia/Hong_Kong', new Date('2026-06-13T00:00:00Z'));
  assert.equal(schedule.type, 'once');
  assert.ok(schedule.runAt.includes('2026-06-21T08:37:00.000Z'));
});

test('parses casual one-time month schedules', () => {
  const schedule = parseFlexibleSchedule('remind me June 21, 4 PM 37 minute', 'Asia/Hong_Kong', new Date('2026-06-13T00:00:00Z'));
  assert.equal(schedule.type, 'once');
  assert.ok(schedule.runAt.includes('2026-06-21T08:37:00.000Z'));
});

test('parses next weekday and weekly variants', () => {
  const once = parseFlexibleSchedule('next Friday afternoon check issues', 'UTC', new Date('2026-06-13T00:00:00Z'));
  assert.equal(once.type, 'once');
  assert.ok(once.runAt.includes('2026-06-19T14:00:00.000Z'));

  const weekly = parseFlexibleSchedule('every week Monday at 10 check stars', 'UTC', new Date('2026-06-13T00:00:00Z'));
  assert.equal(weekly.type, 'weekly');
  assert.equal(weekly.dayOfWeek, 1);
  assert.equal(weekly.hour, 10);
});

test('computes daily next run in the future', () => {
  const next = computeNextRun({ type: 'daily', hour: 6, minute: 30, timezone: 'Asia/Hong_Kong' }, new Date('2026-06-11T07:00:00Z'));
  assert.ok(new Date(next) > new Date('2026-06-11T07:00:00Z'));
});
