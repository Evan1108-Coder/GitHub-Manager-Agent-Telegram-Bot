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

test('planner parses repo deletion as a gated destructive action', () => {
  const payload = parseGithubWriteRequest('delete repository example-user/repo');
  assert.equal(payload.dangerous, true);
  assert.equal(payload.type, 'delete_repo');
  assert.equal(payload.repo, 'example-user/repo');
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

test('planner parses destructive operations into gated payloads', () => {
  const branch = parseGithubWriteRequest('delete branch old in example-user/repo');
  assert.equal(branch.dangerous, true);
  assert.equal(branch.type, 'delete_branch');
  assert.equal(branch.branch, 'old');

  const file = parseGithubWriteRequest('delete file README.md in example-user/repo');
  assert.equal(file.dangerous, true);
  assert.equal(file.type, 'delete_file');
  assert.equal(file.path, 'README.md');

  const collab = parseGithubWriteRequest('add collaborator bob to example-user/repo');
  assert.equal(collab.dangerous, true);
  assert.equal(collab.type, 'add_collaborator');
  assert.equal(collab.username, 'bob');

  const remove = parseGithubWriteRequest('remove collaborator bob from example-user/repo');
  assert.equal(remove.dangerous, true);
  assert.equal(remove.type, 'remove_collaborator');
  assert.equal(remove.username, 'bob');

  const transfer = parseGithubWriteRequest('transfer example-user/repo to neworg');
  assert.equal(transfer.dangerous, true);
  assert.equal(transfer.type, 'transfer_repo');
  assert.equal(transfer.newOwner, 'neworg');
});

test('planner parses visibility changes regardless of word order', () => {
  const a = parseGithubWriteRequest('make repo example-user/repo private');
  assert.equal(a.dangerous, true);
  assert.equal(a.type, 'change_visibility');
  assert.equal(a.visibility, 'private');
  assert.equal(a.repo, 'example-user/repo');

  assert.equal(parseGithubWriteRequest('make example-user/repo private').type, 'change_visibility');
  assert.equal(parseGithubWriteRequest('change example-user/repo to a public repo').visibility, 'public');
  assert.equal(parseGithubWriteRequest('set example-user/repo visibility to private').type, 'change_visibility');
});

test('planner does not over-block benign uses of public/private', () => {
  // "public"/"private" near a slug but about an issue/release is not a
  // visibility change and must still parse normally.
  const issue = parseGithubWriteRequest('create issue in example-user/repo titled "Make API public"');
  assert.equal(issue.type, 'create_issue');
});

test('planner recognises destructive intent even without an explicit owner/repo slug', () => {
  const del = parseGithubWriteRequest('delete my repository');
  assert.equal(del.dangerous, true);
  assert.equal(del.type, 'delete_repo');
  assert.equal(del.repo, null);

  const transfer = parseGithubWriteRequest('transfer my repo');
  assert.equal(transfer.dangerous, true);
  assert.equal(transfer.type, 'transfer_repo');

  const vis = parseGithubWriteRequest('make it private');
  assert.equal(vis.dangerous, true);
  assert.equal(vis.type, 'change_visibility');
  assert.equal(vis.visibility, 'private');
});

test('planner does not turn a URL into an issue title', () => {
  const payload = parseGithubWriteRequest('create issue in example-user/repo: https://example.com/path:8080');
  assert.equal(payload.type, 'create_issue');
  assert.equal(payload.title, 'New issue');
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
