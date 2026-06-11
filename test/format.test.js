const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, chunkText } = require('../src/utils/format');

test('escapes Telegram HTML safely', () => {
  assert.equal(escapeHtml('<b>x&y</b>'), '&lt;b&gt;x&amp;y&lt;/b&gt;');
});

test('chunks long Telegram messages', () => {
  const chunks = chunkText('a '.repeat(5000), 1000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 1000));
});
