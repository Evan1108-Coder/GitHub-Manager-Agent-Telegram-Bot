const { Bot } = require('grammy');
const { envStatus, getConfig } = require('./config');
const { isSetupComplete, startSetup, currentQuestion, handleSetupAnswer } = require('./setup');
const { sendLong, escapeHtml, oneLine, mdToHtml } = require('./utils/format');
const { handleText, handleApprovalCallback, handleWatchCallback } = require('./agent');
const { seedDefaultJobs } = require('./scheduler');
const { getWatchManager } = require('./watch-setup');
const { classifyFile, downloadTelegramFile, extractText, getSupportedExtensions, getImageBase64, getMimeType } = require('./files');
const { openDb, getSetting, setSetting } = require('./db');
const { chooseDefaultModel, supportsVision, chat, chatWithVision } = require('./llm/providers');
const { withTyping, friendlyError } = require('./utils/ux');
const { createBusyState } = require('./utils/busy');
const { languagePolicy } = require('./utils/language');
const { remember } = require('./utils/actionlog');
const { checkForUpdate, applyUpdate } = require('./update');
const { execSync } = require('child_process');

// pm2 process name to restart after a successful self-update.
const PM2_NAME = process.env.PM2_PROCESS_NAME || 'github-manager-bot';

function createBot(token) {
  const bot = new Bot(token);
  const busyState = createBusyState();

  // Learn where to deliver scheduled reports: the first time the owner DMs the
  // bot, remember that private chat id. This is what makes scheduled jobs work
  // without the owner having to hand-set TELEGRAM_CHAT_ID (and it never captures
  // a group, so noisy chats can't hijack delivery).
  bot.use(async (ctx, next) => {
    captureOwnerChat(ctx);
    return next();
  });

  bot.command('start', async ctx => {
    if (!isSetupComplete()) {
      startSetup();
      return sendLong(ctx, currentQuestion());
    }
    return sendLong(ctx, '👋 <b>GitHub Manager Agent</b>\nI’m ready. Ask naturally, or use /help for examples.');
  });

  bot.command('help', async ctx => sendLong(ctx, renderHelpMenu()));

  bot.command('status', ctx => {
    if (busyState.busy(ctx.chat.id)) return busyState.handleWhileBusy(ctx, 'status', { reply: message => sendLong(ctx, escapeHtml(message)) });
    return handleText(ctx, 'status');
  });
  bot.command('settings', ctx => handleText(ctx, 'settings'));
  bot.command('reset', ctx => handleText(ctx, 'reset setup'));
  bot.command('models', ctx => handleText(ctx, 'models'));
  bot.command('jobs', ctx => handleText(ctx, 'jobs'));
  bot.command('watches', ctx => handleText(ctx, 'watches'));

  const ability = (phrase, withArgs = true) => ctx => {
    const args = withArgs && ctx.match ? String(ctx.match).trim() : '';
    return handleText(ctx, args ? `${phrase} ${args}` : phrase);
  };
  bot.command('audit', ability('audit repo'));
  bot.command('stats', ability('show my GitHub stats', false));
  bot.command('summary', ability('summarize today on GitHub', false));
  bot.command('trends', ability('fetch builder trends', false));
  bot.command('profile', ability('profile README update', false));
  bot.command('readme', ability('draft a README patch for'));
  bot.command('compare', ability('compare stars for'));
  bot.command('schedule', ability('schedule'));
  bot.command('watch', ability('watch'));
  bot.command('files', ability('uploaded files', false));
  bot.command('approvals', ability('approval log', false));
  bot.command('telemetry', ability('response time telemetry', false));

  try {
    bot.api.setMyCommands(GITHUB_COMMANDS).catch(err => console.error('[Bot] setMyCommands failed:', err.message));
  } catch (err) {
    console.error('[Bot] setMyCommands failed:', err.message);
  }

  let updateInProgress = false;
  bot.command('update', async ctx => {
    if (updateInProgress) {
      return sendLong(ctx, '⏳ An update is already in progress — hang tight.');
    }
    updateInProgress = true;
    try {
      await ctx.reply('🔎 Checking GitHub for a newer version…');

      let info;
      try {
        info = checkForUpdate();
      } catch (err) {
        return sendLong(ctx, `⚠️ <b>Couldn’t check for updates.</b>\n${escapeHtml(friendlyError(err))}`);
      }

      if (!info.available) {
        const v = info.localVersion ? ` (v${escapeHtml(info.localVersion)})` : '';
        remember(ctx.chat.id, { action: 'checked /update command', evidence: `local=${info.localVersion || info.local || 'unknown'} remote=${info.remoteVersion || info.remote || 'unknown'}`, result: 'Already on latest version; no update applied.', cost: 'none' });
        return sendLong(ctx, `✅ <b>Already on the latest version${v}.</b>\nNothing to update.`);
      }

      const verPart = info.localVersion && info.remoteVersion && info.localVersion !== info.remoteVersion
        ? `v${escapeHtml(info.localVersion)} → v${escapeHtml(info.remoteVersion)}`
        : `${info.behind} new commit${info.behind === 1 ? '' : 's'}`;
      const changeLines = (info.changelog || []).slice(0, 8).map(c => `• ${escapeHtml(c)}`);
      await sendLong(ctx, [
        `⬇️ <b>Update found</b> — ${verPart}.`,
        changeLines.length ? '\n<b>What’s new:</b>' : '',
        ...changeLines,
        '\nApplying now — I’ll health-check the new code and roll back automatically if it fails to start.',
      ].filter(Boolean).join('\n'));

      remember(ctx.chat.id, { action: 'found available /update', evidence: `${verPart}; changelog=${(info.changelog || []).slice(0, 8).join(' | ')}`, result: 'Applying update with health check.', cost: 'none' });
      const result = applyUpdate();
      if (!result.ok) {
        remember(ctx.chat.id, { action: 'failed /update command', evidence: `stage=${result.stage || 'unknown'} message=${result.message || 'unknown'}`, result: result.rolledBack ? 'Update failed and rolled back.' : 'Update failed before completion.', cost: 'none' });
        const rolled = result.rolledBack
          ? '\n\n↩️ <b>Rolled back</b> to the previous working version — the bot is still running the old code.'
          : '';
        return sendLong(ctx, `⚠️ <b>Update failed</b> at the <code>${escapeHtml(result.stage || 'update')}</code> step.\n${escapeHtml(result.message || 'Unknown error.')}${rolled}`);
      }

      const filesPart = (result.filesChanged || []).length
        ? '\n<b>Files changed:</b>\n' + result.filesChanged.slice(0, 20).map(f => `• <code>${escapeHtml(f.status)}</code> ${escapeHtml(f.file)}`).join('\n')
        : '';
      const commitsPart = (result.commits || []).length
        ? '\n<b>Commits:</b>\n' + result.commits.slice(0, 10).map(c => `• ${escapeHtml(c)}`).join('\n')
        : '';
      const integrityPart = result.dataIntegrity
        ? `\n<b>Data integrity:</b> ${result.dataIntegrity.ok ? '✅ all user data untouched' : '⚠️ mismatch'} (checked ${result.dataIntegrity.checked.length} file${result.dataIntegrity.checked.length === 1 ? '' : 's'}).`
        : '';
      remember(ctx.chat.id, { action: 'completed /update command', evidence: `prev=${result.prevHead || 'unknown'} new=${result.newHead || 'unknown'} files=${(result.filesChanged || []).map(f => `${f.status} ${f.file}`).join(', ')}`, result: `Updated successfully${result.remoteVersion ? ` to ${result.remoteVersion}` : ''}; restarting.`, cost: 'none' });
      await sendLong(ctx, [
        `✅ <b>Updated successfully!</b> ${escapeHtml((result.prevHead || '').slice(0, 7))} → ${escapeHtml((result.newHead || '').slice(0, 7))}`,
        result.depsInstalled ? '📦 Dependencies were reinstalled.' : '',
        filesPart,
        commitsPart,
        integrityPart,
        '\n♻️ Restarting now to run the new version…',
      ].filter(Boolean).join('\n'));

      // Restart out-of-band so this handler can finish replying first.
      setTimeout(() => {
        try { execSync(`pm2 restart ${PM2_NAME}`); }
        catch (e) { console.error('[update] restart failed:', e.message); }
      }, 1000);
    } finally {
      updateInProgress = false;
    }
  });

  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data || '';
    if (data.startsWith('approval:')) return handleApprovalCallback(ctx);
    if (data.startsWith('watch:')) return handleWatchCallback(ctx);
    return ctx.answerCallbackQuery();
  });

  bot.on('message:text', async ctx => {
    const text = buildMessageContext(ctx);
    if (!isSetupComplete()) {
      const result = handleSetupAnswer(text);
      if (result.done) seedDefaultJobs();
      return sendLong(ctx, result.message);
    }
    if (busyState.busy(ctx.chat.id)) {
      const handled = await busyState.handleWhileBusy(ctx, text, { reply: message => sendLong(ctx, escapeHtml(message)) });
      if (handled) return;
    }
    busyState.start(ctx.chat.id, { label: makeTaskLabel(text), stage: 'working', detail: 'I can still answer questions about this task state.' });
    try {
      return await handleText(ctx, text, { telegram: getTelegramContext(ctx) });
    } finally {
      busyState.finish(ctx.chat.id);
    }
  });

  bot.on(['message:document', 'message:photo'], async ctx => {
    if (!isSetupComplete()) {
      return sendLong(ctx, '⚙️ <b>Setup is not complete yet.</b>\nFinish setup first, then I can analyze files.');
    }
    const msg = ctx.message;
    let fileId;
    let fileName;
    if (msg.document) {
      fileId = msg.document.file_id;
      fileName = msg.document.file_name || 'file';
    } else {
      const largest = msg.photo[msg.photo.length - 1];
      fileId = largest.file_id;
      fileName = 'photo.jpg';
    }
    const fileType = classifyFile(fileName);
    if (!fileType && msg.document) {
      return sendLong(ctx, `⚠️ <b>Unsupported file type.</b>\nSupported: ${escapeHtml(getSupportedExtensions().join(', '))}`);
    }
    await ctx.reply('📎 <b>Got it.</b> I’m downloading and reading the file…', { parse_mode: 'HTML' });
    try {
      return await withTyping(ctx, async () => {
        const localPath = await downloadTelegramFile(ctx.api, fileId, fileName);
        let extracted = '';
        let summary = '';
        if (fileType?.kind === 'image') {
          summary = await summarizeImage(localPath, fileName, msg.caption || '');
        } else {
          extracted = await extractText(localPath, fileName);
          summary = await summarizeText(extracted, msg.caption || '');
        }
        openDb().prepare(`
          INSERT INTO uploaded_files (chat_id, telegram_file_id, file_name, file_type, extracted_text, summary)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(String(ctx.chat.id), fileId, fileName, fileType?.kind || 'image', extracted.slice(0, 20000), summary);
        return sendLong(ctx, `📄 <b>File read: ${escapeHtml(fileName)}</b>\n${mdToHtml(summary)}`);
      });
    } catch (err) {
      const message = /xref|pdf|parse|invalid|corrupt|password|encrypt|unsupported file/i.test(err.message || '')
        ? `📄 <b>I couldn’t read ${escapeHtml(fileName)}.</b>\nIt may be scanned, encrypted, or in a format I can’t parse yet. Try a text-based PDF, a .docx, or a .txt export.`
        : friendlyError(err);
      return sendLong(ctx, message);
    }
  });

  bot.catch(err => {
    console.error('[Bot] Error:', err.error?.message || err.message);
  });

  // Bring the opt-in background watches back after a restart. Any watch whose
  // deadline passed while the bot was down is closed out (and the user told),
  // so nothing is silently lost — and none of this blocks startup.
  try {
    const wm = getWatchManager(bot);
    const { resumed } = wm.resumeWatches();
    if (resumed) console.log(`[Watch] Resumed ${resumed} active watch${resumed === 1 ? '' : 'es'}.`);
  } catch (err) {
    console.error('[Watch] resume failed:', err.message);
  }

  return bot;
}

function makeTaskLabel(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (/\b(audit|repos?|repository|github)\b/i.test(t)) return 'the GitHub repo request';
  if (/\b(job|schedule|reminder)\b/i.test(t)) return 'the scheduled job request';
  if (/\b(status|settings|models|watches)\b/i.test(t)) return 'the status check';
  return t ? `“${t.slice(0, 60)}${t.length > 60 ? '…' : ''}”` : 'your request';
}

const GITHUB_COMMANDS = [
  { command: 'start', description: 'Start the GitHub Manager Agent' },
  { command: 'help', description: 'Show commands, abilities, and examples' },
  { command: 'status', description: 'Bot/runtime status and setup summary' },
  { command: 'audit', description: 'Audit repos/READMEs/presentation issues' },
  { command: 'stats', description: 'Show GitHub stats and snapshots' },
  { command: 'summary', description: 'Summarize today’s GitHub activity' },
  { command: 'trends', description: 'Fetch builder trends for project ideas' },
  { command: 'profile', description: 'Inspect/update profile README safely' },
  { command: 'readme', description: 'Draft README patch for a repo' },
  { command: 'compare', description: 'Compare repo metrics such as stars' },
  { command: 'schedule', description: 'Create/edit natural-language jobs' },
  { command: 'watch', description: 'Offer a background GitHub watch' },
  { command: 'files', description: 'Search uploaded files' },
  { command: 'approvals', description: 'Show approval/audit log' },
  { command: 'telemetry', description: 'Show latency/response telemetry' },
  { command: 'settings', description: 'Current preferences and configuration' },
  { command: 'models', description: 'Available AI models and active default' },
  { command: 'jobs', description: 'List scheduled GitHub jobs' },
  { command: 'watches', description: 'List background watches/monitors' },
  { command: 'update', description: 'Pull latest GitHub code with health check' },
  { command: 'reset', description: 'Restart onboarding/setup' },
];

function renderHelpMenu() {
  return [
    '✨ <b>GitHub Manager Agent — Commands</b>',
    '',
    ...GITHUB_COMMANDS.map(c => `<code>/${escapeHtml(c.command)}</code> — ${escapeHtml(c.description)}`),
    '',
    '<b>Ability examples:</b>',
    '🔎 <code>audit my repos</code> — inspect READMEs, descriptions, docs, presentation issues',
    '📊 <code>show my GitHub stats</code> — stars/forks/views/snapshots when available',
    '📌 <code>summarize what I did today</code> — recent GitHub activity summary',
    '⏰ <code>every Monday at 9 compare stars for owner/repo</code> — create scheduled jobs',
    '🛠️ <code>update my profile README</code> — inspect/draft controlled profile updates',
    '🧭 <code>fetch builder trends</code> — trend digest for project ideas',
    '👀 <code>watch PR #12 in owner/repo</code> — offer an opt-in background watch',
    '',
    'You can also reply to messages, forward GitHub-related text, or upload supported files.',
    `Supported files: ${escapeHtml(getSupportedExtensions().join(', '))}`,
  ].join('\n');
}

function captureOwnerChat(ctx) {
  try {
    const chat = ctx.chat;
    const from = ctx.from;
    if (!chat || chat.type !== 'private' || !from || from.is_bot) return;
    // Lock to the first human who DMs the bot (the owner). An explicit
    // TELEGRAM_CHAT_ID env override still wins at delivery time.
    if (!getSetting('owner_chat_id', null)) {
      setSetting('owner_chat_id', String(chat.id));
    }
  } catch {
    // Never let capture break message handling.
  }
}

function buildMessageContext(ctx) {
  const msg = ctx.message;
  let text = msg.text || msg.caption || '';
  const parts = [];
  if (msg.reply_to_message) {
    const reply = msg.reply_to_message;
    const replyText = reply.text || reply.caption || '';
    if (replyText) parts.push(`[Replying to ${reply.from?.first_name || 'someone'}: "${replyText.slice(0, 500)}"]`);
  }
  if (msg.forward_origin || msg.forward_from || msg.forward_from_chat) {
    parts.push(`[Forwarded message]`);
  }
  return parts.length ? `${parts.join(' ')}\n${text}` : text;
}

function getTelegramContext(ctx) {
  return {
    chatId: ctx.chat.id,
    messageId: ctx.message?.message_id,
    replyTo: Boolean(ctx.message?.reply_to_message),
  };
}

async function summarizeText(text, caption) {
  const model = chooseDefaultModel();
  if (!model) return oneLine(text, 1200) || 'No text extracted.';
  const response = await chat(model, [
    { role: 'system', content: 'Summarize uploaded files for a GitHub agent. Keep it concise and say how it might be useful for GitHub/repo work.\n' + languagePolicy() },
    { role: 'user', content: `Caption: ${caption || 'none'}\n\nFile text:\n${text.slice(0, 12000)}` },
  ], { maxTokens: 550 });
  return response;
}

async function summarizeImage(localPath, fileName, caption) {
  const model = chooseDefaultModel();
  if (!model || !supportsVision(model)) return `Image saved, but the active model does not support vision: ${fileName}`;
  const imageBase64 = await getImageBase64(localPath);
  const mimeType = getMimeType(fileName);
  return chatWithVision(model, [
    { role: 'system', content: 'Analyze this image for a GitHub/project agent. Mention UI/docs/repo presentation relevance if any.\n' + languagePolicy() },
    { role: 'user', content: `Caption: ${caption || 'none'}\nImage MIME: ${mimeType}\nImage data is available to the provider if supported.` },
  ], imageBase64, mimeType, { maxTokens: 700 });
}

function validateStartupConfig() {
  const config = getConfig();
  const status = envStatus(config);
  if (!status.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing in .env');
  if (!status.GITHUB_TOKEN) console.warn('[Config] GITHUB_TOKEN missing: GitHub actions will fail until set.');
}

module.exports = { createBot, validateStartupConfig, GITHUB_COMMANDS, renderHelpMenu };
