const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeAssistantText } = require('../src/llm/providers');

test('strips <think> reasoning blocks but keeps the real answer', () => {
  const raw = '<think>The user wants a greeting. I will say hi.</think>\n\nHello there!';
  assert.equal(sanitizeAssistantText(raw), 'Hello there!');
});

test('strips MiniMax tool-call markup that leaks into plain replies', () => {
  const raw = [
    'Let me check that for you.',
    '<minimax:tool_call>',
    '<invoke name="github_get_user">',
    '<parameter name="username">megan</parameter>',
    '</invoke>',
    '</minimax:tool_call>',
  ].join('\n');
  const out = sanitizeAssistantText(raw);
  assert.equal(out, 'Let me check that for you.');
  assert.ok(!/tool_call|invoke|parameter/i.test(out));
});

test('strips an unterminated tool-call block (truncated by token limit)', () => {
  const raw = 'Working on it.\n<minimax:tool_call>\n<invoke name="x">\n<parameter name="y">z';
  const out = sanitizeAssistantText(raw);
  assert.equal(out, 'Working on it.');
});

test('leaves ordinary text and angle brackets in prose untouched', () => {
  assert.equal(sanitizeAssistantText('Use a < b to compare.'), 'Use a < b to compare.');
  assert.equal(sanitizeAssistantText('  plain answer  '), 'plain answer');
  assert.equal(sanitizeAssistantText(null), '');
});
