const test = require('node:test');
const assert = require('node:assert/strict');
const { GITHUB_COMMANDS, renderHelpMenu } = require('../src/bot');

test('all registered GitHub bot commands are one word with no underscores', () => {
  assert.ok(GITHUB_COMMANDS.length >= 15);
  for (const c of GITHUB_COMMANDS) {
    assert.match(c.command, /^[a-z][a-z0-9]*$/);
    assert.equal(c.command.includes('_'), false);
    assert.ok(c.description && c.description.length <= 256);
  }
});

test('help menu includes ability-focused commands', () => {
  const help = renderHelpMenu();
  for (const name of ['audit', 'stats', 'summary', 'trends', 'profile', 'readme', 'compare', 'schedule', 'watch']) {
    assert.match(help, new RegExp(`/${name}\\b`));
  }
  assert.doesNotMatch(help, /reset_setup/);
  assert.match(help, /Ability examples/);
});
