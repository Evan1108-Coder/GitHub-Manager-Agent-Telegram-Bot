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
  const match = String(value).match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\b/);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2] || 0) };
}

function nextDailyRun(hour, minute, from = new Date()) {
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}

function nextIntervalRun(minutes, from = new Date()) {
  return addMinutes(from, minutes);
}

function nextWeeklyRun(dayOfWeek, hour, minute, from = new Date()) {
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  const diff = (dayOfWeek - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + diff);
  if (next <= from) next.setDate(next.getDate() + 7);
  return next;
}

function parseFlexibleSchedule(text) {
  const raw = String(text || '').toLowerCase();
  const interval = raw.match(/\bevery\s+(\d+)\s*(minute|minutes|min|hour|hours|day|days)\b/);
  if (interval) {
    const amount = Number(interval[1]);
    const unit = interval[2];
    const minutes = unit.startsWith('hour') ? amount * 60 : unit.startsWith('day') ? amount * 1440 : amount;
    return { type: 'interval', everyMinutes: minutes, nextRunAt: toIso(nextIntervalRun(minutes)) };
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
      return { type: 'weekly', dayOfWeek: index, hour: time.hour, minute: time.minute, nextRunAt: toIso(nextWeeklyRun(index, time.hour, time.minute)) };
    }
  }

  if (raw.includes('every day') || raw.includes('daily') || raw.includes('every morning') || raw.includes('every night')) {
    const time = parseTimeOfDay(raw) || (raw.includes('morning') ? { hour: 9, minute: 0 } : { hour: 22, minute: 0 });
    return { type: 'daily', hour: time.hour, minute: time.minute, nextRunAt: toIso(nextDailyRun(time.hour, time.minute)) };
  }

  return null;
}

function computeNextRun(schedule, from = new Date()) {
  if (!schedule) return null;
  if (schedule.type === 'interval') return toIso(nextIntervalRun(schedule.everyMinutes, from));
  if (schedule.type === 'daily') return toIso(nextDailyRun(schedule.hour, schedule.minute, from));
  if (schedule.type === 'weekly') return toIso(nextWeeklyRun(schedule.dayOfWeek, schedule.hour, schedule.minute, from));
  if (schedule.type === 'once') return schedule.runAt || null;
  return null;
}

module.exports = {
  nowIso,
  addMinutes,
  toIso,
  formatLocal,
  parseFlexibleSchedule,
  computeNextRun,
};
