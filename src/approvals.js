const crypto = require('crypto');
const { InlineKeyboard } = require('grammy');
const { openDb } = require('./db');
const { GitHubClient } = require('./github/client');
const { escapeHtml } = require('./utils/format');
const { classifyAction } = require('./security');

function createActionId() {
  return crypto.randomBytes(8).toString('hex');
}

async function requestApproval(ctx, payload, options = {}) {
  const risk = classifyAction(payload);
  if (risk.level === 'blocked') {
    return ctx.reply(`🛑 <b>Blocked.</b>\n${escapeHtml(risk.reason)}`, { parse_mode: 'HTML' });
  }

  const actionId = createActionId();
  const summary = options.summary || summarizePayload(payload);
  openDb().prepare(`
    INSERT INTO approvals (chat_id, action_id, summary, payload_json, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(String(ctx.chat.id), actionId, summary, JSON.stringify(payload));

  const keyboard = new InlineKeyboard()
    .text('✅ Approve', `approval:approve:${actionId}`)
    .text('✏️ Edit', `approval:edit:${actionId}`)
    .text('❌ Cancel', `approval:cancel:${actionId}`);

  return ctx.reply(renderApprovalMessage(actionId, summary, payload, risk, options.diff), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard,
  });
}

async function handleApprovalDecision(ctx) {
  const data = ctx.callbackQuery.data || '';
  const [, action, actionId] = data.split(':');
  const row = openDb().prepare('SELECT * FROM approvals WHERE action_id = ?').get(actionId);
  if (!row) return ctx.answerCallbackQuery('Approval not found.');
  if (row.status !== 'pending') return ctx.answerCallbackQuery(`Already ${row.status}.`);
  if (isExpired(row.created_at)) {
    openDb().prepare('UPDATE approvals SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE action_id = ?').run('expired', actionId);
    await ctx.editMessageText('⌛ <b>Approval expired.</b>\nPlease send the request again.', { parse_mode: 'HTML' }).catch(() => {});
    return ctx.answerCallbackQuery('Expired');
  }

  if (action === 'cancel') {
    openDb().prepare('UPDATE approvals SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE action_id = ?').run('cancelled', actionId);
    await ctx.editMessageText('❌ <b>Cancelled.</b>', { parse_mode: 'HTML' }).catch(() => {});
    return ctx.answerCallbackQuery('Cancelled');
  }

  if (action === 'edit') {
    await ctx.answerCallbackQuery('Edit by sending a new instruction.');
    return ctx.reply('✏️ Send the corrected instruction and I’ll draft a new approval.', { parse_mode: 'HTML' });
  }

  try {
    const payload = JSON.parse(row.payload_json);
    const result = await executeApprovedAction(payload);
    openDb().prepare('UPDATE approvals SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE action_id = ?').run('approved', actionId);
    const message = `✅ <b>Approved and applied.</b>\n${escapeHtml(result.message || 'Action completed.')}${result.url ? `\n${escapeHtml(result.url)}` : ''}`;
    await ctx.editMessageText(message, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
    return ctx.answerCallbackQuery('Applied');
  } catch (err) {
    openDb().prepare('UPDATE approvals SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE action_id = ?').run('failed', actionId);
    await ctx.editMessageText(`⚠️ <b>Approval failed.</b>\n${escapeHtml(err.message)}`, { parse_mode: 'HTML' }).catch(() => {});
    return ctx.answerCallbackQuery('Failed');
  }
}

function isExpired(createdAt) {
  const ageMs = Date.now() - new Date(`${createdAt}Z`).getTime();
  return ageMs > 24 * 60 * 60 * 1000;
}

async function executeApprovedAction(payload) {
  const github = new GitHubClient();
  if (payload.type === 'create_issue') {
    const issue = await github.createIssue(payload.repo, payload.title, payload.body || '', { labels: payload.labels });
    return { message: `Created issue #${issue.number} in ${payload.repo}.`, url: issue.html_url };
  }
  if (payload.type === 'update_issue') {
    const issue = await github.updateIssue(payload.repo, payload.issueNumber, payload.update);
    return { message: `Updated issue #${issue.number} in ${payload.repo}.`, url: issue.html_url };
  }
  if (payload.type === 'comment_issue') {
    const comment = await github.commentIssue(payload.repo, payload.issueNumber, payload.body);
    return { message: `Commented on issue/PR #${payload.issueNumber} in ${payload.repo}.`, url: comment.html_url };
  }
  if (payload.type === 'add_issue_labels') {
    await github.addLabelsToIssue(payload.repo, payload.issueNumber, payload.labels || []);
    return { message: `Added labels to issue/PR #${payload.issueNumber} in ${payload.repo}.` };
  }
  if (payload.type === 'update_repo') {
    const repo = await github.updateRepo(payload.repo, payload.update);
    return { message: `Updated repo metadata for ${payload.repo}.`, url: repo.html_url };
  }
  if (payload.type === 'replace_topics') {
    await github.replaceTopics(payload.repo, payload.topics);
    return { message: `Updated topics for ${payload.repo}.` };
  }
  if (payload.type === 'update_file') {
    const result = await github.updateFile(payload.repo, payload.path, payload.content, payload.message, payload.sha, payload.branch);
    return { message: `Updated ${payload.path} in ${payload.repo}.`, url: result.content?.html_url || result.commit?.html_url };
  }
  if (payload.type === 'create_branch') {
    await github.createBranch(payload.repo, payload.branch, payload.fromBranch);
    return { message: `Created branch ${payload.branch} in ${payload.repo}.` };
  }
  if (payload.type === 'create_pull_request') {
    const pr = await github.createPullRequest(payload.repo, payload);
    return { message: `Opened PR #${pr.number} in ${payload.repo}.`, url: pr.html_url };
  }
  if (payload.type === 'create_release') {
    const release = await github.createRelease(payload.repo, payload);
    return { message: `Created release ${release.tag_name} in ${payload.repo}.`, url: release.html_url };
  }
  if (payload.type === 'rerun_workflow') {
    await github.rerunWorkflowRun(payload.repo, payload.runId);
    return { message: `Requested rerun for workflow run ${payload.runId} in ${payload.repo}.` };
  }
  if (payload.type === 'cancel_workflow') {
    await github.cancelWorkflowRun(payload.repo, payload.runId);
    return { message: `Requested cancel for workflow run ${payload.runId} in ${payload.repo}.` };
  }
  if (payload.type === 'dispatch_workflow') {
    await github.dispatchWorkflow(payload.repo, payload.workflowId, payload.ref, payload.inputs || {});
    return { message: `Dispatched workflow ${payload.workflowId} in ${payload.repo}.` };
  }
  throw new Error(`Unsupported approved action type: ${payload.type}`);
}

function renderApprovalMessage(actionId, summary, payload, risk, diff) {
  const lines = [
    `🧾 <b>Approval needed</b> <code>${escapeHtml(actionId)}</code>`,
    escapeHtml(summary),
    '',
    `Risk: <b>${escapeHtml(risk.level)}</b> — ${escapeHtml(risk.reason)}`,
  ];
  if (payload.repo) lines.push(`Repo: <code>${escapeHtml(payload.repo)}</code>`);
  // Truncate the RAW diff first, then escape — slicing escaped HTML can cut an
  // entity (e.g. "&lt;") in half and make Telegram reject the whole message.
  if (diff) lines.push('', '<b>Preview</b>', `<pre>${escapeHtml(String(diff).slice(0, 2400))}</pre>`);
  return lines.join('\n');
}

function summarizePayload(payload) {
  if (payload.type === 'create_issue') return `Create issue "${payload.title}" in ${payload.repo}.`;
  if (payload.type === 'update_issue') return `Update issue/PR #${payload.issueNumber} in ${payload.repo}.`;
  if (payload.type === 'comment_issue') return `Comment on issue/PR #${payload.issueNumber} in ${payload.repo}.`;
  if (payload.type === 'add_issue_labels') return `Add labels to issue/PR #${payload.issueNumber} in ${payload.repo}.`;
  if (payload.type === 'update_repo') return `Update repo metadata for ${payload.repo}.`;
  if (payload.type === 'replace_topics') return `Replace topics for ${payload.repo}.`;
  if (payload.type === 'update_file') return `Update ${payload.path} in ${payload.repo}.`;
  if (payload.type === 'create_branch') return `Create branch ${payload.branch} in ${payload.repo}.`;
  if (payload.type === 'create_pull_request') return `Open pull request "${payload.title}" in ${payload.repo}.`;
  if (payload.type === 'create_release') return `Create release ${payload.tagName} in ${payload.repo}.`;
  return `Run ${payload.type}.`;
}

module.exports = {
  requestApproval,
  handleApprovalDecision,
  executeApprovedAction,
  renderApprovalMessage,
  summarizePayload,
};
