const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GITHUB_USERNAME = 'example-user';

const { parseGithubWriteRequest, parseGithubReadRequest } = require('../src/planner');
const { replaceLine } = require('../src/utils/diff');

test('planner parses issue creation', () => {
  const payload = parseGithubWriteRequest('create issue in example-user/repo titled "Fix docs" body "Add setup section"');
  assert.equal(payload.type, 'create_issue');
  assert.equal(payload.repo, 'example-user/repo');
  assert.equal(payload.title, 'Fix docs');
  assert.equal(payload.body, 'Add setup section');
});

test('planner blocks repo deletion', () => {
  const payload = parseGithubWriteRequest('delete repository example-user/repo');
  assert.equal(payload.blocked, true);
});

test('planner parses repo description update', () => {
  const payload = parseGithubWriteRequest('change description of example-user/repo to "A better repo description"');
  assert.equal(payload.type, 'update_repo');
  assert.equal(payload.update.description, 'A better repo description');
});

test('planner parses topic updates cleanly', () => {
  const payload = parseGithubWriteRequest('set topics of example-user/repo to telegram github-agent automation');
  assert.equal(payload.type, 'replace_topics');
  assert.deepEqual(payload.topics, ['telegram', 'github-agent', 'automation']);
});

test('planner parses line edit request', () => {
  const payload = parseGithubWriteRequest('change line 3 of file "src/index.js" in example-user/repo to "console.log(1)"');
  assert.equal(payload.type, 'line_edit_request');
  assert.equal(payload.path, 'src/index.js');
  assert.equal(payload.lineNumber, 3);
});

test('planner parses whole-file update request', () => {
  const payload = parseGithubWriteRequest('replace file "README.md" in example-user/repo with "# New README"');
  assert.equal(payload.type, 'file_update_request');
  assert.equal(payload.path, 'README.md');
  assert.equal(payload.content, '# New README');
});

test('planner parses issue close and label updates', () => {
  const close = parseGithubWriteRequest('close issue #12 in example-user/repo');
  assert.equal(close.type, 'update_issue');
  assert.equal(close.issueNumber, 12);
  assert.equal(close.update.state, 'closed');

  const labels = parseGithubWriteRequest('add labels bug docs to issue #12 in example-user/repo');
  assert.equal(labels.type, 'add_issue_labels');
  assert.deepEqual(labels.labels, ['bug', 'docs']);
});

test('planner parses branch, PR, release, comment, and workflow actions', () => {
  assert.equal(parseGithubWriteRequest('create branch fix-readme in example-user/repo from main').type, 'create_branch');
  assert.equal(parseGithubWriteRequest('open PR in example-user/repo from fix-readme to main titled "Fix README"').type, 'create_pull_request');
  assert.equal(parseGithubWriteRequest('create release in example-user/repo tag v1.0.0 titled "v1"').type, 'create_release');
  assert.equal(parseGithubWriteRequest('comment on issue #3 in example-user/repo "Looks good"').type, 'comment_issue');
  assert.equal(parseGithubWriteRequest('rerun workflow run 123 in example-user/repo').type, 'rerun_workflow');
});

test('planner blocks destructive operations', () => {
  assert.equal(parseGithubWriteRequest('delete branch old in example-user/repo').blocked, true);
  assert.equal(parseGithubWriteRequest('delete file README.md in example-user/repo').blocked, true);
  assert.equal(parseGithubWriteRequest('add collaborator bob to example-user/repo').blocked, true);
});

test('planner parses read request', () => {
  const payload = parseGithubReadRequest('show open PRs in example-user/repo');
  assert.equal(payload.kind, 'list_prs');
});

test('line replacement creates diff', () => {
  const result = replaceLine('a\nb\nc', 2, 'B');
  assert.equal(result.content, 'a\nB\nc');
  assert.ok(result.diff.includes('- b'));
  assert.ok(result.diff.includes('+ B'));
});
