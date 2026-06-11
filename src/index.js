require('dotenv').config();
const { createBot, validateStartupConfig } = require('./bot');
const { openDb } = require('./db');
const { getConfig } = require('./config');
const { startScheduler, seedDefaultJobs } = require('./scheduler');
const { executeJob } = require('./jobs');
const { chooseDefaultModel, getAvailableModels } = require('./llm/providers');

async function main() {
  const config = getConfig();
  validateStartupConfig();
  openDb();
  seedDefaultJobs();
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
