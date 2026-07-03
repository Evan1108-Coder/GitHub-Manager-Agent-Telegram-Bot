const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// Own temp DB so we can seed conversations/settings without touching real data.
process.env.DB_PATH = path.join(os.tmpdir(), `ghagent-jobs-${process.pid}.sqlite`);

const { resolveOwnerChatId } = require('../src/jobs');
const { openDb, setSetting, addConversation } = require('../src/db');

function clear() {
  openDb().prepare("DELETE FROM settings WHERE key = 'owner_chat_id'").run();
  openDb().prepare('DELETE FROM conversations').run();
}

test('a real numeric TELEGRAM_CHAT_ID override wins', () => {
  clear();
  assert.equal(resolveOwnerChatId({ telegramChatId: '8707359629' }), '8707359629');
});

test('a bot token pasted as the chat id is ignored (not a numeric chat id)', () => {
  clear();
  // Exactly the mistake to guard against: pasting "<botId>:AAF..." as the chat id.
  const r = resolveOwnerChatId({ telegramChatId: '7529071262:AAFabcDEF' });
  assert.notEqual(r, '7529071262:AAFabcDEF');
  assert.equal(r, null, 'with nothing else known, it resolves to null rather than the token');
});

test('falls back to the saved owner_chat_id setting', () => {
  clear();
  setSetting('owner_chat_id', '111222');
  assert.equal(resolveOwnerChatId({ telegramChatId: '' }), '111222');
});

test('derives the chat id from the latest conversation and remembers it', () => {
  clear();
  addConversation('999888', 'user', 'hi');
  assert.equal(resolveOwnerChatId({ telegramChatId: '' }), '999888');
  const row = openDb().prepare("SELECT value FROM settings WHERE key = 'owner_chat_id'").get();
  assert.equal(JSON.parse(row.value), '999888', 'auto-captured for next time');
});

test('returns null when the bot has never been messaged and no override is set', () => {
  clear();
  assert.equal(resolveOwnerChatId({ telegramChatId: '' }), null);
});
