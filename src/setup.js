const { getConfig, envStatus } = require('./config');
const { getSetting, setSetting } = require('./db');
const { escapeHtml } = require('./utils/format');
const { getAvailableModels, chooseDefaultModel } = require('./llm/providers');

const STEPS = [
  'confirm_env',
  'github_username',
  'profile_repo',
  'timezone',
  'default_jobs',
  'auto_profile',
  'writing_style',
  'important_repos',
  'never_edit',
];

function isSetupComplete() {
  return Boolean(getSetting('setup_complete', false));
}

function startSetup() {
  if (!getSetting('setup_step')) setSetting('setup_step', STEPS[0]);
}

function currentQuestion() {
  const config = getConfig();
  const step = getSetting('setup_step', STEPS[0]);
  const availableModels = getAvailableModels(config);
  const cheapest = chooseDefaultModel(config);
  const env = envStatus(config);

  if (step === 'confirm_env') {
    const lines = [
      '<b>First-time setup</b>',
      'I read your local .env and found:',
      `Telegram token: ${yesNo(env.TELEGRAM_BOT_TOKEN)}`,
      `Telegram chat ID: ${yesNo(env.TELEGRAM_CHAT_ID)}`,
      `GitHub token: ${yesNo(env.GITHUB_TOKEN)}`,
      `GitHub username: ${escapeHtml(config.githubUsername || 'not set')}`,
      `Profile repo: ${escapeHtml(config.githubProfileRepo || 'not set')}`,
      `Timezone: ${escapeHtml(config.defaultTimezone || 'UTC')}`,
      `Available model count: ${availableModels.length}`,
      `Default model: ${escapeHtml(config.defaultModel || cheapest || 'not set')}`,
      '',
      'Does this look okay to continue? You can answer casually, ask a side question, or say what to change.',
    ];
    return lines.join('\n');
  }
  if (step === 'github_username') {
    return `What GitHub username should I manage? I found <b>${escapeHtml(config.githubUsername || 'nothing')}</b> in .env. You can say “yes”, give a username, or skip.`;
  }
  if (step === 'profile_repo') {
    return `Do you have a GitHub profile README repo? I found <b>${escapeHtml(config.githubProfileRepo || 'nothing')}</b>. Example: username/username. You can skip this.`;
  }
  if (step === 'timezone') {
    return `What timezone should scheduled jobs use? I found <b>${escapeHtml(config.defaultTimezone || 'UTC')}</b>. You can say “use default”, “Hong Kong”, “Shanghai”, or any timezone.`;
  }
  if (step === 'default_jobs') {
    return 'Do you want to enable the starter scheduled jobs? They are 06:00 trends, 06:30 profile/public presence update, 22:30 daily summary, and 00:00 stats. You can change them later.';
  }
  if (step === 'auto_profile') {
    return 'Should simple factual profile/stat updates auto-apply inside bot-controlled sections? Bigger or uncertain changes will still ask approval.';
  }
  if (step === 'writing_style') {
    return 'What writing style should I use for public GitHub text? Examples: concise, technical, friendly, persuasive, portfolio-focused. You can skip.';
  }
  if (step === 'important_repos') {
    return 'Which repos are most important to you? You can list names, say “figure it out”, or skip.';
  }
  if (step === 'never_edit') {
    return 'Are there repos or files I should never edit automatically? You can list them or skip.';
  }
  return 'Setup is ready.';
}

function handleSetupAnswer(text) {
  startSetup();
  const raw = String(text || '').trim();
  if (looksLikeSideQuestion(raw)) {
    return {
      done: false,
      message: answerSideQuestion(raw) + '\n\nBack to setup:\n' + currentQuestion(),
    };
  }

  const step = getSetting('setup_step', STEPS[0]);
  const config = getConfig();
  const skipped = isSkip(raw);

  if (step === 'confirm_env') {
    if (isNegative(raw)) {
      return advance('github_username', 'No problem. We’ll walk through the settings one by one.\n\n' + questionFor('github_username'));
    }
    return advance('github_username', 'Good. I’ll still confirm the important settings.\n\n' + questionFor('github_username'));
  }

  if (step === 'github_username') {
    if (!skipped && !isAffirmative(raw)) setSetting('github_username', normalizeUsername(raw));
    else if (config.githubUsername) setSetting('github_username', config.githubUsername);
    return advance('profile_repo', questionFor('profile_repo'));
  }

  if (step === 'profile_repo') {
    if (skipped || /no profile|none|don't have/i.test(raw)) setSetting('profile_repo', '');
    else if (isAffirmative(raw) && config.githubProfileRepo) setSetting('profile_repo', config.githubProfileRepo);
    else if (!isAffirmative(raw)) setSetting('profile_repo', normalizeRepo(raw));
    return advance('timezone', questionFor('timezone'));
  }

  if (step === 'timezone') {
    if (skipped || /default|choose|whatever|idk/i.test(raw)) setSetting('timezone', config.defaultTimezone || 'UTC');
    else setSetting('timezone', normalizeTimezone(raw));
    return advance('default_jobs', questionFor('default_jobs'));
  }

  if (step === 'default_jobs') {
    setSetting('enable_default_jobs', skipped ? config.enableDefaultJobs : !isNegative(raw));
    return advance('auto_profile', questionFor('auto_profile'));
  }

  if (step === 'auto_profile') {
    setSetting('auto_apply_low_risk_profile_updates', skipped ? config.autoApplyLowRiskProfileUpdates : !isNegative(raw));
    return advance('writing_style', questionFor('writing_style'));
  }

  if (step === 'writing_style') {
    setSetting('writing_style', skipped ? 'concise, practical, clear, GitHub-native' : raw);
    return advance('important_repos', questionFor('important_repos'));
  }

  if (step === 'important_repos') {
    setSetting('important_repos', skipped || /figure|auto|choose/i.test(raw) ? [] : splitList(raw));
    return advance('never_edit', questionFor('never_edit'));
  }

  if (step === 'never_edit') {
    setSetting('never_edit', skipped || /none|nope/i.test(raw) ? [] : splitList(raw));
    setSetting('setup_complete', true);
    setSetting('setup_step', 'complete');
    return {
      done: true,
      message: '<b>Setup complete.</b>\nYou can now talk naturally. Try: “audit my GitHub repos”, “show my jobs”, or “summarize my GitHub today.”',
    };
  }

  setSetting('setup_complete', true);
  return { done: true, message: '<b>Setup complete.</b>' };
}

function questionFor(step) {
  const old = getSetting('setup_step', STEPS[0]);
  setSetting('setup_step', step);
  const q = currentQuestion();
  setSetting('setup_step', old);
  return q;
}

function advance(step, message) {
  setSetting('setup_step', step);
  return { done: false, message };
}

function yesNo(value) {
  return value ? 'set' : 'missing';
}

function isAffirmative(text) {
  return /^(yes|y|yeah|yep|sure|ok|okay|correct|right|looks good|continue|go on|fine)$/i.test(text.trim());
}

function isNegative(text) {
  return /\b(no|nope|nah|wrong|not right|disable|don't|do not)\b/i.test(text);
}

function isSkip(text) {
  return /^(skip|not now|later|i don't want to answer|dont want to answer|choose for me|use default|default|idk|whatever|no idea)$/i.test(text.trim());
}

function looksLikeSideQuestion(text) {
  return /\?$/.test(text) || /^(what|where|how|why|can you|do i|should i)\b/i.test(text);
}

function answerSideQuestion(text) {
  const raw = text.toLowerCase();
  if (raw.includes('profile repo')) {
    return 'A GitHub profile repo is a repository with the same name as your GitHub username. Its README appears on your GitHub profile.';
  }
  if (raw.includes('timezone')) {
    return 'Timezone controls when scheduled jobs run. For Hong Kong, use Asia/Hong_Kong. You can change it later.';
  }
  if (raw.includes('model')) {
    return 'The model is the AI backend used for planning, writing, and analysis. If you do not choose one, I use the cheapest available configured model.';
  }
  if (raw.includes('token')) {
    return 'Tokens go in .env, not chat. A GitHub token lets the bot read and perform approved GitHub actions.';
  }
  return 'You can answer casually. If you skip optional setup, I’ll use a safe default or leave that feature disabled until you configure it later.';
}

function normalizeUsername(text) {
  return String(text).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/^@/, '').split(/[/?#\s]/)[0];
}

function normalizeRepo(text) {
  const cleaned = String(text).trim().replace(/^https?:\/\/github\.com\//i, '').split(/[?#\s]/)[0];
  return cleaned.includes('/') ? cleaned : cleaned;
}

function normalizeTimezone(text) {
  const raw = String(text).trim();
  if (/hong\s*kong|hkt/i.test(raw)) return 'Asia/Hong_Kong';
  if (/shanghai|china|beijing/i.test(raw)) return 'Asia/Shanghai';
  if (/utc/i.test(raw)) return 'UTC';
  return raw;
}

function splitList(text) {
  return String(text).split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
}

module.exports = {
  isSetupComplete,
  startSetup,
  currentQuestion,
  handleSetupAnswer,
  looksLikeSideQuestion,
};
