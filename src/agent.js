const { InlineKeyboard } = require('grammy');
const { getConfig } = require('./config');
const { addConversation, getConversation, getSetting, setSetting, openDb } = require('./db');
const { GitHubClient } = require('./github/client');
const { auditRepoPresentation } = require('./github/audit');
const { chat, chooseDefaultModel, getAvailableModels } = require('./llm/providers');
const { createScheduledJob, listScheduledJobs } = require('./scheduler');
const { parseFlexibleSchedule, shiftSchedule } = require('./utils/time');
const { escapeHtml, sendLong, oneLine } = require('./utils/format');
const { delayedProgress, withTyping, friendlyError } = require('./utils/ux');
const { renderRepoCard, renderJob, renderAudit } = require('./renderers');
const { buildTrendDigest, buildStatsReport, buildDailySummary, runProfileUpdate, auditOneRepo } = require('./jobs');

async function handleText(ctx, text, context = {}) {
  const chatId = String(ctx.chat.id);
  addConversation(chatId, 'user', text);
  const normalized = text.trim();

  if (isThanksOrAck(normalized)) {
    return reply(ctx, '👍 Got it.');
  }

  const timezone = getSetting('timezone', getConfig().defaultTimezone);
  const schedule = parseFlexibleSchedule(normalized, timezone);
  if (schedule && /remind|tell|check|compare|summarize|update|audit|watch|monitor|every|daily|weekly/i.test(normalized)) {
    const prefetch = extractPrefetchRequest(normalized);
    const plan = { kind: 'natural_request', goal: normalized, context };
    if (prefetch) {
      plan.prefetchOffsetMinutes = prefetch.minutes;
      plan.prefetchMetric = prefetch.metric;
      plan.prefetchRepos = extractRepoNames(normalized, getSetting('github_username', getConfig().githubUsername));
    }
    const id = createScheduledJob({
      name: inferJobName(normalized),
      goal: normalized,
      schedule,
      plan,
      permissions: { source: 'user_request', approvalRequiredForWrites: true },
      outputStyle: 'concise',
    });
    let helperText = '';
    if (prefetch && plan.prefetchRepos.length) {
      const helperSchedule = shiftSchedule(schedule, -prefetch.minutes);
      const helperId = createScheduledJob({
        name: `Prefetch for job #${id}`,
        goal: `Capture ${prefetch.metric} ${prefetch.minutes} minutes before job #${id}`,
        schedule: helperSchedule,
        plan: {
          kind: 'snapshot_metric',
          metric: prefetch.metric,
          repos: plan.prefetchRepos,
          relatedJobId: id,
          offsetMinutes: prefetch.minutes,
        },
        permissions: { readOnly: true, helperFor: id },
        outputStyle: 'silent',
      });
      helperText = ` I also created helper job #${helperId} to capture ${prefetch.metric} ${prefetch.minutes} minutes earlier.`;
    }
    return reply(ctx, `✅ <b>Scheduled.</b>\nJob #${id} will run ${escapeHtml(describeSchedule(schedule))}.${helperText}\n\nYou can change or pause it later by talking naturally.`);
  }

  const jobAction = parseJobAction(normalized);
  if (jobAction) return updateJobState(ctx, jobAction);

  if (/^(jobs|show jobs|list jobs|\/jobs)$/i.test(normalized)) {
    return showJobs(ctx);
  }

  if (/^(models|show models|\/models)$/i.test(normalized)) {
    return showModels(ctx);
  }

  if (/status|config|setup/i.test(normalized)) {
    return showStatus(ctx);
  }

  if (/trend|builder trend|morning trend/i.test(normalized)) {
    await reply(ctx, '🧭 <b>Got it.</b> Fetching trend sources and compressing them into a short builder digest…');
    return withFriendlyFailure(ctx, () => withTyping(ctx, async () => sendLong(ctx, await buildTrendDigest())));
  }

  if (/daily summary|what did i do|summarize today|today on github/i.test(normalized)) {
    await reply(ctx, '📌 <b>I’m checking today’s GitHub activity now…</b>');
    return withFriendlyFailure(ctx, () => withTyping(ctx, async () => sendLong(ctx, await buildDailySummary())));
  }

  if (/stats|stars|popularity|views|forks/i.test(normalized) && !/audit|readme/i.test(normalized)) {
    await reply(ctx, '📊 <b>I’m checking GitHub stats and stored snapshots…</b>');
    return withFriendlyFailure(ctx, () => withTyping(ctx, async () => sendLong(ctx, await buildStatsReport())));
  }

  if (/profile.*update|update.*profile|profile readme/i.test(normalized)) {
    await reply(ctx, '🛠️ <b>I’ll check your profile README.</b>\nI’ll only auto-apply low-risk controlled updates if enabled.');
    return withFriendlyFailure(ctx, () => withTyping(ctx, async () => sendLong(ctx, await runProfileUpdate())));
  }

  const repoToAudit = extractRepoFromAudit(normalized);
  if (repoToAudit) {
    await reply(ctx, `🔎 <b>Auditing ${escapeHtml(repoToAudit)}</b>\nChecking README, docs, description, and presentation issues…`);
    return withFriendlyFailure(ctx, () => withTyping(ctx, async () => sendLong(ctx, await auditOneRepo(repoToAudit))));
  }

  if (/audit.*repo|readme.*outdated|repos.*improve|weak description|popular/i.test(normalized)) {
    await reply(ctx, '🔎 <b>I’ll inspect your recently updated repos.</b>\nLooking for outdated docs, weak descriptions, and presentation problems…');
    return withFriendlyFailure(ctx, () => withTyping(ctx, () => auditRecentRepos(ctx)));
  }

  if (/switch.*model|use .*model|default model|change model/i.test(normalized)) {
    return handleModelChange(ctx, normalized);
  }

  return generalAnswer(ctx, normalized, context);
}

async function generalAnswer(ctx, text, context = {}) {
  const model = chooseDefaultModel();
  if (!model) {
    return reply(ctx, '🔑 <b>No model is available yet.</b>\nSet at least one model API key in <code>.env</code>. For now, try GitHub-specific requests like “show jobs”, “stats”, or “audit my repos”.');
  }
  const progress = delayedProgress(ctx, '🧠 <b>I’m thinking through that now…</b>\nIf this takes too long, I’ll stop instead of freezing the chat.', 900);
  const history = getConversation(ctx.chat.id, 8);
  const config = getConfig();
  const system = [
    'You are a personal GitHub agent in Telegram.',
    'Be natural, concise, honest, and practical.',
    'You can explain, plan, and suggest GitHub actions, but public-facing writes need approval unless low-risk and controlled.',
    'If the user asks during setup-like discussion, answer then bring them back to the current task.',
    'Do not claim you performed an action unless a tool/result says it happened.',
  ].join(' ');
  try {
    const response = await withTyping(ctx, () => chat(model, [
      { role: 'system', content: system },
      { role: 'user', content: `User GitHub: ${config.githubUsername || getSetting('github_username', 'unknown')}\nContext: ${JSON.stringify(context).slice(0, 1200)}\nRecent chat: ${JSON.stringify(history).slice(0, 2500)}\nCurrent message: ${text}` },
    ], { maxTokens: 700 }));
    progress.stop();
    addConversation(ctx.chat.id, 'assistant', response);
    return sendLong(ctx, `💬 ${escapeHtml(response)}`);
  } catch (err) {
    progress.stop();
    return sendLong(ctx, friendlyError(err));
  }
}

async function auditRecentRepos(ctx) {
  const config = getConfig();
  const github = new GitHubClient();
  const username = getSetting('github_username', config.githubUsername);
  const repos = await github.listAuthenticatedRepos({ pages: 2 }).catch(() => github.listRepos(username, { pages: 2 }));
  const lines = ['<b>Recent Repo Presentation Audit</b>'];
  for (const repo of repos.slice(0, 6)) {
    const readme = await github.getReadme(repo.full_name).catch(() => ({ content: '' }));
    const findings = auditRepoPresentation(repo, readme.content);
    lines.push('\n' + renderAudit(repo, findings.slice(0, 3)));
  }
  return sendLong(ctx, lines.join('\n'));
}

async function showJobs(ctx) {
  const jobs = listScheduledJobs();
  if (!jobs.length) return reply(ctx, '⏰ <b>No scheduled jobs yet.</b>');
  return sendLong(ctx, ['⏰ <b>Scheduled Jobs</b>', ...jobs.map(renderJob)].join('\n\n'));
}

async function showModels(ctx) {
  const config = getConfig();
  const available = getAvailableModels(config);
  const active = chooseDefaultModel(config);
  const lines = ['🤖 <b>Models</b>', `Active/default: <code>${escapeHtml(active || 'none')}</code>`];
  if (!available.length) lines.push('No provider API keys are configured.');
  else available.forEach(model => lines.push(`- <code>${escapeHtml(model)}</code>`));
  return sendLong(ctx, lines.join('\n'));
}

async function showStatus(ctx) {
  const config = getConfig();
  const lines = [
    '🧭 <b>Bot Status</b>',
    `GitHub username: ${escapeHtml(getSetting('github_username', config.githubUsername || 'not set'))}`,
    `Profile repo: ${escapeHtml(getSetting('profile_repo', config.githubProfileRepo || 'not set'))}`,
    `Timezone: ${escapeHtml(getSetting('timezone', config.defaultTimezone || 'UTC'))}`,
    `Notification level: ${escapeHtml(config.notificationLevel)}`,
    `Default jobs: ${getSetting('enable_default_jobs', config.enableDefaultJobs) ? 'enabled' : 'disabled'}`,
    `Auto low-risk profile updates: ${getSetting('auto_apply_low_risk_profile_updates', config.autoApplyLowRiskProfileUpdates) ? 'enabled' : 'disabled'}`,
  ];
  return sendLong(ctx, lines.join('\n'));
}

async function handleModelChange(ctx, text) {
  const config = getConfig();
  const available = getAvailableModels(config);
  const found = available.find(model => text.toLowerCase().includes(model.toLowerCase()));
  if (!found) {
    return reply(ctx, `I did not find that model among configured providers. Available: ${available.join(', ') || 'none'}`);
  }
  setSetting('default_model', found);
  return reply(ctx, `✅ <b>Model updated.</b>\nDefault model preference saved as <code>${escapeHtml(found)}</code>. I’ll use it for future model calls unless the provider key is unavailable.`);
}

function parseJobAction(text) {
  const match = text.match(/\b(pause|disable|resume|enable|delete|remove|cancel)\s+(?:job\s*)?#?(\d+)\b/i);
  if (!match) return null;
  return { action: match[1].toLowerCase(), id: Number(match[2]) };
}

async function updateJobState(ctx, jobAction) {
  const db = openDb();
  const row = db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(jobAction.id);
  if (!row) return reply(ctx, `⚠️ I could not find job #${jobAction.id}.`);
  if (['pause', 'disable'].includes(jobAction.action)) {
    db.prepare('UPDATE scheduled_jobs SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(jobAction.id);
    return reply(ctx, `⏸️ <b>Paused job #${jobAction.id}</b>\n${escapeHtml(row.name)}`);
  }
  if (['resume', 'enable'].includes(jobAction.action)) {
    db.prepare('UPDATE scheduled_jobs SET enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(jobAction.id);
    return reply(ctx, `▶️ <b>Enabled job #${jobAction.id}</b>\n${escapeHtml(row.name)}`);
  }
  db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(jobAction.id);
  return reply(ctx, `🗑️ <b>Deleted job #${jobAction.id}</b>\n${escapeHtml(row.name)}`);
}

async function handleApprovalCallback(ctx) {
  const data = ctx.callbackQuery.data || '';
  const [, action, actionId] = data.split(':');
  const row = openDb().prepare('SELECT * FROM approvals WHERE action_id = ?').get(actionId);
  if (!row) return ctx.answerCallbackQuery('Approval not found.');
  if (action === 'cancel') {
    openDb().prepare('UPDATE approvals SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE action_id = ?').run('cancelled', actionId);
    await ctx.editMessageText('Cancelled.', { parse_mode: 'HTML' }).catch(() => {});
    return ctx.answerCallbackQuery('Cancelled');
  }
  openDb().prepare('UPDATE approvals SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE action_id = ?').run('approved', actionId);
  await ctx.answerCallbackQuery('Approved');
  return ctx.editMessageText('Approved. This action type is recorded; execution handlers will be attached as write tools mature.', { parse_mode: 'HTML' }).catch(() => {});
}

function approvalKeyboard(actionId) {
  return new InlineKeyboard()
    .text('Approve', `approval:approve:${actionId}`)
    .text('Cancel', `approval:cancel:${actionId}`);
}

function extractRepoFromAudit(text) {
  const explicit = text.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
  if (explicit && /audit|readme|repo|description/i.test(text)) return explicit[1];
  return null;
}

function extractPrefetchRequest(text) {
  const match = text.match(/\b(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\s*(?:earlier|before|ago)\b/i);
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const minutes = Number(match[1]) * (unit.startsWith('hour') || unit.startsWith('hr') ? 60 : 1);
  const metric = /fork/i.test(text) ? 'forks' : 'stars';
  return { minutes, metric };
}

function extractRepoNames(text, username) {
  const explicit = [...String(text).matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/g)].map(m => m[1]);
  if (explicit.length) return [...new Set(explicit)];
  const quoted = [...String(text).matchAll(/["'`](.+?)["'`]/g)].map(m => m[1]).filter(v => /^[A-Za-z0-9_.-]+$/.test(v));
  return [...new Set(quoted.map(name => `${username}/${name}`))];
}

function inferJobName(text) {
  if (/trend/i.test(text)) return 'Custom trend job';
  if (/star|fork|view|stats/i.test(text)) return 'Custom GitHub metric job';
  if (/readme|audit|improve/i.test(text)) return 'Custom repo audit job';
  return oneLine(text, 48);
}

function describeSchedule(schedule) {
  if (schedule.type === 'interval') return `every ${schedule.everyMinutes} minutes`;
  if (schedule.type === 'daily') return `daily at ${pad(schedule.hour)}:${pad(schedule.minute)}`;
  if (schedule.type === 'weekly') return `weekly on day ${schedule.dayOfWeek} at ${pad(schedule.hour)}:${pad(schedule.minute)}`;
  if (schedule.type === 'once') return `at ${schedule.runAt}`;
  return 'on its schedule';
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function isThanksOrAck(text) {
  return /^(thanks|thank you|ok|okay|cool|nice)$/i.test(text.trim());
}

async function reply(ctx, text) {
  addConversation(ctx.chat.id, 'assistant', text);
  return ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true });
}

async function withFriendlyFailure(ctx, fn) {
  try {
    return await fn();
  } catch (err) {
    return sendLong(ctx, friendlyError(err));
  }
}

module.exports = {
  handleText,
  handleApprovalCallback,
  approvalKeyboard,
};
