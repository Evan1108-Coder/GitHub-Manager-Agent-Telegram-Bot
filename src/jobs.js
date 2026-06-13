const { getConfig } = require('./config');
const { openDb, getSetting } = require('./db');
const { GitHubClient } = require('./github/client');
const { auditRepoPresentation, suspiciousCommitMessages } = require('./github/audit');
const { chatJson, chat, chooseDefaultModel } = require('./llm/providers');
const { fetchAllTrends } = require('./trends/sources');
const { sendLong, escapeHtml, oneLine } = require('./utils/format');
const { renderTrendDigest, renderStatsReport, renderAudit } = require('./renderers');

async function executeJob(job, bot) {
  const plan = JSON.parse(job.plan_json);
  const config = getConfig();
  const chatId = config.telegramChatId;
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is not set.');
  if (plan.kind === 'trend_digest') return sendLong(bot, chatId, await buildTrendDigest());
  if (plan.kind === 'profile_update') return sendLong(bot, chatId, await runProfileUpdate());
  if (plan.kind === 'daily_summary') return sendLong(bot, chatId, await buildDailySummary());
  if (plan.kind === 'stats_report') return sendLong(bot, chatId, await buildStatsReport());
  if (plan.kind === 'natural_request') return sendLong(bot, chatId, await runNaturalPlan(plan));
  if (plan.kind === 'snapshot_metric') {
    await runSnapshotMetric(plan);
    return;
  }
  return sendLong(bot, chatId, `Scheduled job ran, but I do not know this plan kind yet: ${escapeHtml(plan.kind)}`);
}

async function buildTrendDigest() {
  const items = await fetchAllTrends();
  if (!items.length) return '<b>Morning Builder Trends</b>\nI could not fetch trend sources this time.';
  const model = chooseDefaultModel();
  if (!model) {
    return renderTrendDigest(fallbackTrendDigest(items));
  }
  try {
    const json = await chatJson(model, [
      { role: 'system', content: 'Return compact JSON only. You select developer trends that teach practical lessons for improving GitHub projects, READMEs, project ideas, and public presentation.' },
      { role: 'user', content: `Use these trend items and return JSON with projects[3]{title,url,why}, ideas[2]{title,summary}, takeaways[3] strings. Keep it concise.\n${JSON.stringify(items.slice(0, 30))}` },
    ], { maxTokens: 1200 });
    return renderTrendDigest(json);
  } catch (err) {
    return renderTrendDigest(fallbackTrendDigest(items));
  }
}

async function buildStatsReport() {
  const github = new GitHubClient();
  const username = getSetting('github_username', getConfig().githubUsername);
  const repos = await github.listAuthenticatedRepos({ pages: 5 }).catch(() => github.listRepos(username, { pages: 3 }));
  const current = repos.map(repo => ({
    name: repo.full_name,
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
  }));
  const db = openDb();
  const previous = {};
  for (const item of current) {
    const row = db.prepare(`
      SELECT value FROM metric_snapshots
      WHERE subject = ? AND metric = 'stars'
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `).get(item.name);
    previous[item.name] = row ? Number(row.value) : item.stars;
  }
  current.forEach(item => {
    db.prepare('INSERT INTO metric_snapshots (subject, metric, value, raw_json) VALUES (?, ?, ?, ?)').run(item.name, 'stars', item.stars, JSON.stringify(item));
    db.prepare('INSERT INTO metric_snapshots (subject, metric, value, raw_json) VALUES (?, ?, ?, ?)').run(item.name, 'forks', item.forks, JSON.stringify(item));
  });
  const totalStars = current.reduce((sum, item) => sum + item.stars, 0);
  const totalForks = current.reduce((sum, item) => sum + item.forks, 0);
  const previousTotalStars = current.reduce((sum, item) => sum + previous[item.name], 0);
  const topMovement = current.map(item => ({ name: item.name, starDelta: item.stars - previous[item.name] })).sort((a, b) => b.starDelta - a.starDelta);
  const notes = [];
  if (github.tokenExpiration) notes.push(`GitHub token expiration header: ${github.tokenExpiration}`);
  if (github.lastRateLimit?.remaining) notes.push(`GitHub API remaining this hour: ${github.lastRateLimit.remaining}/${github.lastRateLimit.limit}`);
  return renderStatsReport({
    totalStars,
    totalForks,
    starDelta: totalStars - previousTotalStars,
    forkDelta: 0,
    topMovement,
    notes,
  });
}

async function buildDailySummary() {
  const github = new GitHubClient();
  const username = getSetting('github_username', getConfig().githubUsername);
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const repos = await github.listAuthenticatedRepos({ pages: 2 }).catch(() => github.listRepos(username, { pages: 2 }));
  const results = await mapLimit(repos.slice(0, 20), 5, async repo => {
    const commits = await github.listCommits(repo.full_name, { since: since.toISOString(), perPage: 10 }).catch(() => []);
    return { repo, commits };
  });
  const touched = results
    .filter(item => item.commits.length)
    .map(item => ({ repo: item.repo, commits: item.commits.length, latest: item.commits[0]?.commit?.message }));
  const oddCommits = results.flatMap(item => suspiciousCommitMessages(item.commits).map(commit => ({ ...commit, repo: item.repo.full_name })));
  const lines = ['📌 <b>Daily GitHub Summary</b>'];
  if (!touched.length) {
    lines.push('No commits detected today in the repos I checked.');
  } else {
    touched.slice(0, 8).forEach(item => lines.push(`- ${escapeHtml(item.repo.full_name)}: ${item.commits} commit(s). Latest: ${escapeHtml(oneLine(item.latest, 90))}`));
  }
  if (oddCommits.length) {
    lines.push('\n🧪 <b>Commit notes</b>');
    oddCommits.slice(0, 5).forEach(item => lines.push(`- ${escapeHtml(item.repo)} ${escapeHtml(item.sha)}: ${escapeHtml(oneLine(item.message, 90))}`));
  }
  lines.push('\n🚀 <b>Best next actions</b>');
  lines.push('- Check whether today’s changed repos need README/setup updates.');
  lines.push('- If a repo got meaningful work today, make sure its description still matches the actual project.');
  lines.push('- Add a demo/screenshot if the repo is meant to attract users.');
  return lines.join('\n');
}

async function runProfileUpdate() {
  const config = getConfig();
  const profileRepo = getSetting('profile_repo', config.githubProfileRepo);
  if (!profileRepo) return '<b>Profile Update</b>\nNo profile repo configured, so I skipped profile maintenance.';
  const autoApply = getSetting('auto_apply_low_risk_profile_updates', config.autoApplyLowRiskProfileUpdates);
  const github = new GitHubClient();
  const repos = await github.listAuthenticatedRepos({ pages: 3 }).catch(() => []);
  const totalStars = repos.reduce((sum, repo) => sum + (repo.stargazers_count || 0), 0);
  const topRepo = repos.slice().sort((a, b) => (b.pushed_at || '').localeCompare(a.pushed_at || ''))[0];
  const block = [
    '<!-- github-agent:start:stats -->',
    `Total public stars: ${totalStars}`,
    `Most recently active repo: ${topRepo ? topRepo.full_name : 'none'}`,
    `Last updated: ${new Date().toISOString().slice(0, 10)}`,
    '<!-- github-agent:end:stats -->',
  ].join('\n');
  const readme = await github.getReadme(profileRepo);
  const marker = /<!-- github-agent:start:stats -->([\s\S]*?)<!-- github-agent:end:stats -->/;
  if (!marker.test(readme.content)) {
    return '<b>Profile Update</b>\nI did not find a bot-controlled stats block, so I did not edit the README. Add this block if you want low-risk auto-updates:\n\n<pre>' + escapeHtml(block) + '</pre>';
  }
  const next = readme.content.replace(marker, block);
  if (next === readme.content) return '<b>Profile Update</b>\nNo factual profile stats changed.';
  if (!autoApply) {
    return '<b>Profile Update Draft</b>\nI found a safe stats update, but auto-apply is disabled. Ask me to apply it if you want.';
  }
  await github.updateFile(profileRepo, readme.path, next, 'Update GitHub agent profile stats', readme.sha);
  return '<b>Profile Update</b>\nAuto-updated the low-risk bot-controlled stats block.';
}

async function runNaturalPlan(plan) {
  const text = plan.goal || plan.originalText || 'scheduled request';
  if (/star/i.test(text)) {
    return answerStarQuery(text, plan);
  }
  return `<b>Scheduled reminder</b>\n${escapeHtml(text)}`;
}

async function answerStarQuery(text, plan = {}) {
  const config = getConfig();
  const github = new GitHubClient();
  const repos = plan.prefetchRepos?.length ? plan.prefetchRepos : extractRepoNames(text, config.githubUsername);
  if (!repos.length) return `<b>Star check</b>\nI need exact repo names to fetch stars. Original request: ${escapeHtml(text)}`;
  const rows = [];
  for (const repo of repos) {
    const data = await github.getRepo(repo).catch(() => null);
    if (data) {
      const current = data.stargazers_count || 0;
      const snapshot = plan.prefetchOffsetMinutes ? getLatestSnapshot(repo, `stars_prefetch_${plan.prefetchOffsetMinutes}`) : null;
      rows.push({ repo, stars: current, before: snapshot?.value, delta: snapshot ? current - snapshot.value : null });
    }
  }
  const total = rows.reduce((sum, item) => sum + item.stars, 0);
  const lines = ['<b>Star check</b>'];
  rows.forEach(item => {
    if (item.before !== undefined && item.before !== null) {
      lines.push(`- ${escapeHtml(item.repo)}: ${item.stars} (${item.delta >= 0 ? '+' : ''}${item.delta} since prefetch)`);
    } else {
      lines.push(`- ${escapeHtml(item.repo)}: ${item.stars}`);
    }
  });
  lines.push(`Total: ${total}`);
  if (plan.prefetchOffsetMinutes && rows.some(item => item.before === null || item.before === undefined)) {
    lines.push(`Note: I did not have a ${plan.prefetchOffsetMinutes}-minute-earlier snapshot for every repo yet. Future runs will be more accurate after the helper job captures data.`);
  }
  return lines.join('\n');
}

async function runSnapshotMetric(plan) {
  if (plan.metric !== 'stars') return;
  const github = new GitHubClient();
  for (const repo of plan.repos || []) {
    const data = await github.getRepo(repo).catch(() => null);
    if (!data) continue;
    openDb().prepare('INSERT INTO metric_snapshots (subject, metric, value, raw_json) VALUES (?, ?, ?, ?)').run(
      repo,
      `stars_prefetch_${plan.offsetMinutes}`,
      data.stargazers_count || 0,
      JSON.stringify({ relatedJobId: plan.relatedJobId, repo }),
    );
  }
}

function getLatestSnapshot(subject, metric) {
  const row = openDb().prepare(`
    SELECT value, captured_at FROM metric_snapshots
    WHERE subject = ? AND metric = ?
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  `).get(subject, metric);
  return row ? { value: Number(row.value), capturedAt: row.captured_at } : null;
}

function extractRepoNames(text, username) {
  const explicit = [...String(text).matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/g)].map(m => m[1]);
  if (explicit.length) return [...new Set(explicit)];
  const quoted = [...String(text).matchAll(/["'`](.+?)["'`]/g)].map(m => m[1]).filter(v => /^[A-Za-z0-9_.-]+$/.test(v));
  return [...new Set(quoted.map(name => `${username}/${name}`))];
}

function fallbackTrendDigest(items) {
  return {
    projects: items.slice(0, 3).map(item => ({ title: item.title, url: item.url, why: item.description || item.metric })),
    ideas: [
      { title: 'Repo presentation checker', summary: 'Build a small tool that flags missing README demos, weak descriptions, and stale setup docs.' },
      { title: 'Trend-to-roadmap assistant', summary: 'Turn repeated trends into issues or roadmap items for active repos.' },
    ],
    takeaways: [
      'Popular projects usually make value obvious in the first screen of the README.',
      'Short examples and screenshots are often more persuasive than long feature lists.',
      'Use trend signals to improve packaging, docs, and positioning, not just to chase new ideas.',
    ],
  };
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

async function auditOneRepo(repoName) {
  const github = new GitHubClient();
  const repo = await github.getRepo(repoName);
  const readme = await github.getReadme(repoName).catch(() => ({ content: '' }));
  return renderAudit(repo, auditRepoPresentation(repo, readme.content));
}

module.exports = {
  executeJob,
  buildTrendDigest,
  buildStatsReport,
  buildDailySummary,
  runProfileUpdate,
  runNaturalPlan,
  auditOneRepo,
  runSnapshotMetric,
};
