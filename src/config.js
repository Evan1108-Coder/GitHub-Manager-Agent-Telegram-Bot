const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getConfig() {
  ensureDataDir();
  return {
    rootDir: ROOT_DIR,
    dataDir: DATA_DIR,
    dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'agent.sqlite'),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    githubToken: process.env.GITHUB_TOKEN || '',
    githubUsername: process.env.GITHUB_USERNAME || '',
    githubProfileRepo: process.env.GITHUB_PROFILE_REPO || '',
    defaultTimezone: process.env.DEFAULT_TIMEZONE || 'UTC',
    defaultModel: process.env.DEFAULT_MODEL || '',
    notificationLevel: process.env.NOTIFICATION_LEVEL || 'normal',
    enableDefaultJobs: bool(process.env.ENABLE_DEFAULT_JOBS, false),
    autoApplyLowRiskProfileUpdates: bool(process.env.AUTO_APPLY_LOW_RISK_PROFILE_UPDATES, false),
    autoCreateProfileBlocks: bool(process.env.AUTO_CREATE_PROFILE_BLOCKS, false),
    modelPricingUrl: process.env.MODEL_PRICING_URL || '',
    apiKeys: {
      openai: process.env.OPENAI_API_KEY || '',
      anthropic: process.env.ANTHROPIC_API_KEY || '',
      google: process.env.GOOGLE_API_KEY || '',
      together: process.env.TOGETHER_API_KEY || '',
      minimax: process.env.MINIMAX_API_KEY || '',
    },
  };
}

function envStatus(config = getConfig()) {
  return {
    TELEGRAM_BOT_TOKEN: Boolean(config.telegramToken),
    TELEGRAM_CHAT_ID: Boolean(config.telegramChatId),
    GITHUB_TOKEN: Boolean(config.githubToken),
    GITHUB_USERNAME: Boolean(config.githubUsername),
    GITHUB_PROFILE_REPO: Boolean(config.githubProfileRepo),
    DEFAULT_TIMEZONE: Boolean(config.defaultTimezone),
    DEFAULT_MODEL: Boolean(config.defaultModel),
    OPENAI_API_KEY: Boolean(config.apiKeys.openai),
    ANTHROPIC_API_KEY: Boolean(config.apiKeys.anthropic),
    GOOGLE_API_KEY: Boolean(config.apiKeys.google),
    TOGETHER_API_KEY: Boolean(config.apiKeys.together),
    MINIMAX_API_KEY: Boolean(config.apiKeys.minimax),
  };
}

module.exports = { getConfig, envStatus, bool };
