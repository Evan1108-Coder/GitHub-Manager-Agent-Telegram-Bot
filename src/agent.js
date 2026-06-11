const { InlineKeyboard } = require('grammy');
const { getConfig } = require('./config');
const { addConversation, getConversation, getSetting, setSetting, openDb } = require('./db');
const { GitHubClient } = require('./github/client');
const { auditRepoPresentation } = require('./github/audit');
const { chat, chooseDefaultModel, getAvailableModels } = require('./llm/providers');
const { createScheduledJob, listScheduledJobs } = require('./scheduler');
const { parseFlexibleSchedule } = require('./utils/time');
const { escapeHtml, sendLong, oneLine } = require('./utils/format');
const { renderRepoCard, renderJob, renderAudit } = require('./renderers');
const { buildTrendDigest, buildStatsReport, buildDailySummary, runProfileUpdate, auditOneRepo } = require('./jobs');

async function handleText(ctx, text, context = {}) {
  const chatId = String(ctx.chat.id);
  addConversation(chatId, 'user', text);
  const normalized = text.trim();

  if (isThanksOrAck(normalized)) {
    return reply(ctx, 'Got it.');
  }

  const schedule = parseFlexibleSchedule(normalized);
  if (schedule && /remind|tell|check|compare|summarize|update|audit|watch|monitor|every|daily|weekly/i.test(normalized)) {
    const id = createScheduledJob({
      name: inferJobName(normalized),
      goal: normalized,
      schedule,
      plan: { kind: 'natural_request', goal: normalized, context },
      permissions: { source: 'user_request', approvalRequiredForWrites: true },
      outputStyle: 'concise',
    });
    return reply(ctx, `Scheduled it. Job #${id} will run ${describeSchedule(schedule)}. You can change or pause it later by talking naturally.`);
  }

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
    await reply(ctx, 'Got it. Fetching trend sources and compressing them into a short builder digest…');
    return sendLong(ctx, await buildTrendDigest());
  }

  if (/daily summary|what did i do|summarize today|today on github/i.test(normalized)) {
    await reply(ctx, 'I’m checking today’s GitHub activity now…');
    return sendLong(ctx, await buildDailySummary());
  }

  if (/stats|stars|popularity|views|forks/i.test(normalized) && !/audit|readme/i.test(normalized)) {
    await reply(ctx, 'I’m checking GitHub stats and stored snapshots…');
    return sendLong(ctx, await buildStatsReport());
  }

  if (/profile.*update|update.*profile|profile readme/i.test(normalized)) {
    await reply(ctx, 'I’ll check the profile README and only auto-apply low-risk controlled updates if enabled…');
    return sendLong(ctx, await runProfileUpdate());
  }

  const repoToAudit = extractRepoFromAudit(normalized);
  if (repoToAudit) {
    await reply(ctx, `I’m auditing ${escapeHtml(repoToAudit)} for README/docs/presentation issues…`);
    return sendLong(ctx, await auditOneRepo(repoToAudit));
  }

  if (/audit.*repo|readme.*outdated|repos.*improve|weak description|popular/i.test(normalized)) {
    await reply(ctx, 'I’ll inspect your recently updated repos and look for presentation problems…');
    return auditRecentRepos(ctx);
  }

  if (/switch.*model|use .*model|default model|change model/i.test(normalized)) {
    return handleModelChange(ctx, normalized);
  }

  return generalAnswer(ctx, normalized, context);
}

async function generalAnswer(ctx, text, context = {}) {
  const model = chooseDefaultModel();
  if (!model) {
    return reply(ctx, 'I can answer better after at least one model API key is configured in .env. For now, try GitHub-specific requests like “show jobs”, “stats”, or “audit my repos”.');
  }
  const history = getConversation(ctx.chat.id, 8);
  const config = getConfig();
  const system = [
    'You are a personal GitHub agent in Telegram.',
    'Be natural, concise, honest, and practical.',
    'You can explain, plan, and suggest GitHub actions, but public-facing writes need approval unless low-risk and controlled.',
    'If the user asks during setup-like discussion, answer then bring them back to the current task.',
    'Do not claim you performed an action unless a tool/result says it happened.',
  ].join(' ');
  const response = await chat(model, [
    { role: 'system', content: system },
    { role: 'user', content: `User GitHub: ${config.githubUsername || getSetting('github_username', 'unknown')}\nContext: ${JSON.stringify(context).slice(0, 1200)}\nRecent chat: ${JSON.stringify(history).slice(0, 2500)}\nCurrent message: ${text}` },
  ], { maxTokens: 900 });
  addConversation(ctx.chat.id, 'assistant', response);
  return sendLong(ctx, escapeHtml(response));
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
  if (!jobs.length) return reply(ctx, 'No scheduled jobs yet.');
  return sendLong(ctx, ['<b>Scheduled Jobs</b>', ...jobs.map(renderJob)].join('\n\n'));
}

async function showModels(ctx) {
  const config = getConfig();
  const available = getAvailableModels(config);
  const active = chooseDefaultModel(config);
  const lines = ['<b>Models</b>', `Active/default: ${escapeHtml(active || 'none')}`];
  if (!available.length) lines.push('No provider API keys are configured.');
  else available.forEach(model => lines.push(`- ${escapeHtml(model)}`));
  return sendLong(ctx, lines.join('\n'));
}

async function showStatus(ctx) {
  const config = getConfig();
  const lines = [
    '<b>Bot Status</b>',
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
  return reply(ctx, `Default model preference saved as ${escapeHtml(found)}. If DEFAULT_MODEL is set in .env, that can still override runtime preferences depending on startup config.`);
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

module.exports = {
  handleText,
  handleApprovalCallback,
  approvalKeyboard,
};
