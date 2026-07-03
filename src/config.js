const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const ENV_PATH = path.join(ROOT_DIR, '.env');

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// The path we read the .env from. Overridable (mainly for tests) via env var so
// the security gate and hot-reload can be exercised against a temp file without
// touching the real .env.
function envPath() {
  return process.env.GHAGENT_ENV_PATH || ENV_PATH;
}

// Parse the .env file straight off disk without mutating process.env. Returns
// null when the file is absent (e.g. under test, or when the process manager
// injects the environment directly). Used for decisions that must reflect the
// CURRENT contents of .env even if it was edited after boot.
function parseEnvFile(file = envPath()) {
  try {
    return dotenv.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Re-read .env from disk and merge it into process.env (overriding stale boot
// values). This is what lets edits to .env be picked up while the bot is running
// — call it on an fs.watch change and right before actions that read config.
// Returns the freshly parsed object ({} when there is no file).
function refreshEnvFromDisk(file = envPath()) {
  const parsed = parseEnvFile(file);
  if (parsed) {
    for (const [key, value] of Object.entries(parsed)) process.env[key] = value;
  }
  return parsed || {};
}

// Fresh read of ONLY the destructive-action gate + credential, straight from the
// .env file on disk (so it hot-reloads and honours a removed line = disabled).
// When the file is present it is authoritative; otherwise we fall back to
// process.env (tests / process-manager-provided env).
function getSecurityGateConfig(file = envPath()) {
  const fromFile = parseEnvFile(file);
  const src = fromFile || process.env;
  return {
    allowDestructive: bool(src.ALLOW_DESTRUCTIVE_REPO_ACTIONS, false),
    // "maybe also a GitHub password one" — accept either name.
    dangerPassword: src.GITHUB_PASSWORD || src.GITHUB_DANGER_PASSWORD || '',
  };
}

// Pass { fresh: true } to re-read .env from disk first, so long-running callers
// (e.g. an action about to execute) see values edited after boot.
function getConfig(options = {}) {
  if (options.fresh) refreshEnvFromDisk();
  ensureDataDir();
  const gate = getSecurityGateConfig();
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
    llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS || 35000),
    enableDefaultJobs: bool(process.env.ENABLE_DEFAULT_JOBS, false),
    autoApplyLowRiskProfileUpdates: bool(process.env.AUTO_APPLY_LOW_RISK_PROFILE_UPDATES, false),
    autoCreateProfileBlocks: bool(process.env.AUTO_CREATE_PROFILE_BLOCKS, false),
    // Danger-zone repo settings (visibility, deletion, transfer, collaborators,
    // archive, …). OFF by default — even when ON, every action is confirmed.
    allowDestructiveRepoActions: gate.allowDestructive,
    hasGithubDangerPassword: Boolean(gate.dangerPassword),
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
    ALLOW_DESTRUCTIVE_REPO_ACTIONS: Boolean(config.allowDestructiveRepoActions),
    GITHUB_PASSWORD: Boolean(config.hasGithubDangerPassword),
    OPENAI_API_KEY: Boolean(config.apiKeys.openai),
    ANTHROPIC_API_KEY: Boolean(config.apiKeys.anthropic),
    GOOGLE_API_KEY: Boolean(config.apiKeys.google),
    TOGETHER_API_KEY: Boolean(config.apiKeys.together),
    MINIMAX_API_KEY: Boolean(config.apiKeys.minimax),
  };
}

module.exports = {
  getConfig,
  envStatus,
  bool,
  getSecurityGateConfig,
  refreshEnvFromDisk,
  parseEnvFile,
  envPath,
};
