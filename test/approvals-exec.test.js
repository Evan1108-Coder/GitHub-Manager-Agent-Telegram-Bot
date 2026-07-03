const test = require('node:test');
const assert = require('node:assert/strict');
const { executeApprovedAction } = require('../src/approvals');

// A fully mocked GitHub client that records calls and NEVER hits the network, so
// "approve → executes" is proven without performing a single real destructive
// GitHub operation.
function recorder() {
  const calls = [];
  const client = new Proxy({}, {
    get: (_t, name) => async (...args) => {
      calls.push([name, args]);
      if (name === 'getFile') return { sha: 'sha123', path: args[1] };
      return { html_url: 'https://example.test', number: 1 };
    },
  });
  return { client, calls };
}

test('change_visibility → setVisibility(repo, visibility)', async () => {
  const { client, calls } = recorder();
  const r = await executeApprovedAction({ type: 'change_visibility', repo: 'a/b', visibility: 'private' }, client);
  assert.deepEqual(calls[0], ['setVisibility', ['a/b', 'private']]);
  assert.match(r.message, /private/);
});

test('archive_repo → setArchived(repo, true)', async () => {
  const { client, calls } = recorder();
  await executeApprovedAction({ type: 'archive_repo', repo: 'a/b' }, client);
  assert.deepEqual(calls[0], ['setArchived', ['a/b', true]]);
});

test('add_collaborator → addCollaborator(repo, user, permission)', async () => {
  const { client, calls } = recorder();
  await executeApprovedAction({ type: 'add_collaborator', repo: 'a/b', username: 'bob', permission: 'push' }, client);
  assert.deepEqual(calls[0], ['addCollaborator', ['a/b', 'bob', 'push']]);
});

test('remove_collaborator → removeCollaborator(repo, user)', async () => {
  const { client, calls } = recorder();
  await executeApprovedAction({ type: 'remove_collaborator', repo: 'a/b', username: 'bob' }, client);
  assert.deepEqual(calls[0], ['removeCollaborator', ['a/b', 'bob']]);
});

test('delete_branch → deleteBranch(repo, branch)', async () => {
  const { client, calls } = recorder();
  await executeApprovedAction({ type: 'delete_branch', repo: 'a/b', branch: 'old' }, client);
  assert.deepEqual(calls[0], ['deleteBranch', ['a/b', 'old']]);
});

test('delete_file fetches the sha, then deletes', async () => {
  const { client, calls } = recorder();
  await executeApprovedAction({ type: 'delete_file', repo: 'a/b', path: 'x.txt' }, client);
  assert.equal(calls[0][0], 'getFile');
  assert.equal(calls[1][0], 'deleteFile');
  assert.equal(calls[1][1][3], 'sha123', 'uses the fetched sha');
});

test('transfer_repo → transferRepo(repo, newOwner)', async () => {
  const { client, calls } = recorder();
  await executeApprovedAction({ type: 'transfer_repo', repo: 'a/b', newOwner: 'neworg' }, client);
  assert.deepEqual(calls[0], ['transferRepo', ['a/b', 'neworg']]);
});

test('delete_repo → deleteRepo(repo)', async () => {
  const { client, calls } = recorder();
  await executeApprovedAction({ type: 'delete_repo', repo: 'a/b' }, client);
  assert.deepEqual(calls[0], ['deleteRepo', ['a/b']]);
});
