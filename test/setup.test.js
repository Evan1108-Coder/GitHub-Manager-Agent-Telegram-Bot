const test = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeSideQuestion } = require('../src/setup');

test('setup recognizes side questions', () => {
  assert.equal(looksLikeSideQuestion('what is a profile repo?'), true);
  assert.equal(looksLikeSideQuestion('use default'), false);
});
