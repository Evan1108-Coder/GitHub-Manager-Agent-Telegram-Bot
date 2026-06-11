const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'github-agent-test-'));
process.env.DB_PATH = path.join(tmp, 'test.sqlite');
process.env.GITHUB_USERNAME = 'example-user';
process.env.TELEGRAM_CHAT_ID = '123';

const { handleText } = require('../src/agent');
const { listScheduledJobs } = require('../src/scheduler');
const { openDb } = require('../src/db');

function fakeCtx() {
  const replies = [];
  return {
    chat: { id: 123 },
    replies,
    reply: async (text) => {
      replies.push(text);
      return { text };
    },
  };
}

test('agent schedules complex natural recurring task', async () => {
  openDb();
  const ctx = fakeCtx();
  await handleText(ctx, 'every 97 minutes tell me the stars of example-user/repo-a plus example-user/repo-b');
  assert.ok(ctx.replies[0].includes('Scheduled it'));
  const jobs = listScheduledJobs();
  assert.equal(jobs.length, 1);
  assert.equal(JSON.parse(jobs[0].schedule_json).everyMinutes, 97);
});

test('agent lists jobs', async () => {
  const ctx = fakeCtx();
  await handleText(ctx, 'show jobs');
  assert.ok(ctx.replies.join('\n').includes('Scheduled Jobs'));
});
