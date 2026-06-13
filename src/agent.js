const { getConfig } = require('./config');
const { addConversation, getConversation, getSetting, setSetting, openDb, recordTelemetry } = require('./db');
const { GitHubClient } = require('./github/client');
const { auditRepoPresentation } = require('./github/audit');
const { chat, chooseDefaultModel, getAvailableModels } = require('./llm/providers');
const { createScheduledJob, listScheduledJobs } = require('./scheduler');
const { parseFlexibleSchedule, shiftSchedule, computeNextRun } = require('./utils/time');
const { escapeHtml, sendLong, oneLine } = require('./utils/format');
const { delayedProgress, withTyping, friendlyError } = require('./utils/ux');
const { renderJob, renderAudit } = require('./renderers');
const { buildTrendDigest, buildStatsReport, buildDailySummary, runProfileUpdate, auditOneRepo } = require('./jobs');
const { parseGithubWriteRequest, parseGithubReadRequest } = require('./planner');
const { requestApproval, handleApprovalDecision } = require('./approvals');
const { replaceLine, textDiff } = require('./utils/diff');

async function handleText(ctx, text, context = {}) {
  const started = Date.now();
  try {
    const result = await handleTextInner(ctx, text, context);
    recordTelemetry({ chatId: ctx.chat?.id, kind: 'message', label: inferTelemetryLabel(text), status: 'ok', durationMs: Date.now() - started });
    return result;
  } catch (err) {
    recordTelemetry({ chatId: ctx.chat?.id, kind: 'message', label: inferTelemetryLabel(text), status: 'error', durationMs: Date.now() - started, detail: err.message });
    throw err;
  }
}

async function handleTextInner(ctx, text, context = {}) {
  const chatId = String(ctx.chat.id);
  addConversation(chatId, 'user', text);
  const normalized = text.trim();

  if (isThanksOrAck(normalized)) {
    return reply(ctx, '👍 Got it.');
  }

  const timezone = getSetting('timezone', getConfig().defaultTimezone);
  const schedule = parseFlexibleSchedule(normalized, timezone);
  if (schedule && /remind|tell|check|compare|summarize|update|audit|watch|monitor|every|daily|weekly|switch.*model|change.*model|use .*model/i.test(normalized)) {
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

  const jobEdit = parseJobEdit(normalized);
  if (jobEdit) return editJob(ctx, jobEdit);

  const fileIssueRepo = extractFileIssueRepo(normalized);
  if (fileIssueRepo) return withFriendlyFailure(ctx, () => createIssueFromLastUpload(ctx, fileIssueRepo));

  const writeRequest = parseGithubWriteRequest(normalized);
  if (writeRequest) return withFriendlyFailure(ctx, () => prepareGithubWrite(ctx, writeRequest));

  const readRequest = parseGithubReadRequest(normalized);
  if (readRequest) return withFriendlyFailure(ctx, () => handleGithubRead(ctx, readRequest));

  if (/^(jobs|show jobs|list jobs|\/jobs)$/i.test(normalized)) {
    return showJobs(ctx);
  }

  if (/reset setup|start setup over|redo setup|\/reset-setup/i.test(normalized)) {
    setSetting('setup_complete', false);
    setSetting('setup_step', 'confirm_env');
    return reply(ctx, '🔄 <b>Setup reset.</b>\nSend /start to run onboarding again.');
  }

  if (/^(models|show models|\/models)$/i.test(normalized)) {
    return showModels(ctx);
  }

  if (/approval log|audit log|show approvals/i.test(normalized)) {
    return showApprovalLog(ctx);
  }

  const verbosity = parseVerbosity(normalized);
  if (verbosity) {
    setSetting('verbosity', verbosity);
    return reply(ctx, `✅ <b>Verbosity updated.</b>\nI’ll use <code>${escapeHtml(verbosity)}</code> style by default.`);
  }

  if (/search uploaded|search files|uploaded files|last uploaded/i.test(normalized)) {
    return searchUploadedFiles(ctx, normalized);
  }

  if (/settings|status|config|setup/i.test(normalized)) {
    return showStatus(ctx);
  }

  if (/telemetry|latency|slow replies|response time/i.test(normalized)) {
    return showTelemetry(ctx);
  }

  if (/token permission|github token|token status|permissions/i.test(normalized)) {
    return showTokenStatus(ctx);
  }

  if (/security alert|dependabot|vulnerab|dependency alert/i.test(normalized)) {
    await reply(ctx, '🔐 <b>I’ll check recent repos for dependency/security alerts.</b>');
    return withFriendlyFailure(ctx, () => withTyping(ctx, () => checkSecurityAlerts(ctx)));
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

  const readmePatchRepo = extractReadmePatchRepo(normalized);
  if (readmePatchRepo) {
    await reply(ctx, `📝 <b>Drafting a README patch for ${escapeHtml(readmePatchRepo)}</b>`);
    return withFriendlyFailure(ctx, () => withTyping(ctx, () => prepareReadmePatch(ctx, readmePatchRepo)));
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
    const stale = await detectStaleReadme(github, repo).catch(() => null);
    if (stale?.stale) findings.unshift({ severity: 'medium', message: `README may be stale: latest repo commit is ${stale.repoDate}, latest README commit is ${stale.readmeDate || 'unknown'}.` });
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
    `Verbosity: ${escapeHtml(getSetting('verbosity', 'normal'))}`,
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

async function prepareGithubWrite(ctx, request) {
  if (request.blocked) {
    return reply(ctx, `🛑 <b>Blocked.</b>\n${escapeHtml(request.reason)}`);
  }
  if (request.type === 'line_edit_request') {
    const github = new GitHubClient();
    const file = await github.getFile(request.repo, request.path);
    const edit = replaceLine(file.content, request.lineNumber, request.replacement);
    return requestApproval(ctx, {
      type: 'update_file',
      repo: request.repo,
      path: file.path,
      content: edit.content,
      sha: file.sha,
      message: `Update ${file.path}`,
    }, {
      summary: `Change line ${request.lineNumber} in ${request.repo}/${file.path}.`,
      diff: edit.diff,
    });
  }
  if (request.type === 'file_update_request') {
    const github = new GitHubClient();
    const file = await github.getFile(request.repo, request.path);
    return requestApproval(ctx, {
      type: 'update_file',
      repo: request.repo,
      path: file.path,
      content: request.content,
      sha: file.sha,
      message: request.message || `Update ${file.path}`,
    }, {
      summary: `Update ${request.repo}/${file.path}.`,
      diff: textDiff(file.content, request.content, file.path),
    });
  }
  if (request.type === 'update_repo' && request.beforeField) {
    const github = new GitHubClient();
    const repo = await github.getRepo(request.repo);
    const before = repo[request.beforeField] || '';
    return requestApproval(ctx, request, {
      summary: `Update ${request.beforeField} for ${request.repo}.`,
      diff: textDiff(before, request.after, request.beforeField),
    });
  }
  return requestApproval(ctx, request);
}

async function prepareReadmePatch(ctx, repoName) {
  const github = new GitHubClient();
  const repo = await github.getRepo(repoName);
  const readme = await github.getReadme(repoName);
  const findings = auditRepoPresentation(repo, readme.content);
  const additions = [];
  const lower = readme.content.toLowerCase();
  if (!/quick start|getting started|setup|install/.test(lower)) {
    additions.push([
      '## Quick Start',
      '',
      '```bash',
      '# Add setup commands here',
      '```',
      '',
      'Describe the required environment variables, tokens, and first successful run.',
    ].join('\n'));
  }
  if (!/demo|screenshot|preview|video/.test(lower)) {
    additions.push([
      '## Demo',
      '',
      'Add a screenshot, GIF, short video, or link that shows the project working.',
    ].join('\n'));
  }
  if (!/why|problem|purpose/.test(lower)) {
    additions.push([
      '## Why This Exists',
      '',
      'Explain the problem this project solves and who it is for in 2-3 sentences.',
    ].join('\n'));
  }
  if (!additions.length) {
    additions.push([
      '## Project Notes',
      '',
      'Add a short note about the current project status, roadmap, or next improvement.',
    ].join('\n'));
  }
  const patchBlock = additions.join('\n\n');
  const next = `${readme.content.trimEnd()}\n\n${patchBlock}\n`;
  const summary = findings.length
    ? `Draft README improvement for ${repoName}. Main finding: ${findings[0].message}`
    : `Draft small README improvement for ${repoName}.`;
  return requestApproval(ctx, {
    type: 'update_file',
    repo: repoName,
    path: readme.path,
    content: next,
    sha: readme.sha,
    message: 'Improve README structure',
  }, {
    summary,
    diff: `@@ append to README @@\n+ ${patchBlock.replace(/\n/g, '\n+ ')}`,
  });
}

async function handleGithubRead(ctx, request) {
  const github = new GitHubClient();
  if (request.kind === 'workflow_failures') {
    const runs = await github.listWorkflowRuns(request.repo, { perPage: 10 });
    const failed = runs.workflow_runs?.filter(run => run.conclusion === 'failure' || run.status === 'failure') || [];
    if (!failed.length) return reply(ctx, `✅ <b>No recent failed workflow runs found.</b>\n<code>${escapeHtml(request.repo)}</code>`);
    const lines = [`🚨 <b>Failed workflow runs</b>\n<code>${escapeHtml(request.repo)}</code>`];
    failed.slice(0, 5).forEach(run => lines.push(`- ${escapeHtml(run.name || 'workflow')} #${run.run_number}: ${escapeHtml(run.html_url)}`));
    return sendLong(ctx, lines.join('\n'));
  }
  if (request.kind === 'list_prs') {
    const prs = await github.listPulls(request.repo, { state: 'open', perPage: 10 });
    const lines = [`🔀 <b>Open PRs</b>\n<code>${escapeHtml(request.repo)}</code>`];
    if (!prs.length) lines.push('No open pull requests.');
    prs.forEach(pr => lines.push(`- #${pr.number} ${escapeHtml(pr.title)} — ${escapeHtml(pr.html_url)}`));
    return sendLong(ctx, lines.join('\n'));
  }
  if (request.kind === 'list_issues') {
    const issues = await github.listIssues(request.repo, { state: 'open', perPage: 10 });
    const realIssues = issues.filter(issue => !issue.pull_request);
    const lines = [`🧩 <b>Open issues</b>\n<code>${escapeHtml(request.repo)}</code>`];
    if (!realIssues.length) lines.push('No open issues.');
    realIssues.forEach(issue => lines.push(`- #${issue.number} ${escapeHtml(issue.title)} — ${escapeHtml(issue.html_url)}`));
    return sendLong(ctx, lines.join('\n'));
  }
  if (request.kind === 'list_releases') {
    const releases = await github.listReleases(request.repo, { perPage: 8 });
    const lines = [`🏷️ <b>Releases</b>\n<code>${escapeHtml(request.repo)}</code>`];
    if (!releases.length) lines.push('No releases found.');
    releases.forEach(release => lines.push(`- ${escapeHtml(release.tag_name)} ${escapeHtml(release.name || '')} — ${escapeHtml(release.html_url)}`));
    return sendLong(ctx, lines.join('\n'));
  }
  return reply(ctx, 'I do not know how to run that GitHub read request yet.');
}

function parseJobAction(text) {
  const match = text.match(/\b(pause|disable|resume|enable|delete|remove|cancel)\s+(?:job\s*)?#?(\d+)\b/i);
  if (!match) return null;
  return { action: match[1].toLowerCase(), id: Number(match[2]) };
}

function parseJobEdit(text) {
  const id = text.match(/\bjob\s*#?(\d+)\b/i)?.[1];
  if (!id) return null;
  const time = text.match(/\b(?:move|set|change).*(?:to|at)\s+([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?/i);
  if (time) {
    let hour = Number(time[1]);
    const minute = Number(time[2] || 0);
    const meridiem = time[3]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return { type: 'time', id: Number(id), hour, minute };
  }
  const weekly = text.match(/\bmake.*job\s*#?\d+.*weekly|weekly.*job\s*#?\d+/i);
  if (weekly) return { type: 'weekly', id: Number(id) };
  const daily = text.match(/\bmake.*job\s*#?\d+.*daily|daily.*job\s*#?\d+/i);
  if (daily) return { type: 'daily', id: Number(id) };
  const repo = text.match(/\bonly.*(?:for|repo)\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i)?.[1];
  if (repo) return { type: 'repo_filter', id: Number(id), repo };
  return null;
}

async function editJob(ctx, edit) {
  const db = openDb();
  const row = db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(edit.id);
  if (!row) return reply(ctx, `⚠️ I could not find job #${edit.id}.`);
  const schedule = JSON.parse(row.schedule_json);
  const plan = JSON.parse(row.plan_json);
  if (edit.type === 'time') {
    schedule.hour = edit.hour;
    schedule.minute = edit.minute;
  } else if (edit.type === 'weekly') {
    schedule.type = 'weekly';
    schedule.dayOfWeek = schedule.dayOfWeek ?? 1;
    schedule.hour = schedule.hour ?? 9;
    schedule.minute = schedule.minute ?? 0;
  } else if (edit.type === 'daily') {
    schedule.type = 'daily';
    schedule.hour = schedule.hour ?? 9;
    schedule.minute = schedule.minute ?? 0;
    delete schedule.dayOfWeek;
  } else if (edit.type === 'repo_filter') {
    plan.targetRepos = [edit.repo];
  }
  db.prepare('UPDATE scheduled_jobs SET schedule_json = ?, plan_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(schedule), JSON.stringify(plan), edit.id);
  const nextRunAt = computeNextRun(schedule, new Date(), schedule.timezone);
  db.prepare('UPDATE scheduled_jobs SET next_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextRunAt, edit.id);
  return reply(ctx, `✅ <b>Updated job #${edit.id}</b>\n${escapeHtml(row.name)}`);
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

async function showTelemetry(ctx) {
  const rows = openDb().prepare(`
    SELECT label, status, duration_ms, created_at
    FROM telemetry
    ORDER BY created_at DESC, id DESC
    LIMIT 10
  `).all();
  if (!rows.length) return reply(ctx, '📈 <b>No telemetry recorded yet.</b>');
  const lines = ['📈 <b>Recent response times</b>'];
  rows.forEach(row => lines.push(`- ${escapeHtml(row.label)}: ${row.duration_ms}ms (${escapeHtml(row.status)})`));
  return sendLong(ctx, lines.join('\n'));
}

async function showTokenStatus(ctx) {
  const github = new GitHubClient();
  const user = await github.getCurrentUser();
  const lines = [
    '🔐 <b>GitHub token status</b>',
    `User: <code>${escapeHtml(user.login)}</code>`,
    `Rate limit remaining: ${escapeHtml(github.lastRateLimit?.remaining || 'unknown')}/${escapeHtml(github.lastRateLimit?.limit || 'unknown')}`,
  ];
  if (github.tokenExpiration) lines.push(`Token expiration: ${escapeHtml(github.tokenExpiration)}`);
  else lines.push('Token expiration: not provided by GitHub for this token type.');
  return sendLong(ctx, lines.join('\n'));
}

async function showApprovalLog(ctx) {
  const rows = openDb().prepare(`
    SELECT action_id, summary, status, created_at
    FROM approvals
    ORDER BY created_at DESC, id DESC
    LIMIT 10
  `).all();
  if (!rows.length) return reply(ctx, '🧾 <b>No approvals recorded yet.</b>');
  const lines = ['🧾 <b>Recent approvals</b>'];
  rows.forEach(row => lines.push(`- <code>${escapeHtml(row.action_id)}</code> ${escapeHtml(row.status)} — ${escapeHtml(row.summary)}`));
  return sendLong(ctx, lines.join('\n'));
}

async function checkSecurityAlerts(ctx) {
  const config = getConfig();
  const github = new GitHubClient();
  const username = getSetting('github_username', config.githubUsername);
  const repos = await github.listAuthenticatedRepos({ pages: 1 }).catch(() => github.listRepos(username, { pages: 1 }));
  const lines = ['🔐 <b>Security / dependency alerts</b>'];
  let checked = 0;
  let found = 0;
  for (const repo of repos.slice(0, 10)) {
    const alerts = await github.listDependabotAlerts(repo.full_name).catch(err => {
      if (err.status === 403 || err.status === 404) return null;
      throw err;
    });
    if (!alerts) continue;
    checked += 1;
    const open = alerts.filter(alert => alert.state === 'open');
    found += open.length;
    if (open.length) {
      lines.push(`\n<b>${escapeHtml(repo.full_name)}</b>`);
      open.slice(0, 3).forEach(alert => {
        const advisory = alert.security_advisory || {};
        lines.push(`- ${escapeHtml(advisory.severity || 'unknown')} — ${escapeHtml(oneLine(advisory.summary || alert.dependency?.package?.name || 'Dependency alert', 140))}`);
      });
    }
  }
  if (!checked) {
    lines.push('I could not read Dependabot alerts for the checked repos. The GitHub token may need security-events/dependabot alert access, or alerts may be disabled.');
  } else if (!found) {
    lines.push(`No open Dependabot alerts found in the ${checked} repo(s) I could inspect.`);
  }
  return sendLong(ctx, lines.join('\n'));
}

async function searchUploadedFiles(ctx, text) {
  const term = text.match(/\b(?:for|about|containing)\s+(.+)$/i)?.[1]?.trim();
  const db = openDb();
  const rows = term
    ? db.prepare(`
        SELECT file_name, summary, created_at FROM uploaded_files
        WHERE chat_id = ? AND (file_name LIKE ? OR summary LIKE ? OR extracted_text LIKE ?)
        ORDER BY created_at DESC LIMIT 5
      `).all(String(ctx.chat.id), `%${term}%`, `%${term}%`, `%${term}%`)
    : db.prepare('SELECT file_name, summary, created_at FROM uploaded_files WHERE chat_id = ? ORDER BY created_at DESC LIMIT 5').all(String(ctx.chat.id));
  if (!rows.length) return reply(ctx, '📎 <b>No uploaded files matched.</b>');
  const lines = ['📎 <b>Uploaded files</b>'];
  rows.forEach(row => lines.push(`- <b>${escapeHtml(row.file_name)}</b>: ${escapeHtml(oneLine(row.summary || 'No summary', 160))}`));
  return sendLong(ctx, lines.join('\n'));
}

async function createIssueFromLastUpload(ctx, repo) {
  const row = openDb().prepare(`
    SELECT file_name, summary, extracted_text
    FROM uploaded_files
    WHERE chat_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(String(ctx.chat.id));
  if (!row) return reply(ctx, '📎 <b>No uploaded file found.</b>\nUpload a file first, then ask me to create an issue from it.');
  const title = `Review uploaded file: ${row.file_name}`;
  const body = [
    `Created from uploaded file: ${row.file_name}`,
    '',
    row.summary || 'No summary available.',
    '',
    row.extracted_text ? `Excerpt:\n\n${row.extracted_text.slice(0, 3000)}` : '',
  ].join('\n').trim();
  return requestApproval(ctx, {
    type: 'create_issue',
    repo,
    title,
    body,
    labels: ['from-upload'],
  }, {
    summary: `Create an issue in ${repo} from the latest uploaded file (${row.file_name}).`,
  });
}

async function detectStaleReadme(github, repo) {
  const repoCommits = await github.listCommits(repo.full_name, { perPage: 1 });
  const readmeCommits = await github.listCommits(repo.full_name, { perPage: 1, path: 'README.md' }).catch(() => []);
  const repoDate = repoCommits[0]?.commit?.committer?.date;
  const readmeDate = readmeCommits[0]?.commit?.committer?.date;
  if (!repoDate || !readmeDate) return { stale: false, repoDate, readmeDate };
  const stale = new Date(repoDate).getTime() - new Date(readmeDate).getTime() > 7 * 24 * 60 * 60 * 1000;
  return { stale, repoDate: repoDate.slice(0, 10), readmeDate: readmeDate.slice(0, 10) };
}

const handleApprovalCallback = handleApprovalDecision;

function extractRepoFromAudit(text) {
  const explicit = text.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
  if (explicit && /audit|readme|repo|description/i.test(text)) return explicit[1];
  return null;
}

function extractReadmePatchRepo(text) {
  if (!/\breadme\b/i.test(text) || !/\b(draft|improve|fix|patch|update)\b/i.test(text)) return null;
  const explicit = text.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
  return explicit ? explicit[1] : null;
}

function extractPrefetchRequest(text) {
  const match = text.match(/\b(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\s*(?:earlier|before|ago)\b/i);
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const minutes = Number(match[1]) * (unit.startsWith('hour') || unit.startsWith('hr') ? 60 : 1);
  const hasStars = /star/i.test(text);
  const hasErrors = /error|fail|broken workflow|workflow failure/i.test(text);
  const metric = hasStars && hasErrors ? 'mixed_metrics' : hasErrors ? 'workflow_failures' : /fork/i.test(text) ? 'forks' : 'stars';
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

function parseVerbosity(text) {
  const match = text.match(/\b(?:set|change|use)\s+(?:verbosity|detail|mode)\s+(?:to\s+)?(quick|normal|detailed|detail)\b/i);
  if (!match) return null;
  return match[1] === 'detail' ? 'detailed' : match[1].toLowerCase();
}

function extractFileIssueRepo(text) {
  if (!/\b(create|open|draft)\s+(an?\s+)?issue\b/i.test(text)) return null;
  if (!/\b(last uploaded|uploaded file|from file|from this file)\b/i.test(text)) return null;
  return text.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/)?.[1] || null;
}

function inferTelemetryLabel(text) {
  const raw = String(text || '').toLowerCase();
  if (raw.includes('audit')) return 'audit';
  if (raw.includes('trend')) return 'trend';
  if (raw.includes('stats') || raw.includes('stars')) return 'stats';
  if (raw.includes('issue')) return 'issue';
  if (raw.includes('job')) return 'job';
  return 'chat';
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
};
