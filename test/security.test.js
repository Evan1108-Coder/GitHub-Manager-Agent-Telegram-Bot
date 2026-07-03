const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyAction, DANGEROUS_ACTIONS, FLAG_ENV, PASSWORD_ENV } = require('../src/security');
const { getSecurityGateConfig } = require('../src/config');

const OFF = { allowDestructive: false, dangerPassword: '' };
const ON = { allowDestructive: true, dangerPassword: '' };
const ON_PW = { allowDestructive: true, dangerPassword: 'secret' };

test('every destructive action is blocked by default and names the enabling env var', () => {
  for (const type of Object.keys(DANGEROUS_ACTIONS)) {
    const r = classifyAction({ type, repo: 'a/b' }, OFF);
    assert.equal(r.level, 'blocked', `${type} must be blocked when the flag is off`);
    assert.equal(r.dangerous, true);
    assert.equal(r.envVar, FLAG_ENV);
    assert.ok(r.actionLabel, 'has a human label for the message');
  }
});

test('visibility change is recognised as destructive — not read-only (fixes prior bug)', () => {
  const r = classifyAction({ type: 'change_visibility', repo: 'a/b', visibility: 'private' }, OFF);
  assert.equal(r.level, 'blocked');
  assert.equal(r.dangerous, true);
});

test('flag ON: a non-password destructive action still requires confirmation (never auto-runs)', () => {
  const r = classifyAction({ type: 'change_visibility', repo: 'a/b', visibility: 'private' }, ON);
  assert.equal(r.level, 'destructive_confirm');
  assert.equal(r.needsPassword, false);
});

test('flag ON but no password: delete/transfer stay blocked and name the password env var', () => {
  const del = classifyAction({ type: 'delete_repo', repo: 'a/b' }, ON);
  assert.equal(del.level, 'blocked');
  assert.equal(del.missingPassword, true);
  assert.equal(del.passwordEnv, PASSWORD_ENV);

  const tr = classifyAction({ type: 'transfer_repo', repo: 'a/b', newOwner: 'x' }, ON);
  assert.equal(tr.level, 'blocked');
  assert.equal(tr.passwordEnv, PASSWORD_ENV);
});

test('flag ON + password present: delete/transfer are allowed but still need confirmation', () => {
  const del = classifyAction({ type: 'delete_repo', repo: 'a/b' }, ON_PW);
  assert.equal(del.level, 'destructive_confirm');
  assert.equal(del.needsPassword, true);
});

test('benign write/read actions are unaffected by the gate', () => {
  assert.equal(classifyAction({ type: 'create_issue', repo: 'a/b' }, OFF).level, 'approval');
  assert.equal(classifyAction({ type: 'add_issue_labels', repo: 'a/b' }, OFF).level, 'approval');
  assert.equal(classifyAction({ type: 'list_issues', repo: 'a/b' }, OFF).level, 'read');
  assert.equal(classifyAction({ type: 'create_release', repo: 'a/b' }, OFF).level, 'strict_approval');
});

test('invalid payloads are blocked', () => {
  assert.equal(classifyAction(null).level, 'blocked');
  assert.equal(classifyAction({}).level, 'blocked');
});

test('getSecurityGateConfig hot-reloads when the .env file changes on disk', () => {
  const p = path.join(os.tmpdir(), `ghagent-hot-${process.pid}.env`);
  fs.writeFileSync(p, 'ALLOW_DESTRUCTIVE_REPO_ACTIONS=false\n');
  assert.equal(getSecurityGateConfig(p).allowDestructive, false);

  fs.writeFileSync(p, 'ALLOW_DESTRUCTIVE_REPO_ACTIONS=true\nGITHUB_PASSWORD=hunter2\n');
  const g = getSecurityGateConfig(p);
  assert.equal(g.allowDestructive, true);
  assert.equal(g.dangerPassword, 'hunter2');

  // Removing the line = disabled again (the file is authoritative when present).
  fs.writeFileSync(p, 'SOMETHING_ELSE=1\n');
  assert.equal(getSecurityGateConfig(p).allowDestructive, false);
  fs.unlinkSync(p);
});

test('classifyAction end-to-end honours a live .env toggle (read fresh each time)', () => {
  const p = path.join(os.tmpdir(), `ghagent-e2e-${process.pid}.env`);
  const prev = process.env.GHAGENT_ENV_PATH;
  try {
    process.env.GHAGENT_ENV_PATH = p;
    fs.writeFileSync(p, 'ALLOW_DESTRUCTIVE_REPO_ACTIONS=false\n');
    assert.equal(classifyAction({ type: 'change_visibility', repo: 'a/b', visibility: 'private' }).level, 'blocked');
    fs.writeFileSync(p, 'ALLOW_DESTRUCTIVE_REPO_ACTIONS=true\n');
    assert.equal(classifyAction({ type: 'change_visibility', repo: 'a/b', visibility: 'private' }).level, 'destructive_confirm');
  } finally {
    if (prev === undefined) delete process.env.GHAGENT_ENV_PATH;
    else process.env.GHAGENT_ENV_PATH = prev;
    try { fs.unlinkSync(p); } catch {}
  }
});
