require('dotenv').config();
const fs = require('fs');
const { createBot, validateStartupConfig } = require('./bot');
const { openDb } = require('./db');
const { getConfig, refreshEnvFromDisk, envPath } = require('./config');
const { startScheduler, seedDefaultJobs } = require('./scheduler');
const { executeJob } = require('./jobs');
const { chooseDefaultModel, getAvailableModels } = require('./llm/providers');

// Pick up edits to .env while the bot is running, so config changes (timezone,
// model, feature flags, credentials, …) take effect without a restart. The
// security gate additionally re-reads .env at the exact moment a destructive
// action executes, so even a mid-action change is honoured.
function watchEnvFile() {
  const file = envPath();
  try {
    fs.watch(file, { persistent: false }, () => {
      try {
        refreshEnvFromDisk(file);
        console.log('[Config] Reloaded .env after a change on disk.');
      } catch (err) {
        console.error('[Config] Failed to reload .env:', err.message);
      }
    });
  } catch (err) {
    // No watchable .env (e.g. env injected by the process manager) — fine.
  }
}

async function main() {
  const config = getConfig();
  validateStartupConfig();
  openDb();
  seedDefaultJobs();
  watchEnvFile();
  const bot = createBot(config.telegramToken);
  startScheduler(bot, executeJob);
  await bot.start({
    onStart: info => {
      console.log(`GitHub Manager Agent running as @${info.username}`);
      console.log(`Available models: ${getAvailableModels(config).length}`);
      console.log(`Default model: ${chooseDefaultModel(config) || 'none'}`);
      console.log(`Timezone: ${config.defaultTimezone}`);
    },
  });
}

main().catch(err => {
  console.error('[Fatal]', err);
  process.exit(1);
});
