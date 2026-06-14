const test = require('node:test');
const assert = require('node:assert/strict');
const { renderApprovalMessage } = require('../src/approvals');

test('approval preview never truncates an HTML entity', () => {
  // A long diff full of "<" so escaping yields many "&lt;" entities. If the
  // code sliced the escaped string it could cut "&lt;" mid-entity and Telegram
  // would reject the message. The rendered preview must contain only complete
  // entities.
  const diff = '<'.repeat(5000);
  const risk = { level: 'approval', reason: 'GitHub write action.' };
  const message = renderApprovalMessage('abc123', 'Update file', { repo: 'a/b' }, risk, diff);
  const pre = message.match(/<pre>([\s\S]*)<\/pre>/)[1];
  // No dangling ampersand without a terminating ';'
  assert.ok(!/&(?!(amp|lt|gt|quot);)/.test(pre), 'preview contains a broken HTML entity');
  // And it should actually have been truncated to a safe length.
  assert.ok(pre.length <= 2400 * 4);
});
