const TELEGRAM_SAFE_LIMIT = 3900;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '');
}

function link(label, url) {
  if (!url) return escapeHtml(label);
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

function chunkText(text, limit = TELEGRAM_SAFE_LIMIT) {
  const value = String(text ?? '');
  if (value.length <= limit) return [value];
  const chunks = [];
  let rest = value;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendLong(ctxOrBot, chatIdOrText, maybeText, options = {}) {
  let send;
  let text;
  if (typeof maybeText === 'string') {
    const bot = ctxOrBot;
    const chatId = chatIdOrText;
    text = maybeText;
    send = chunk => bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML', disable_web_page_preview: true, ...options });
  } else {
    const ctx = ctxOrBot;
    text = chatIdOrText;
    send = chunk => ctx.reply(chunk, { parse_mode: 'HTML', disable_web_page_preview: true, ...maybeText });
  }
  for (const chunk of chunkText(text)) {
    await send(chunk);
  }
}

function oneLine(value, max = 180) {
  const compact = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return compact.slice(0, max - 1).trimEnd() + '…';
}

module.exports = {
  TELEGRAM_SAFE_LIMIT,
  escapeHtml,
  stripHtml,
  link,
  chunkText,
  sendLong,
  oneLine,
};
