const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'github-agent-model-test-'));
process.env.DB_PATH = path.join(tmp, 'test.sqlite');
process.env.MINIMAX_API_KEY = 'fake';

const { setSetting, openDb } = require('../src/db');
const { chooseDefaultModel } = require('../src/llm/providers');

test('runtime model preference overrides cheapest fallback', () => {
  openDb();
  setSetting('default_model', 'minimax-m2.7');
  assert.equal(chooseDefaultModel(), 'minimax-m2.7');
});
