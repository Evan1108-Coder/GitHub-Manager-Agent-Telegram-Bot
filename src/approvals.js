const crypto = require('crypto');
const { InlineKeyboard } = require('grammy');
const { openDb } = require('./db');
const { GitHubClient } = require('./github/client');
const { escapeHtml } = require('./utils/format');
const { classifyAction, getSecurityGateConfig } = require('./security');

function createActionId() {
  return crypto.randomBytes(8).toString('hex');
}

async function requestApproval(ctx, payload, options = {}) {
  const risk = classifyAction(payload);

  // Env-gated destructive action that is currently disabled (flag off, or the
  // required password is missing) → refuse and say exactly how to enable it.
  if (risk.level === 'blocked') {
    return ctx.reply(renderBlockedMessage(payload, risk), { parse_mode: 'HTML', disable_web_page_preview: true });
  }

  // An enabled destructive action still needs a concrete repo to act on.
  if (risk.dangerous && !payload.repo) {
    return ctx.reply(
      '❓ <b>Which repository?</b>\nTell me the exact <code>owner/name</code> so I can prepare this action.',
      { parse_mode: 'HTML' },
    );
  }

  const actionId = createActionId();
  const summary = options.summary || summarizePayload(payload);
  openDb().prepare(`
    INSERT INTO approvals (chat_id, action_id, summary, payload_json, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(String(ctx.chat.id), actionId, summary, JSON.stringify(payload));

  return ctx.reply(renderApprovalMessage(actionId, summary, payload, risk, options.diff), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: buildKeyboard(actionId, risk, 'pending'),
  });
}

// The confirm keyboard. Non-dangerous and single-tap dangerous actions get a
// direct Approve. The most destructive ones (delete/transfer — the
// `needsPassword` ones) are two-step: first "arm", then a final unmistakable
// confirm, so a stray tap can never delete or transfer a repo.
function buildKeyboard(actionId, risk, status) {
  if (risk.dangerous && risk.needsPassword) {
    if (status === 'armed') {
      return new InlineKeyboard()
        .text(finalConfirmLabel(risk), `approval:confirm:${actionId}`)
        .text('❌ Cancel', `approval:cancel:${actionId}`);
    }
    return new InlineKeyboard()
      .text('⚠️ I understand — continue', `approval:arm:${actionId}`)
      .text('❌ Cancel', `approval:cancel:${actionId}`);
  }
  if (risk.dangerous) {
    return new InlineKeyboard()
      .text('✅ Yes, do it', `approval:approve:${actionId}`)
      .text('❌ Cancel', `approval:cancel:${actionId}`);
  }
  return new InlineKeyboard()
    .text('✅ Approve', `approval:approve:${actionId}`)
    .text('✏️ Edit', `approval:edit:${actionId}`)
    .text('❌ Cancel', `approval:cancel:${actionId}`);
}

function finalConfirmLabel(risk) {
  if (risk.actionType === 'delete_repo') return '🗑 Permanently DELETE';
  if (risk.actionType === 'transfer_repo') return '📦 Confirm TRANSFER';
  return '✅ Confirm';
}

async function handleApprovalDecision(ctx, deps = {}) {
  const data = ctx.callbackQuery.data || '';
  const [, action, actionId] = data.split(':');
  const row = openDb().prepare('SELECT * FROM approvals WHERE action_id = ?').get(actionId);
  if (!row) return ctx.answerCallbackQuery('Approval not found.');
  if (isExpired(row.created_at)) {
    openDb().prepare('UPDATE approvals SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE action_id = ?').run('expired', actionId);
    await ctx.editMessageText('⌛ <b>Approval expired.</b>\nPlease send the request again.', { parse_mode: 'HTML' }).catch(() => {});
    return ctx.answerCallbackQuery('Expired');
  }

  if (action === 'cancel') {
    if (row.status !== 'pending' && row.status !== 'armed') return ctx.answerCallbackQuery(`Already ${row.status}.`);
    openDb().prepare('UPDATE approvals SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE action_id = ?').run('cancelled', actionId);
    await ctx.editMessageText('❌ <b>Cancelled.</b>', { parse_mode: 'HTML' }).catch(() => {});
    return ctx.answerCallbackQuery('Cancelled');
  }

  if (action === 'edit') {
    if (row.status !== 'pending') return ctx.answerCallbackQuery(`Already ${row.status}.`);
    await ctx.answerCallbackQuery('Edit by sending a new instruction.');
    return ctx.reply('✏️ Send the corrected instruction and I’ll draft a new approval.', { parse_mode: 'HTML' });
  }

  const payload = JSON.parse(row.payload_json);

  // Arm step for the two-step destructive actions: move pending → armed and show
  // the final, unmistakable confirm button. Re-check the gate here too so an
  // action can't even be armed if it was just disabled.
  if (action === 'arm') {
    if (row.status !== 'pending') return ctx.answerCallbackQuery(`Already ${row.status}.`);
    const gate = getSecurityGateConfig();
    const recheck = classifyAction(payload, gate);
    if (recheck.level === 'blocked') return abortBlocked(ctx, actionId, payload, recheck);
    openDb().prepare('UPDATE approvals SET status = ? WHERE action_id = ?').run('armed', actionId);
    await ctx.editMessageText(renderFinalConfirm(payload, recheck), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: buildKeyboard(actionId, recheck, 'armed'),
    }).catch(() => {});
    return ctx.answerCallbackQuery('Confirm to proceed');
  }

  // Execute step — 'approve' (single-tap) or 'confirm' (final tap of two-step).
  if (action === 'approve' || action === 'confirm') {
    const needsArm = classifyAction(payload).needsPassword;
    // A two-step action must go through 'arm' → 'confirm'; reject a bare approve.
    if (action === 'approve' && needsArm) return ctx.answerCallbackQuery('Please use the confirm button.');
    if (action === 'confirm' && row.status !== 'armed') return ctx.answerCallbackQuery('Please arm it first.');
    if (action === 'approve' && row.status !== 'pending') return ctx.answerCallbackQuery(`Already ${row.status}.`);

    // HOT-RELOAD SAFETY: re-read the gate from .env at the moment of execution,
    // AFTER the user confirmed. If the flag was turned off (or the password
    // removed) since the card was shown, refuse now — never act on a stale gate.
    const gate = getSecurityGateConfig();
    const recheck = classifyAction(payload, gate);
    if (recheck.level === 'blocked') return abortBlocked(ctx, actionId, payload, recheck);

    try {
      const github = deps.github || new GitHubClient();
      const result = await executeApprovedAction(payload, github);
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

  return ctx.answerCallbackQuery();
}

async function abortBlocked(ctx, actionId, payload, risk) {
  openDb().prepare('UPDATE approvals SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE action_id = ?').run('blocked', actionId);
  await ctx.editMessageText(
    `${renderBlockedMessage(payload, risk)}\n\n<i>The setting changed before you confirmed, so I stopped without acting.</i>`,
    { parse_mode: 'HTML', disable_web_page_preview: true },
  ).catch(() => {});
  return ctx.answerCallbackQuery('Blocked — setting changed');
}

function isExpired(createdAt) {
  const ageMs = Date.now() - new Date(`${createdAt}Z`).getTime();
  return ageMs > 24 * 60 * 60 * 1000;
}

async function executeApprovedAction(payload, github = new GitHubClient()) {
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

  // --- Danger-zone actions (only reachable once the env gate + explicit
  // confirmation, re-checked in handleApprovalDecision, have passed). ---
  if (payload.type === 'change_visibility') {
    const repo = await github.setVisibility(payload.repo, payload.visibility);
    return { message: `Set ${payload.repo} to ${payload.visibility}.`, url: repo?.html_url };
  }
  if (payload.type === 'archive_repo') {
    const repo = await github.setArchived(payload.repo, true);
    return { message: `Archived ${payload.repo}.`, url: repo?.html_url };
  }
  if (payload.type === 'unarchive_repo') {
    const repo = await github.setArchived(payload.repo, false);
    return { message: `Unarchived ${payload.repo}.`, url: repo?.html_url };
  }
  if (payload.type === 'add_collaborator') {
    await github.addCollaborator(payload.repo, payload.username, payload.permission);
    return { message: `Invited ${payload.username} to ${payload.repo}${payload.permission ? ` (${payload.permission})` : ''}.` };
  }
  if (payload.type === 'remove_collaborator') {
    await github.removeCollaborator(payload.repo, payload.username);
    return { message: `Removed ${payload.username} from ${payload.repo}.` };
  }
  if (payload.type === 'delete_branch') {
    await github.deleteBranch(payload.repo, payload.branch);
    return { message: `Deleted branch ${payload.branch} in ${payload.repo}.` };
  }
  if (payload.type === 'delete_file') {
    const file = await github.getFile(payload.repo, payload.path, payload.branch);
    await github.deleteFile(payload.repo, payload.path, payload.message || `Delete ${payload.path}`, file.sha, payload.branch);
    return { message: `Deleted ${payload.path} in ${payload.repo}.` };
  }
  if (payload.type === 'delete_repo') {
    await github.deleteRepo(payload.repo);
    return { message: `Deleted repository ${payload.repo}.` };
  }
  if (payload.type === 'transfer_repo') {
    await github.transferRepo(payload.repo, payload.newOwner);
    return { message: `Requested transfer of ${payload.repo} to ${payload.newOwner}.` };
  }
  throw new Error(`Unsupported approved action type: ${payload.type}`);
}

function renderBlockedMessage(payload, risk) {
  if (!risk.gated) {
    return `🛑 <b>Blocked.</b>\n${escapeHtml(risk.reason)}`;
  }
  const target = payload.repo ? ` on <code>${escapeHtml(payload.repo)}</code>` : '';
  const lines = [
    '🛑 <b>Blocked — destructive action disabled.</b>',
    `Asking me to <b>${escapeHtml(risk.actionLabel)}</b>${target} is turned off by default to keep your repos safe.`,
    '',
    'To allow it, set this in the bot’s <code>.env</code>:',
    `<code>${escapeHtml(risk.envVar)}=true</code>`,
  ];
  if (risk.needsPassword) {
    lines.push(
      `<code>${escapeHtml(risk.passwordEnv)}=your-confirmation-secret</code>  <i>(required for delete/transfer)</i>`,
    );
  }
  lines.push(
    '',
    'You can edit <code>.env</code> while I’m running — I pick up the change automatically, no restart needed. Then just ask again, and I’ll <b>still confirm with you</b> before doing anything.',
  );
  return lines.join('\n');
}

function renderApprovalMessage(actionId, summary, payload, risk, diff) {
  const danger = risk.dangerous;
  const lines = [
    danger
      ? `⚠️ <b>DESTRUCTIVE action — please confirm</b> <code>${escapeHtml(actionId)}</code>`
      : `🧾 <b>Approval needed</b> <code>${escapeHtml(actionId)}</code>`,
    escapeHtml(summary),
    '',
    `Risk: <b>${escapeHtml(risk.level)}</b> — ${escapeHtml(risk.reason)}`,
  ];
  if (payload.repo) lines.push(`Repo: <code>${escapeHtml(payload.repo)}</code>`);
  if (danger) {
    lines.push('', '🔴 <b>This cannot be easily undone.</b> Read carefully before you confirm.');
    if (risk.needsPassword) lines.push('This is a high-impact action — you’ll get a second confirmation step.');
  }
  // Truncate the RAW diff first, then escape — slicing escaped HTML can cut an
  // entity (e.g. "&lt;") in half and make Telegram reject the whole message.
  if (diff) lines.push('', '<b>Preview</b>', `<pre>${escapeHtml(String(diff).slice(0, 2400))}</pre>`);
  return lines.join('\n');
}

function renderFinalConfirm(payload, risk) {
  return [
    `🔴 <b>FINAL CONFIRMATION</b>`,
    escapeHtml(summarizePayload(payload)),
    '',
    `You are about to <b>${escapeHtml(risk.actionLabel)}</b>${payload.repo ? ` on <code>${escapeHtml(payload.repo)}</code>` : ''}.`,
    'This is irreversible. Tap the confirm button only if you are absolutely sure.',
  ].join('\n');
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
  if (payload.type === 'change_visibility') return `Change ${payload.repo} visibility to ${payload.visibility}.`;
  if (payload.type === 'archive_repo') return `Archive ${payload.repo}.`;
  if (payload.type === 'unarchive_repo') return `Unarchive ${payload.repo}.`;
  if (payload.type === 'add_collaborator') return `Add ${payload.username || 'a collaborator'} to ${payload.repo}${payload.permission ? ` as ${payload.permission}` : ''}.`;
  if (payload.type === 'remove_collaborator') return `Remove ${payload.username || 'a collaborator'} from ${payload.repo}.`;
  if (payload.type === 'delete_branch') return `Delete branch ${payload.branch} in ${payload.repo}.`;
  if (payload.type === 'delete_file') return `Delete ${payload.path} in ${payload.repo}.`;
  if (payload.type === 'delete_repo') return `Delete repository ${payload.repo}.`;
  if (payload.type === 'transfer_repo') return `Transfer ${payload.repo} to ${payload.newOwner || 'a new owner'}.`;
  return `Run ${payload.type}.`;
}

module.exports = {
  requestApproval,
  handleApprovalDecision,
  executeApprovedAction,
  renderApprovalMessage,
  renderBlockedMessage,
  summarizePayload,
};
