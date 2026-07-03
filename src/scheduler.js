const cron = require('node-cron');
const { openDb, getSetting, setSetting } = require('./db');
const { getConfig } = require('./config');
const { computeNextRun, toIso } = require('./utils/time');

function createScheduledJob({ name, goal, schedule, plan, permissions = {}, outputStyle = 'concise', enabled = true }) {
  const timezone = schedule.timezone || getSetting('timezone', getConfig().defaultTimezone);
  schedule.timezone = timezone;
  const nextRunAt = schedule.nextRunAt || computeNextRun(schedule, new Date(), timezone);
  const result = openDb().prepare(`
    INSERT INTO scheduled_jobs (name, goal, schedule_json, plan_json, permissions_json, output_style, enabled, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, goal, JSON.stringify(schedule), JSON.stringify(plan), JSON.stringify(permissions), outputStyle, enabled ? 1 : 0, nextRunAt);
  return result.lastInsertRowid;
}

function listScheduledJobs() {
  return openDb().prepare('SELECT * FROM scheduled_jobs ORDER BY enabled DESC, next_run_at ASC, id ASC').all();
}

function seedDefaultJobs() {
  const config = getConfig();
  const setupEnabled = getSetting('enable_default_jobs', config.enableDefaultJobs);
  if (!setupEnabled || getSetting('default_jobs_seeded', false)) return;
  const defaults = [
    {
      name: 'Morning builder trends',
      goal: 'Send a short practical trend digest from GitHub Trending, HN, Reddit, Product Hunt, and Dev.to focused on lessons for improving my repos.',
      schedule: { type: 'daily', hour: 6, minute: 0, timezone: getSetting('timezone', config.defaultTimezone) },
      plan: { kind: 'trend_digest' },
    },
    {
      name: 'Morning GitHub profile update',
      goal: 'Update low-risk factual bot-controlled profile sections and suggest larger public presence improvements.',
      schedule: { type: 'daily', hour: 6, minute: 30, timezone: getSetting('timezone', config.defaultTimezone) },
      plan: { kind: 'profile_update' },
      permissions: { autoApplyLowRiskOnly: true },
    },
    {
      name: 'Nightly work summary',
      goal: 'Summarize what I did today on GitHub and list practical ways to make my projects more useful or popular.',
      schedule: { type: 'daily', hour: 22, minute: 30, timezone: getSetting('timezone', config.defaultTimezone) },
      plan: { kind: 'daily_summary' },
    },
    {
      name: 'Midnight GitHub stats',
      goal: 'Report GitHub stars, forks, traffic where available, and popularity changes using stored snapshots.',
      schedule: { type: 'daily', hour: 0, minute: 0, timezone: getSetting('timezone', config.defaultTimezone) },
      plan: { kind: 'stats_report' },
    },
  ];
  defaults.forEach(job => createScheduledJob(job));
  setSetting('default_jobs_seeded', true);
}

function startScheduler(bot, executor) {
  seedDefaultJobs();
  // Catch up immediately on startup. Because each job's next_run_at is persisted
  // in the database, a device that was asleep or off delivers whatever it missed
  // as soon as it comes back online — the "first time the device is opened the
  // new day" case — instead of waiting for the next minute tick or losing the
  // run entirely. Each missed occurrence collapses to a single catch-up run,
  // then reschedules forward.
  runDueJobs(bot, executor).catch(err => console.error('[Scheduler] startup catch-up failed:', err.message));
  cron.schedule('* * * * *', () => {
    runDueJobs(bot, executor).catch(err => console.error('[Scheduler] run failed:', err.message));
  });
}

async function runDueJobs(bot, executor, now = new Date()) {
  const due = openDb().prepare(`
    SELECT * FROM scheduled_jobs
    WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
    ORDER BY next_run_at ASC
    LIMIT 10
  `).all(toIso(now));
  for (const job of due) {
    // Isolate each job: a failure in one due job must not stop the others from
    // running this tick. runJob already records the error against the job_run.
    try {
      await runJob(job, bot, executor, now);
    } catch (err) {
      console.error(`[Scheduler] job #${job.id} failed:`, err.message);
    }
  }
}

async function runJob(job, bot, executor, now = new Date()) {
  const run = openDb().prepare('INSERT INTO job_runs (job_id, status, message) VALUES (?, ?, ?)').run(job.id, 'running', '');
  try {
    await executor(job, bot);
    const schedule = JSON.parse(job.schedule_json);
    const nextRunAt = schedule.type === 'once' ? null : computeNextRun(schedule, now, schedule.timezone);
    openDb().prepare('UPDATE scheduled_jobs SET last_run_at = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toIso(now), nextRunAt, job.id);
    openDb().prepare('UPDATE job_runs SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?').run('ok', run.lastInsertRowid);
  } catch (err) {
    openDb().prepare('UPDATE job_runs SET status = ?, message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?').run('error', err.message, run.lastInsertRowid);
    const schedule = JSON.parse(job.schedule_json);
    const nextRunAt = schedule.type === 'once' ? null : computeNextRun(schedule, now, schedule.timezone);
    openDb().prepare('UPDATE scheduled_jobs SET last_run_at = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toIso(now), nextRunAt, job.id);
    throw err;
  }
}

module.exports = {
  createScheduledJob,
  listScheduledJobs,
  seedDefaultJobs,
  startScheduler,
  runDueJobs,
  runJob,
};
