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
  assert.ok(ctx.replies[0].includes('Scheduled'));
  const jobs = listScheduledJobs();
  assert.equal(jobs.length, 1);
  assert.equal(JSON.parse(jobs[0].schedule_json).everyMinutes, 97);
});

test('agent creates helper job for earlier metric snapshots', async () => {
  const ctx = fakeCtx();
  await handleText(ctx, 'every Monday at 9 compare stars for example-user/repo-a 5 minutes earlier than now');
  const jobs = listScheduledJobs();
  assert.ok(jobs.some(job => JSON.parse(job.plan_json).kind === 'snapshot_metric'));
  assert.ok(ctx.replies[0].includes('helper job'));
});

test('agent lists jobs', async () => {
  const ctx = fakeCtx();
  await handleText(ctx, 'show jobs');
  assert.ok(ctx.replies.join('\n').includes('Scheduled Jobs'));
});

test('agent can pause scheduled jobs naturally', async () => {
  const ctx = fakeCtx();
  await handleText(ctx, 'pause job 1');
  assert.ok(ctx.replies[0].includes('Paused job #1'));
});

test('agent can edit a scheduled job time naturally', async () => {
  const ctx = fakeCtx();
  await handleText(ctx, 'move job #1 to 8:15 AM');
  assert.ok(ctx.replies[0].includes('Updated job #1'));
});

test('agent creates approval for issue creation', async () => {
  const ctx = fakeCtx();
  await handleText(ctx, 'create issue in example-user/repo titled "Fix docs" body "Add setup section"');
  assert.ok(ctx.replies[0].includes('Approval needed'));
});

test('agent creates approval from latest uploaded file', async () => {
  openDb().prepare(`
    INSERT INTO uploaded_files (chat_id, telegram_file_id, file_name, file_type, extracted_text, summary)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('123', 'file-id', 'notes.md', 'text', 'The README install section is missing.', 'README notes');
  const ctx = fakeCtx();
  await handleText(ctx, 'create issue from uploaded file in example-user/repo');
  assert.ok(ctx.replies[0].includes('Approval needed'));
  assert.ok(ctx.replies[0].includes('latest uploaded file'));
});

test('agent blocks dangerous repo deletion', async () => {
  const ctx = fakeCtx();
  await handleText(ctx, 'delete repository example-user/repo');
  assert.ok(ctx.replies[0].includes('Blocked'));
});

test('agent stores verbosity preference', async () => {
  const ctx = fakeCtx();
  await handleText(ctx, 'set verbosity to quick');
  assert.ok(ctx.replies[0].includes('Verbosity updated'));
});

test('the broad status catch-all does not shadow a more specific intent', async () => {
  // "response time" + the word "status" must reach the telemetry handler, not
  // the generic Bot Status screen (regression for the routing-precedence bug).
  const ctx = fakeCtx();
  await handleText(ctx, 'show me response time status');
  const out = ctx.replies.join('\n');
  assert.ok(out.includes('📈'), `expected telemetry reply, got: ${out}`);
  assert.ok(!out.includes('Bot Status'));
});

test('explicit bot status command still shows the operational screen', async () => {
  const ctx = fakeCtx();
  await handleText(ctx, 'bot status');
  assert.ok(ctx.replies.join('\n').includes('Bot Status'));
});
