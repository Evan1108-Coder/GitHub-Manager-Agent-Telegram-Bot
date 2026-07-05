'use strict';

// watch-setup.js — GitHub-specific wiring for the generic WatchManager.
//
// Registers the "did the thing happen?" probes this bot can watch for (a PR
// merging, an issue closing, a workflow run finishing) and exposes a singleton
// the bot + agent share. Watches are OPT-IN: nothing here starts a watch on its
// own — the agent only calls startWatch after the user says "yes, keep an eye
// on it". Each probe is one cheap GitHub read per poll; the guard caps (poll
// count + wall-clock deadline) come from watch.js, so a watch always ends.

const { WatchManager } = require('./watch');
const { GitHubClient } = require('./github/client');

let manager = null;

function githubClient() {
  return new GitHubClient();
}

function registerProbes(wm) {
  // A pull request reaching merged/closed.
  wm.registerProbe('pr_closed', async params => {
    const gh = githubClient();
    const pulls = await gh.listPulls(params.repo, { state: 'all' }).catch(() => []);
    const pr = pulls.find(p => String(p.number) === String(params.number));
    if (!pr) return { done: false };
    return { done: pr.state === 'closed' || Boolean(pr.merged_at), merged: Boolean(pr.merged_at) };
  });

  // An issue being closed.
  wm.registerProbe('issue_closed', async params => {
    const gh = githubClient();
    const issues = await gh.listIssues(params.repo, { state: 'all' }).catch(() => []);
    const issue = issues.find(i => String(i.number) === String(params.number));
    if (!issue) return { done: false };
    return { done: issue.state === 'closed' };
  });

  // A workflow run finishing (success or failure both count as "done waiting").
  wm.registerProbe('workflow_done', async params => {
    const gh = githubClient();
    const runs = await gh.listWorkflowRuns(params.repo, {}).catch(() => ({ workflow_runs: [] }));
    const list = runs.workflow_runs || runs || [];
    const run = params.runId
      ? list.find(r => String(r.id) === String(params.runId))
      : list[0];
    if (!run) return { done: false };
    return { done: run.status === 'completed', conclusion: run.conclusion };
  });

  // A generic "new commit on the default branch" watch.
  wm.registerProbe('new_commit', async params => {
    const gh = githubClient();
    const commits = await gh.listCommits(params.repo, {}).catch(() => []);
    const latest = commits[0]?.sha;
    if (!latest) return { done: false };
    if (!params.baseline) return { done: false, baseline: latest };
    return { done: latest !== params.baseline, sha: latest };
  });

  return wm;
}

// Create (once) and return the shared manager. `bot` is needed the first time so
// the manager can deliver the heads-up message; later calls ignore it.
function getWatchManager(bot) {
  if (!manager) {
    manager = new WatchManager(bot, { maxConcurrent: 10 });
    registerProbes(manager);
  } else if (bot && !manager.bot) {
    manager.bot = bot;
  }
  return manager;
}

// Very small NL → watch-spec extractor for the common phrasings. Returns null if
// the message isn't a recognisable watch request. The agent decides whether to
// OFFER this (opt-in) rather than starting it directly.
function parseWatchIntent(text, defaultRepo) {
  const t = String(text || '').toLowerCase();
  if (!/\b(watch|monitor|keep an eye|let me know when|notify me when|tell me when|ping me when)\b/.test(t)) return null;

  const repoMatch = t.match(/([\w.-]+\/[\w.-]+)/);
  const repo = repoMatch ? repoMatch[1] : defaultRepo;
  if (!repo) return null;

  const prMatch = t.match(/(?:pr|pull request)\s*#?(\d+)/);
  if (prMatch) return { kind: 'pr_closed', params: { repo, number: prMatch[1] }, label: `PR #${prMatch[1]} in ${repo} to close/merge` };

  const issueMatch = t.match(/issue\s*#?(\d+)/);
  if (issueMatch) return { kind: 'issue_closed', params: { repo, number: issueMatch[1] }, label: `issue #${issueMatch[1]} in ${repo} to close` };

  if (/workflow|action|ci|build|run/.test(t)) return { kind: 'workflow_done', params: { repo }, label: `the latest workflow run in ${repo} to finish` };

  if (/commit|push/.test(t)) return { kind: 'new_commit', params: { repo }, label: `a new commit on ${repo}` };

  return null;
}

module.exports = { getWatchManager, registerProbes, parseWatchIntent };
