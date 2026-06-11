const test = require('node:test');
const assert = require('node:assert/strict');
const { auditRepoPresentation, suspiciousCommitMessages } = require('../src/github/audit');

test('flags weak public repo presentation', () => {
  const findings = auditRepoPresentation({ description: '', topics: [], homepage: '', license: null }, '# Tiny');
  assert.ok(findings.some(f => f.message.includes('description')));
  assert.ok(findings.some(f => f.message.includes('README')));
});

test('detects suspicious commit messages', () => {
  const commits = suspiciousCommitMessages([
    { sha: '123456789', html_url: 'https://example.com', commit: { message: 'fix' } },
    { sha: 'abcdefghi', html_url: 'https://example.com', commit: { message: 'Add onboarding setup flow' } },
  ]);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].sha, '1234567');
});
