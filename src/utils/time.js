function nowIso() {
  return new Date().toISOString();
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function toIso(date) {
  return date instanceof Date ? date.toISOString() : new Date(date).toISOString();
}

function formatLocal(date, timezone = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(date));
}

function parseTimeOfDay(value) {
  const match = String(value).match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function getZonedParts(date, timezone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  if (map.hour === 24) map.hour = 0;
  return map;
}

function zonedTimeToUtc(year, month, day, hour, minute, timezone = 'UTC') {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  for (let i = 0; i < 4; i++) {
    const parts = getZonedParts(guess, timezone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    const wanted = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const diff = actual - wanted;
    if (diff === 0) break;
    guess = new Date(guess.getTime() - diff);
  }
  return guess;
}

function addDaysToYmd(year, month, day, days) {
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function nextDailyRun(hour, minute, from = new Date(), timezone = 'UTC') {
  const parts = getZonedParts(from, timezone);
  let next = zonedTimeToUtc(parts.year, parts.month, parts.day, hour, minute, timezone);
  if (next <= from) {
    const tomorrow = addDaysToYmd(parts.year, parts.month, parts.day, 1);
    next = zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, timezone);
  }
  return next;
}

function nextIntervalRun(minutes, from = new Date()) {
  return addMinutes(from, minutes);
}

function nextWeeklyRun(dayOfWeek, hour, minute, from = new Date(), timezone = 'UTC') {
  const parts = getZonedParts(from, timezone);
  const currentDow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0)).getUTCDay();
  let diff = (dayOfWeek - currentDow + 7) % 7;
  let target = addDaysToYmd(parts.year, parts.month, parts.day, diff);
  let next = zonedTimeToUtc(target.year, target.month, target.day, hour, minute, timezone);
  if (next <= from) {
    target = addDaysToYmd(parts.year, parts.month, parts.day, diff + 7);
    next = zonedTimeToUtc(target.year, target.month, target.day, hour, minute, timezone);
  }
  return next;
}

function parseFlexibleSchedule(text, timezone = 'UTC', from = new Date()) {
  const raw = String(text || '').toLowerCase();
  const once = parseOneTimeSchedule(raw, timezone, from);
  if (once) return once;

  const compoundInterval = raw.match(/\bevery\s+(\d+)\s*(hour|hours|hr|hrs)\s*(?:and)?\s+(\d+)\s*(minute|minutes|min|mins)\b/);
  if (compoundInterval) {
    const minutes = Number(compoundInterval[1]) * 60 + Number(compoundInterval[3]);
    return { type: 'interval', everyMinutes: minutes, timezone, nextRunAt: toIso(nextIntervalRun(minutes, from)) };
  }

  const interval = raw.match(/\bevery\s+(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days)\b/);
  if (interval) {
    const amount = Number(interval[1]);
    const unit = interval[2];
    const minutes = unit.startsWith('hour') || unit.startsWith('hr') ? amount * 60 : unit.startsWith('day') ? amount * 1440 : amount;
    return { type: 'interval', everyMinutes: minutes, timezone, nextRunAt: toIso(nextIntervalRun(minutes, from)) };
  }

  const days = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  for (const [name, index] of Object.entries(days)) {
    if (raw.includes(`every ${name}`) || raw.includes(`each ${name}`)) {
      const time = parseTimeOfDay(raw) || { hour: 9, minute: 0 };
      return { type: 'weekly', dayOfWeek: index, hour: time.hour, minute: time.minute, timezone, nextRunAt: toIso(nextWeeklyRun(index, time.hour, time.minute, from, timezone)) };
    }
  }

  if (raw.includes('every day') || raw.includes('daily') || raw.includes('every morning') || raw.includes('every night')) {
    const time = parseTimeOfDay(raw) || (raw.includes('morning') ? { hour: 9, minute: 0 } : { hour: 22, minute: 0 });
    return { type: 'daily', hour: time.hour, minute: time.minute, timezone, nextRunAt: toIso(nextDailyRun(time.hour, time.minute, from, timezone)) };
  }

  return null;
}

function parseOneTimeSchedule(raw, timezone, from) {
  const inMatch = raw.match(/\bin\s+(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days)\b/);
  if (inMatch) {
    const amount = Number(inMatch[1]);
    const unit = inMatch[2];
    const minutes = unit.startsWith('hour') || unit.startsWith('hr') ? amount * 60 : unit.startsWith('day') ? amount * 1440 : amount;
    return { type: 'once', timezone, runAt: toIso(addMinutes(from, minutes)) };
  }

  const months = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
    may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
    september: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  };
  const monthNames = Object.keys(months).join('|');
  const match = raw.match(new RegExp(`\\b(?:on\\s+)?(${monthNames})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?(?:\\s+(?:at\\s+)?)?([01]?\\d|2[0-3])(?::([0-5]\\d))?\\s*(am|pm)?\\b`, 'i'));
  if (!match) return null;
  const nowParts = getZonedParts(from, timezone);
  const month = months[match[1].toLowerCase()];
  const day = Number(match[2]);
  let year = match[3] ? Number(match[3]) : nowParts.year;
  let hour = Number(match[4]);
  const minute = Number(match[5] || 0);
  const meridiem = match[6]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  let runAt = zonedTimeToUtc(year, month, day, hour, minute, timezone);
  if (!match[3] && runAt <= from) runAt = zonedTimeToUtc(year + 1, month, day, hour, minute, timezone);
  return { type: 'once', timezone, runAt: toIso(runAt) };
}

function computeNextRun(schedule, from = new Date(), timezone = schedule?.timezone || 'UTC') {
  if (!schedule) return null;
  if (schedule.type === 'interval') return toIso(nextIntervalRun(schedule.everyMinutes, from));
  if (schedule.type === 'daily') return toIso(nextDailyRun(schedule.hour, schedule.minute, from, timezone));
  if (schedule.type === 'weekly') return toIso(nextWeeklyRun(schedule.dayOfWeek, schedule.hour, schedule.minute, from, timezone));
  if (schedule.type === 'once') return schedule.runAt || null;
  return null;
}

function shiftSchedule(schedule, offsetMinutes) {
  const timezone = schedule.timezone || 'UTC';
  if (schedule.type === 'daily') {
    let total = schedule.hour * 60 + schedule.minute + offsetMinutes;
    total = ((total % 1440) + 1440) % 1440;
    return { ...schedule, hour: Math.floor(total / 60), minute: total % 60, timezone };
  }
  if (schedule.type === 'weekly') {
    let total = schedule.hour * 60 + schedule.minute + offsetMinutes;
    let dayShift = Math.floor(total / 1440);
    total = ((total % 1440) + 1440) % 1440;
    if (offsetMinutes < 0 && schedule.hour * 60 + schedule.minute + offsetMinutes < 0) dayShift = -1;
    return {
      ...schedule,
      dayOfWeek: ((schedule.dayOfWeek + dayShift) % 7 + 7) % 7,
      hour: Math.floor(total / 60),
      minute: total % 60,
      timezone,
    };
  }
  if (schedule.type === 'interval') {
    return {
      ...schedule,
      timezone,
      nextRunAt: schedule.nextRunAt ? toIso(addMinutes(new Date(schedule.nextRunAt), offsetMinutes)) : undefined,
    };
  }
  if (schedule.type === 'once') {
    return { ...schedule, timezone, runAt: toIso(addMinutes(new Date(schedule.runAt), offsetMinutes)) };
  }
  return schedule;
}

module.exports = {
  nowIso,
  addMinutes,
  toIso,
  formatLocal,
  getZonedParts,
  zonedTimeToUtc,
  parseFlexibleSchedule,
  computeNextRun,
  shiftSchedule,
};
