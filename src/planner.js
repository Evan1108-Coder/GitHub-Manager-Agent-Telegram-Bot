const { getConfig } = require('./config');
const { getSetting } = require('./db');

function parseGithubWriteRequest(text) {
  const raw = String(text || '').trim();

  const repo = extractRepo(raw);

  // Destructive intent is parsed BEFORE requiring a resolvable owner/repo so that
  // phrasings without an explicit slug ("delete my repository", "make it
  // private") still surface as a gated destructive action. These no longer
  // hard-block here — they return a payload that the security gate + approval
  // flow decide on (blocked-by-default, or confirmed when explicitly enabled).
  const dangerous = parseDangerousAction(raw, repo);
  if (dangerous) return dangerous;

  if (!repo) return null;

  const issue = parseCreateIssue(raw, repo);
  if (issue) return issue;

  const issueUpdate = parseIssueUpdate(raw, repo);
  if (issueUpdate) return issueUpdate;

  const description = parseDescriptionUpdate(raw, repo);
  if (description) return description;

  const topics = parseTopics(raw, repo);
  if (topics) return topics;

  const lineEdit = parseLineEdit(raw, repo);
  if (lineEdit) return lineEdit;

  const fileUpdate = parseFileUpdate(raw, repo);
  if (fileUpdate) return fileUpdate;

  const branch = parseBranch(raw, repo);
  if (branch) return branch;

  const pr = parsePullRequest(raw, repo);
  if (pr) return pr;

  const release = parseRelease(raw, repo);
  if (release) return release;

  const issueComment = parseIssueComment(raw, repo);
  if (issueComment) return issueComment;

  const workflow = parseWorkflowAction(raw, repo);
  if (workflow) return workflow;

  return null;
}

// Parse danger-zone intent into a concrete action payload (marked `dangerous`).
// The env gate + approval flow (not the planner) decide whether it is blocked or
// confirmed, so these are recognised even without an explicit owner/repo slug.
function parseDangerousAction(raw, repo) {
  if (/\b(delete|remove|destroy)\s+(the\s+|my\s+|this\s+)?(repo|repository)\b/i.test(raw)) {
    return { dangerous: true, type: 'delete_repo', repo };
  }
  if (/\btransfer\s+(the\s+|my\s+|this\s+|ownership\s+of\s+)?(repo|repository|it)\b/i.test(raw)
    || /\btransfer\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/i.test(raw)) {
    const newOwner = raw.match(/\bto\s+@?([A-Za-z0-9][A-Za-z0-9-]*)\b/i)?.[1] || null;
    return { dangerous: true, type: 'transfer_repo', repo, newOwner };
  }

  // Visibility: order-independent — "make repo X private", "make owner/repo
  // public", "set it to private". A bare slug or a repo pronoun is the target,
  // unless the sentence is clearly about a benign object (issue/release/etc.)
  // that legitimately uses the words public/private.
  const visibilityVerb = /\b(make|set|change|turn|switch|mark|convert|flip)\b/i.test(raw);
  const visibilityMatch = raw.match(/\b(private|public)\b/i);
  const hasSlug = /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/.test(raw);
  const benignObject = /\b(issue|issues|pr|prs|pull request|release|gist|page|comment|demo|api|endpoint|description|title|topic|topics|label|labels|name|body|readme|file)\b/i.test(raw);
  const visibilityTarget = !benignObject && (hasSlug || /\b(repository|repo|it|this|visibility)\b/i.test(raw));
  if (visibilityVerb && visibilityMatch && visibilityTarget) {
    return { dangerous: true, type: 'change_visibility', repo, visibility: visibilityMatch[1].toLowerCase() };
  }

  if (/\bunarchive\b/i.test(raw) && !benignObject) {
    return { dangerous: true, type: 'unarchive_repo', repo };
  }
  if (/\barchive\b/i.test(raw) && /\b(repo|repository|it|this)\b/i.test(raw) && !benignObject) {
    return { dangerous: true, type: 'archive_repo', repo };
  }

  if (/\b(delete|remove)\s+(the\s+)?branch\b/i.test(raw)) {
    const branch = raw.match(/\bbranch\s+([A-Za-z0-9._/-]+)/i)?.[1] || null;
    return { dangerous: true, type: 'delete_branch', repo, branch };
  }
  if (/\b(delete|remove)\s+(the\s+)?(file|path)\b/i.test(raw)) {
    return { dangerous: true, type: 'delete_file', repo, path: extractPath(raw) };
  }

  if (/\b(add|invite)\b[\s\S]*\b(collaborator|member)\b/i.test(raw)
    || /\b(collaborator|member)\b[\s\S]*\b(add|invite)\b/i.test(raw)) {
    const username = raw.match(/\b(?:add|invite)\s+(?:collaborator\s+|member\s+)?@?([A-Za-z0-9][A-Za-z0-9-]*)\b/i)?.[1]
      || raw.match(/@([A-Za-z0-9][A-Za-z0-9-]*)/)?.[1]
      || null;
    const permission = /\badmin\b/i.test(raw) ? 'admin'
      : /\bmaintain\b/i.test(raw) ? 'maintain'
        : /\b(read|pull|view)\b/i.test(raw) ? 'pull'
          : 'push';
    return { dangerous: true, type: 'add_collaborator', repo, username, permission };
  }
  if (/\b(remove|revoke|delete|kick)\b[\s\S]*\b(collaborator|member)\b/i.test(raw)
    || /\b(collaborator|member)\b[\s\S]*\b(remove|revoke|delete|kick)\b/i.test(raw)) {
    const username = raw.match(/\b(?:remove|revoke|delete|kick)\s+(?:collaborator\s+|member\s+)?@?([A-Za-z0-9][A-Za-z0-9-]*)\b/i)?.[1]
      || raw.match(/@([A-Za-z0-9][A-Za-z0-9-]*)/)?.[1]
      || null;
    return { dangerous: true, type: 'remove_collaborator', repo, username };
  }

  return null;
}

function parseGithubReadRequest(text) {
  const raw = String(text || '').trim();
  const repo = extractRepo(raw);
  if (!repo) return null;
  if (/failed workflow|workflow failures|actions failures|failed actions/i.test(raw)) return { kind: 'workflow_failures', repo };
  if (/auto[-\s]?update|update code|views|visitor|badge|profile.*home|check.*code|inspect.*code|readme/i.test(raw)) return { kind: 'inspect_repo_code', repo };
  if (/open prs|pull requests|prs/i.test(raw)) return { kind: 'list_prs', repo };
  if (/releases/i.test(raw)) return { kind: 'list_releases', repo };
  if (/issues/i.test(raw)) return { kind: 'list_issues', repo };
  return null;
}

function parseCreateIssue(raw, repo) {
  if (!/\b(create|open|draft)\s+(an?\s+)?issue\b/i.test(raw)) return null;
  if (/\b(last uploaded|uploaded file|from file|from this file)\b/i.test(raw)) return null;
  const colonTitle = extractAfterColon(raw);
  const title = extractQuotedAfter(raw, /(?:title|titled|called|named)\s*/i)
    || (colonTitle && !/https?:\/\//i.test(colonTitle) ? colonTitle : null)
    || 'New issue';
  const body = extractQuotedAfter(raw, /(?:body|description|with)\s*/i) || '';
  return {
    type: 'create_issue',
    repo,
    title,
    body,
    labels: extractLabels(raw),
  };
}

function parseIssueUpdate(raw, repo) {
  const issue = raw.match(/\b(?:issue|pr|pull request)\s*#?(\d+)\b/i);
  if (!issue) return null;
  const issueNumber = Number(issue[1]);
  if (/\b(close|resolve|mark done)\b/i.test(raw)) {
    return { type: 'update_issue', repo, issueNumber, update: { state: 'closed' } };
  }
  if (/\b(reopen|open back up)\b/i.test(raw)) {
    return { type: 'update_issue', repo, issueNumber, update: { state: 'open' } };
  }
  if (/\b(rename|retitle|change title|set title)\b/i.test(raw)) {
    const title = extractQuotedAfter(raw, /(?:to|title|as)\s*/i) || extractAfterTo(raw);
    if (title) return { type: 'update_issue', repo, issueNumber, update: { title } };
  }
  if (/\b(add|apply)\s+labels?\b/i.test(raw)) {
    const labels = extractLabels(raw) || [];
    if (labels.length) return { type: 'add_issue_labels', repo, issueNumber, labels };
  }
  return null;
}

function parseDescriptionUpdate(raw, repo) {
  if (!/\b(description|repo description)\b/i.test(raw) || !/\b(update|change|set|make)\b/i.test(raw)) return null;
  const description = extractQuotedAfter(raw, /(?:to|as|description)\s*/i) || extractAfterTo(raw);
  if (!description) return null;
  return {
    type: 'update_repo',
    repo,
    update: { description },
    diffLabel: 'repo description',
    beforeField: 'description',
    after: description,
  };
}

function parseTopics(raw, repo) {
  if (!/\b(topic|topics|tags)\b/i.test(raw) || !/\b(set|update|replace|change|add)\b/i.test(raw)) return null;
  const after = raw.match(/\b(?:topics?|tags?)\b[\s\S]*?\b(?:to|as)\s+(.+)$/i)?.[1] ||
    raw.match(/\b(?:topics?|tags?)\b\s*:\s+(.+)$/i)?.[1] ||
    '';
  const topics = after.split(/[, ]+/).map(s => s.trim().toLowerCase()).filter(s => /^[a-z0-9][a-z0-9-]{0,49}$/.test(s));
  if (!topics.length) return null;
  return { type: 'replace_topics', repo, topics: [...new Set(topics)].slice(0, 20) };
}

function parseLineEdit(raw, repo) {
  const line = raw.match(/\bline\s+(\d+)\b/i);
  if (!line || !/\b(change|replace|edit|set)\b/i.test(raw)) return null;
  const path = extractPath(raw);
  const replacement = extractQuotedAfter(raw, /\b(?:to|with|as)\s*/i);
  if (!path || replacement === null) return null;
  return {
    type: 'line_edit_request',
    repo,
    path,
    lineNumber: Number(line[1]),
    replacement,
  };
}

function parseFileUpdate(raw, repo) {
  if (!/\b(update|replace|rewrite|set)\b/i.test(raw) || !/\b(file|path)\b/i.test(raw)) return null;
  const path = extractPath(raw);
  if (!path) return null;
  const content = extractQuotedAfter(raw, /\b(?:to|with|content)\s*/i);
  if (content === null) return null;
  return {
    type: 'file_update_request',
    repo,
    path,
    content,
    message: `Update ${path}`,
  };
}

function parseBranch(raw, repo) {
  if (!/\b(create|make)\s+(a\s+)?branch\b/i.test(raw)) return null;
  const branch = extractQuotedAfter(raw, /(?:branch|named|called)\s*/i) || raw.match(/\bbranch\s+([A-Za-z0-9._/-]+)/i)?.[1];
  if (!branch) return null;
  const fromBranch = raw.match(/\bfrom\s+([A-Za-z0-9._/-]+)/i)?.[1];
  return { type: 'create_branch', repo, branch, fromBranch };
}

function parsePullRequest(raw, repo) {
  if (!/\b(open|create|draft)\s+(a\s+)?(pr|pull request)\b/i.test(raw)) return null;
  const title = extractQuotedAfter(raw, /(?:title|titled|called|named)\s*/i) || 'Pull request';
  const head = raw.match(/\bfrom\s+([A-Za-z0-9._/-]+)/i)?.[1];
  const base = raw.match(/\b(?:to|into|base)\s+([A-Za-z0-9._/-]+)/i)?.[1] || 'main';
  if (!head) return null;
  return { type: 'create_pull_request', repo, title, head, base, body: extractQuotedAfter(raw, /(?:body|description)\s*/i) || '', draft: /\bdraft\b/i.test(raw) };
}

function parseRelease(raw, repo) {
  if (!/\b(create|draft|publish)\s+(a\s+)?release\b/i.test(raw)) return null;
  const tagName = raw.match(/\b(?:tag|version)\s+([A-Za-z0-9._/-]+)/i)?.[1];
  if (!tagName) return null;
  return {
    type: 'create_release',
    repo,
    tagName,
    name: extractQuotedAfter(raw, /(?:title|name|named|called)\s*/i) || tagName,
    body: extractQuotedAfter(raw, /(?:body|notes|description)\s*/i) || '',
    draft: /\bdraft\b/i.test(raw),
    prerelease: /\bpre[- ]?release\b/i.test(raw),
  };
}

function parseIssueComment(raw, repo) {
  const issue = raw.match(/\b(?:issue|pr|pull request)\s*#?(\d+)\b/i);
  if (!issue || !/\b(comment|reply)\b/i.test(raw)) return null;
  const body = extractQuotedAfter(raw, /(?:comment|reply|say)\s*/i) || extractLastQuoted(raw) || extractAfterColon(raw);
  if (!body) return null;
  return { type: 'comment_issue', repo, issueNumber: Number(issue[1]), body };
}

function parseWorkflowAction(raw, repo) {
  const run = raw.match(/\b(?:workflow run|run)\s*#?(\d+)\b/i);
  if (run && /\brerun|re-run\b/i.test(raw)) return { type: 'rerun_workflow', repo, runId: Number(run[1]) };
  if (run && /\bcancel|stop\b/i.test(raw)) return { type: 'cancel_workflow', repo, runId: Number(run[1]) };
  const dispatch = raw.match(/\bdispatch\s+workflow\s+([A-Za-z0-9._/-]+)\s+(?:on|at|from|ref)\s+([A-Za-z0-9._/-]+)/i);
  if (dispatch) return { type: 'dispatch_workflow', repo, workflowId: dispatch[1], ref: dispatch[2], inputs: {} };
  return null;
}

function extractRepo(raw) {
  const explicit = raw.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
  if (explicit) return explicit[1];
  const username = getSetting('github_username', getConfig().githubUsername);
  const quotedRepo = raw.match(/\brepo\s+["'`]([A-Za-z0-9_.-]+)["'`]/i)?.[1];
  if (quotedRepo && username) return `${username}/${quotedRepo}`;
  return null;
}

function extractPath(raw) {
  const quoted = raw.match(/\b(?:file|path)\s+["'`]([^"'`]+)["'`]/i)?.[1];
  if (quoted) return quoted;
  return raw.match(/\b(?:file|path)\s+([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\b/i)?.[1] || null;
}

function extractQuotedAfter(raw, prefixRegex) {
  const prefix = prefixRegex.source.replace(/^\(\?:/, '(?:');
  const match = raw.match(new RegExp(prefix + `["'\`]([^"'\`]+)["'\`]`, 'i'));
  return match ? match[1].trim() : null;
}

function extractLastQuoted(raw) {
  const matches = [...String(raw).matchAll(/["'`]([^"'`]+)["'`]/g)];
  return matches.length ? matches[matches.length - 1][1].trim() : null;
}

function extractAfterColon(raw) {
  const value = raw.split(':').slice(1).join(':').trim();
  return value || null;
}

function extractAfterTo(raw) {
  const match = raw.match(/\bto\s+(.+)$/i);
  return match ? match[1].replace(/^["'`]|["'`]$/g, '').trim() : null;
}

function extractLabels(raw) {
  const match = raw.match(/\blabels?\s+(.+)$/i);
  if (!match) return undefined;
  const cleaned = match[1]
    .replace(/\b(?:to|for|on)\s+(?:issue|pr|pull request)\s*#?\d+[\s\S]*$/i, '')
    .replace(/\bin\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+[\s\S]*$/i, '')
    .trim();
  return cleaned
    .split(/[, ]+/)
    .map(s => s.trim())
    .filter(s => /^[A-Za-z0-9_.-]+$/.test(s))
    .slice(0, 10);
}

module.exports = {
  parseGithubWriteRequest,
  parseGithubReadRequest,
  parseDangerousAction,
  extractRepo,
};
