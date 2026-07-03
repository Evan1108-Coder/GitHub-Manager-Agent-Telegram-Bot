const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate this file: its own temp sqlite DB and its own temp .env that we toggle
// to drive the security gate. Both must be set BEFORE the modules load.
const ENV_FILE = path.join(os.tmpdir(), `ghagent-approvals-env-${process.pid}.env`);
process.env.GHAGENT_ENV_PATH = ENV_FILE;
process.env.DB_PATH = path.join(os.tmpdir(), `ghagent-approvals-${process.pid}.sqlite`);

const { requestApproval, handleApprovalDecision } = require('../src/approvals');
const { openDb } = require('../src/db');

function writeEnv(contents) {
  fs.writeFileSync(ENV_FILE, contents);
}

function makeCtx(chatId = 123) {
  const calls = { replies: [], edits: [], answers: [] };
  return {
    chat: { id: chatId },
    reply: async (text, opts) => { calls.replies.push({ text, opts }); return { message_id: 1 }; },
    _calls: calls,
  };
}

function makeCallbackCtx(data, chatId = 123) {
  const calls = { edits: [], answers: [] };
  return {
    chat: { id: chatId },
    callbackQuery: { data },
    editMessageText: async (text, opts) => { calls.edits.push({ text, opts }); },
    answerCallbackQuery: async (t) => { calls.answers.push(t); },
    _calls: calls,
  };
}

function actionIdFromKeyboard(kb) {
  for (const row of kb.inline_keyboard) {
    for (const b of row) {
      if (b.callback_data && b.callback_data.startsWith('approval:')) return b.callback_data.split(':')[2];
    }
  }
  return null;
}

function firstCallback(kb) {
  return kb.inline_keyboard[0][0].callback_data;
}

function countApprovals() {
  return openDb().prepare('SELECT COUNT(*) c FROM approvals').get().c;
}

test('requestApproval refuses a destructive action when disabled, and names the env var', async () => {
  writeEnv('ALLOW_DESTRUCTIVE_REPO_ACTIONS=false\n');
  const before = countApprovals();
  const ctx = makeCtx();
  await requestApproval(ctx, { type: 'change_visibility', repo: 'a/b', visibility: 'private' });
  const reply = ctx._calls.replies[0].text;
  assert.match(reply, /disabled/i);
  assert.match(reply, /ALLOW_DESTRUCTIVE_REPO_ACTIONS/);
  assert.equal(countApprovals(), before, 'no approval row should be written when blocked');
});

test('requestApproval builds a confirmation card when enabled (no execution yet)', async () => {
  writeEnv('ALLOW_DESTRUCTIVE_REPO_ACTIONS=true\n');
  const before = countApprovals();
  const ctx = makeCtx();
  await requestApproval(ctx, { type: 'change_visibility', repo: 'a/b', visibility: 'private' });
  const { text, opts } = ctx._calls.replies[0];
  assert.match(text, /confirm/i);
  assert.ok(opts.reply_markup, 'a confirm keyboard is attached');
  assert.equal(countApprovals(), before + 1, 'a pending approval row is created');
});

test('approving an enabled visibility change executes via the injected client only', async () => {
  writeEnv('ALLOW_DESTRUCTIVE_REPO_ACTIONS=true\n');
  const ctx = makeCtx();
  await requestApproval(ctx, { type: 'change_visibility', repo: 'a/b', visibility: 'private' });
  const actionId = actionIdFromKeyboard(ctx._calls.replies[0].opts.reply_markup);

  const called = [];
  const fakeGithub = { setVisibility: async (repo, vis) => { called.push([repo, vis]); return { html_url: 'https://x' }; } };
  await handleApprovalDecision(makeCallbackCtx(`approval:approve:${actionId}`), { github: fakeGithub });

  assert.deepEqual(called, [['a/b', 'private']]);
  const row = openDb().prepare('SELECT status FROM approvals WHERE action_id = ?').get(actionId);
  assert.equal(row.status, 'approved');
});

test('a flag turned OFF after the card is shown aborts execution (hot-reload re-check)', async () => {
  writeEnv('ALLOW_DESTRUCTIVE_REPO_ACTIONS=true\n');
  const ctx = makeCtx();
  await requestApproval(ctx, { type: 'change_visibility', repo: 'a/b', visibility: 'private' });
  const actionId = actionIdFromKeyboard(ctx._calls.replies[0].opts.reply_markup);

  // Owner disables destructive actions in .env before tapping confirm.
  writeEnv('ALLOW_DESTRUCTIVE_REPO_ACTIONS=false\n');

  let called = false;
  const fakeGithub = { setVisibility: async () => { called = true; } };
  await handleApprovalDecision(makeCallbackCtx(`approval:approve:${actionId}`), { github: fakeGithub });

  assert.equal(called, false, 'must not execute once the flag is off');
  const row = openDb().prepare('SELECT status FROM approvals WHERE action_id = ?').get(actionId);
  assert.equal(row.status, 'blocked');
});

test('delete is refused without the password env, even when the flag is on', async () => {
  writeEnv('ALLOW_DESTRUCTIVE_REPO_ACTIONS=true\n'); // no GITHUB_PASSWORD
  const before = countApprovals();
  const ctx = makeCtx();
  await requestApproval(ctx, { type: 'delete_repo', repo: 'a/b' });
  assert.match(ctx._calls.replies[0].text, /GITHUB_PASSWORD/);
  assert.equal(countApprovals(), before, 'no card when the password is missing');
});

test('delete with flag+password is two-step (arm→confirm) and a bare approve cannot delete', async () => {
  writeEnv('ALLOW_DESTRUCTIVE_REPO_ACTIONS=true\nGITHUB_PASSWORD=s3cret\n');
  const ctx = makeCtx();
  await requestApproval(ctx, { type: 'delete_repo', repo: 'a/b' });
  const kb0 = ctx._calls.replies[0].opts.reply_markup;
  const actionId = actionIdFromKeyboard(kb0);
  assert.match(firstCallback(kb0), /^approval:arm:/, 'first tap must arm, not approve');

  const deleted = [];
  const fakeGithub = { deleteRepo: async (r) => { deleted.push(r); } };

  // A bare approve on a two-step action must NOT delete.
  await handleApprovalDecision(makeCallbackCtx(`approval:approve:${actionId}`), { github: fakeGithub });
  assert.equal(deleted.length, 0);

  // Proper path: arm, then confirm.
  await handleApprovalDecision(makeCallbackCtx(`approval:arm:${actionId}`), { github: fakeGithub });
  await handleApprovalDecision(makeCallbackCtx(`approval:confirm:${actionId}`), { github: fakeGithub });
  assert.deepEqual(deleted, ['a/b']);

  const row = openDb().prepare('SELECT status FROM approvals WHERE action_id = ?').get(actionId);
  assert.equal(row.status, 'approved');
});

test('cancelling a destructive card never executes', async () => {
  writeEnv('ALLOW_DESTRUCTIVE_REPO_ACTIONS=true\n');
  const ctx = makeCtx();
  await requestApproval(ctx, { type: 'archive_repo', repo: 'a/b' });
  const actionId = actionIdFromKeyboard(ctx._calls.replies[0].opts.reply_markup);
  let called = false;
  const fakeGithub = { setArchived: async () => { called = true; } };
  await handleApprovalDecision(makeCallbackCtx(`approval:cancel:${actionId}`), { github: fakeGithub });
  assert.equal(called, false);
  const row = openDb().prepare('SELECT status FROM approvals WHERE action_id = ?').get(actionId);
  assert.equal(row.status, 'cancelled');
});

test.after(() => { try { fs.unlinkSync(ENV_FILE); } catch {} });
