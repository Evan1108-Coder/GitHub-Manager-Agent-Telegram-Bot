const { Bot } = require('grammy');
const { envStatus, getConfig } = require('./config');
const { isSetupComplete, startSetup, currentQuestion, handleSetupAnswer } = require('./setup');
const { sendLong, escapeHtml, oneLine } = require('./utils/format');
const { handleText, handleApprovalCallback } = require('./agent');
const { seedDefaultJobs } = require('./scheduler');
const { classifyFile, downloadTelegramFile, extractText, getSupportedExtensions, getImageBase64, getMimeType } = require('./files');
const { openDb } = require('./db');
const { chooseDefaultModel, supportsVision, chat, chatWithVision } = require('./llm/providers');
const { withTyping, friendlyError } = require('./utils/ux');

function createBot(token) {
  const bot = new Bot(token);

  bot.command('start', async ctx => {
    if (!isSetupComplete()) {
      startSetup();
      return sendLong(ctx, currentQuestion());
    }
    return sendLong(ctx, '👋 <b>GitHub Manager Agent</b>\nI’m ready. Ask naturally, or use /help for examples.');
  });

  bot.command('help', async ctx => {
    return sendLong(ctx, [
      '✨ <b>Examples</b>',
      '🔎 audit my repos',
      '📊 show my GitHub stats',
      '📌 summarize what I did today',
      '⏰ every Monday at 9 compare stars for Evan1108-Coder/TrendForge-Telegram-Bot',
      '🛠️ update my profile README',
      '🧭 fetch morning builder trends',
      '',
      'You can also reply to messages, forward GitHub-related text, or upload supported files.',
      `Supported files: ${escapeHtml(getSupportedExtensions().join(', '))}`,
    ].join('\n'));
  });

  bot.command('status', ctx => handleText(ctx, 'status'));
  bot.command('settings', ctx => handleText(ctx, 'settings'));
  bot.command('reset_setup', ctx => handleText(ctx, 'reset setup'));
  bot.command('models', ctx => handleText(ctx, 'models'));
  bot.command('jobs', ctx => handleText(ctx, 'jobs'));

  bot.on('callback_query:data', async ctx => {
    if ((ctx.callbackQuery.data || '').startsWith('approval:')) return handleApprovalCallback(ctx);
    return ctx.answerCallbackQuery();
  });

  bot.on('message:text', async ctx => {
    const text = buildMessageContext(ctx);
    if (!isSetupComplete()) {
      const result = handleSetupAnswer(text);
      if (result.done) seedDefaultJobs();
      return sendLong(ctx, result.message);
    }
    return handleText(ctx, text, { telegram: getTelegramContext(ctx) });
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
        return sendLong(ctx, `📄 <b>File read: ${escapeHtml(fileName)}</b>\n${escapeHtml(summary)}`);
      });
    } catch (err) {
      return sendLong(ctx, friendlyError(err));
    }
  });

  bot.catch(err => {
    console.error('[Bot] Error:', err.error?.message || err.message);
  });

  return bot;
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
    { role: 'system', content: 'Summarize uploaded files for a GitHub agent. Keep it concise and say how it might be useful for GitHub/repo work.' },
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
    { role: 'system', content: 'Analyze this image for a GitHub/project agent. Mention UI/docs/repo presentation relevance if any.' },
    { role: 'user', content: `Caption: ${caption || 'none'}\nImage MIME: ${mimeType}\nImage data is available to the provider if supported.` },
  ], imageBase64, mimeType, { maxTokens: 700 });
}

function validateStartupConfig() {
  const config = getConfig();
  const status = envStatus(config);
  if (!status.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing in .env');
  if (!status.GITHUB_TOKEN) console.warn('[Config] GITHUB_TOKEN missing: GitHub actions will fail until set.');
}

module.exports = { createBot, validateStartupConfig };
