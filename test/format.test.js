const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, chunkText, mdToHtml } = require('../src/utils/format');

test('escapes Telegram HTML safely', () => {
  assert.equal(escapeHtml('<b>x&y</b>'), '&lt;b&gt;x&amp;y&lt;/b&gt;');
});

test('chunks long Telegram messages', () => {
  const chunks = chunkText('a '.repeat(5000), 1000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 1000));
});

// Minimal Telegram-style HTML checker: balanced allowed tags, no stray
// ampersands or angle brackets — mirrors what Telegram's parser would reject.
const ALLOWED = new Set(['b', 'i', 'u', 's', 'a', 'code', 'pre', 'tg-spoiler', 'blockquote']);
function htmlErrors(text) {
  const errors = [];
  if (/&(?!(amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);)/.test(text)) errors.push('stray &');
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z0-9-]+)([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(text))) {
    const tag = m[2].toLowerCase();
    if (!ALLOWED.has(tag)) { errors.push(`disallowed <${tag}>`); continue; }
    if (m[1] === '/') {
      if (!stack.length || stack[stack.length - 1] !== tag) errors.push(`unbalanced </${tag}>`);
      else stack.pop();
    } else stack.push(tag);
  }
  if (stack.length) errors.push(`unclosed <${stack.join(',')}>`);
  if (/[<>]/.test(text.replace(tagRe, ''))) errors.push('stray angle bracket');
  return errors;
}

test('mdToHtml converts the Markdown that LLMs emit into Telegram HTML', () => {
  assert.equal(mdToHtml('**bold**'), '<b>bold</b>');
  assert.equal(mdToHtml('*italic*'), '<i>italic</i>');
  assert.equal(mdToHtml('# Heading'), '<b>Heading</b>');
  assert.equal(mdToHtml('## Sub heading'), '<b>Sub heading</b>');
  assert.equal(mdToHtml('use `npm test` ok'), 'use <code>npm test</code> ok');
  assert.equal(mdToHtml('[GitHub](https://github.com)'), '<a href="https://github.com">GitHub</a>');
});

test('mdToHtml escapes special characters in text and code (no HTML injection)', () => {
  const out = mdToHtml('a < b & c > d and run `rm <x> & y`');
  assert.match(out, /&lt;/);
  assert.match(out, /&amp;/);
  assert.match(out, /<code>rm &lt;x&gt; &amp; y<\/code>/);
  assert.deepEqual(htmlErrors(out), []);
});

test('mdToHtml renders fenced code blocks as <pre> with escaped contents', () => {
  const out = mdToHtml('```js\nconst x = 1 < 2;\n```');
  assert.match(out, /<pre>const x = 1 &lt; 2;<\/pre>/);
  assert.deepEqual(htmlErrors(out), []);
});

test('mdToHtml always yields balanced Telegram-valid HTML, even on messy input', () => {
  const samples = [
    '', '   \n\t ',
    '**unterminated bold and *italic',
    '### \n#### only hashes ###',
    'a **b** c *d* e `f` g',
    'list:\n- one\n- two\n* three',
    'link [x](https://a.com/q?a=1&b=2) and <raw> tag & ampersand',
    '***triple*** and ****quad****',
    '# Title with <script>alert(1)</script> & symbols',
    'plain sentence, no markdown.',
    '`a` `b` `c`'.repeat(40),
  ];
  for (const s of samples) {
    assert.deepEqual(htmlErrors(mdToHtml(s)), [], `invalid HTML for ${JSON.stringify(s)}`);
  }
});

test('mdToHtml returns empty string for empty/whitespace/nullish input', () => {
  assert.equal(mdToHtml(''), '');
  assert.equal(mdToHtml('   \n  '), '');
  assert.equal(mdToHtml(null), '');
});
