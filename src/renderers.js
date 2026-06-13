const { escapeHtml, link, oneLine } = require('./utils/format');

function renderRepoCard(repo) {
  return [
    `🔥 <b>${link(repo.name || repo.full_name, repo.html_url)}</b> — ${escapeHtml(oneLine(repo.description || 'No description yet.', 120))}`,
    `⭐ ${repo.stargazers_count ?? 0} · 🍴 ${repo.forks_count ?? 0} · 🕒 ${escapeHtml((repo.updated_at || '').slice(0, 10))}`,
  ].join('\n');
}

function renderJob(job) {
  const schedule = safeJson(job.schedule_json);
  const enabled = job.enabled ? 'enabled' : 'paused';
  return `⏰ <b>${escapeHtml(job.name)}</b> — ${escapeHtml(enabled)}\n${escapeHtml(scheduleLabel(schedule))}\n${escapeHtml(oneLine(job.goal, 160))}`;
}

function scheduleLabel(schedule) {
  if (!schedule) return 'No schedule';
  if (schedule.type === 'daily') return `Daily at ${pad(schedule.hour)}:${pad(schedule.minute)}`;
  if (schedule.type === 'weekly') return `Weekly day ${schedule.dayOfWeek} at ${pad(schedule.hour)}:${pad(schedule.minute)}`;
  if (schedule.type === 'interval') return `Every ${schedule.everyMinutes} minutes`;
  if (schedule.type === 'once') return `Once at ${schedule.runAt}`;
  return JSON.stringify(schedule);
}

function renderAudit(repo, findings) {
  const lines = [`<b>Repo Audit: ${link(repo.full_name || repo.name, repo.html_url)}</b>`];
  if (!findings.length) {
    lines.push('No major presentation issues found.');
  } else {
    findings.slice(0, 8).forEach((finding, index) => {
      lines.push(`${index + 1}. ${severityIcon(finding.severity)} ${escapeHtml(finding.message)}`);
    });
  }
  return lines.join('\n');
}

function renderStatsReport(summary) {
  const lines = ['📊 <b>GitHub Stats Report</b>'];
  lines.push(`⭐ Total stars: ${summary.totalStars} (${delta(summary.starDelta)})`);
  lines.push(`🍴 Total forks: ${summary.totalForks} (${delta(summary.forkDelta)})`);
  if (summary.totalViews || summary.totalClones) {
    lines.push(`👀 Views: ${summary.totalViews || 0} · 📥 Clones: ${summary.totalClones || 0}`);
  }
  if (summary.topMovement?.length) {
    lines.push('\n📈 <b>Top movement</b>');
    summary.topMovement.slice(0, 5).forEach(item => {
      lines.push(`- ${escapeHtml(item.name)}: ${delta(item.starDelta)} stars`);
    });
  }
  if (summary.notes?.length) {
    lines.push('\n🧾 <b>Notes</b>');
    summary.notes.slice(0, 4).forEach(note => lines.push(`- ${escapeHtml(note)}`));
  }
  return lines.join('\n');
}

function renderTrendDigest(data) {
  const lines = ['🧭 <b>Morning Builder Trends</b>'];
  if (data.projects?.length) {
    lines.push('\n🔥 <b>Projects worth noticing</b>');
    data.projects.slice(0, 3).forEach((item, index) => {
      lines.push(`${index + 1}. ${link(item.title, item.url)} — ${escapeHtml(oneLine(item.why || item.description, 150))}`);
    });
  }
  if (data.ideas?.length) {
    lines.push('\n💡 <b>Project ideas</b>');
    data.ideas.slice(0, 2).forEach((item, index) => {
      lines.push(`${index + 1}. <b>${escapeHtml(item.title)}</b> — ${escapeHtml(oneLine(item.summary, 150))}`);
    });
  }
  if (data.takeaways?.length) {
    lines.push('\n🛠️ <b>Takeaways for your repos</b>');
    data.takeaways.slice(0, 3).forEach((item, index) => {
      lines.push(`${index + 1}. ${escapeHtml(oneLine(item, 180))}`);
    });
  }
  return lines.join('\n');
}

function severityIcon(severity) {
  if (severity === 'high') return '🚨';
  if (severity === 'medium') return '⚠️';
  return '💡';
}

function delta(value) {
  const n = Number(value || 0);
  if (n > 0) return `+${n}`;
  return String(n);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function safeJson(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

module.exports = {
  renderRepoCard,
  renderJob,
  renderAudit,
  renderStatsReport,
  renderTrendDigest,
};
