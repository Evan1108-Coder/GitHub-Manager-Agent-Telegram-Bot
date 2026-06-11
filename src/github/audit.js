const { oneLine } = require('../utils/format');

function auditReadme(readme, repo = {}) {
  const text = readme || '';
  const lower = text.toLowerCase();
  const findings = [];
  if (text.length < 900) findings.push({ severity: 'medium', message: 'README is short for a portfolio/public repo.' });
  if (!/install|setup|quick start|getting started/i.test(text)) findings.push({ severity: 'medium', message: 'Missing clear setup or quick-start section.' });
  if (!/screenshot|demo|preview|gif|video/i.test(text)) findings.push({ severity: 'low', message: 'No obvious screenshot/demo section.' });
  if (!/license/i.test(text) && !repo.license) findings.push({ severity: 'low', message: 'License is not obvious from README/repo metadata.' });
  if (!/why|purpose|problem/i.test(lower)) findings.push({ severity: 'low', message: 'README could explain why the project matters more clearly.' });
  if ((repo.description || '').length > 0 && !lower.includes(repo.description.toLowerCase().slice(0, 24))) {
    findings.push({ severity: 'low', message: 'Repo description and README opening may not reinforce each other.' });
  }
  return findings;
}

function auditRepoPresentation(repo, readmeText = '') {
  const findings = [];
  if (!repo.description || repo.description.length < 35) findings.push({ severity: 'medium', message: 'Repo description is weak or missing.' });
  if (!repo.homepage) findings.push({ severity: 'low', message: 'No homepage/demo URL set.' });
  if (!repo.topics || repo.topics.length < 3) findings.push({ severity: 'low', message: 'Few repo topics; discoverability could improve.' });
  findings.push(...auditReadme(readmeText, repo));
  return findings.map(item => ({ ...item, message: oneLine(item.message, 180) }));
}

function suspiciousCommitMessages(commits) {
  return commits
    .filter(commit => {
      const msg = commit.commit?.message || '';
      return /^(fix|update|change|stuff|test|asdf|wip|oops|error)$/i.test(msg.trim()) || msg.trim().length < 8;
    })
    .map(commit => ({
      sha: commit.sha?.slice(0, 7),
      message: commit.commit?.message,
      url: commit.html_url,
    }));
}

module.exports = { auditReadme, auditRepoPresentation, suspiciousCommitMessages };
