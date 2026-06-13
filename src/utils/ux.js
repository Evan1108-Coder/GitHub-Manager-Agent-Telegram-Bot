function startTyping(ctx, intervalMs = 4500) {
  let active = true;
  const send = () => {
    if (!active) return;
    if (!ctx.api?.sendChatAction) return;
    ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
  };
  send();
  const interval = setInterval(send, intervalMs);
  return () => {
    active = false;
    clearInterval(interval);
  };
}

function delayedProgress(ctx, text, delayMs = 1200) {
  let sent = false;
  const timer = setTimeout(() => {
    sent = true;
    ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
  }, delayMs);
  return {
    stop() {
      clearTimeout(timer);
    },
    wasSent() {
      return sent;
    },
  };
}

async function withTyping(ctx, fn) {
  const stop = startTyping(ctx);
  try {
    return await fn();
  } finally {
    stop();
  }
}

function friendlyError(err) {
  const message = err?.message || String(err);
  if (/timeout|timed out|ECONNABORTED/i.test(message)) {
    return '⏱️ <b>That took too long.</b>\nI stopped waiting so the chat does not freeze. Try again, use a faster model, or ask for a smaller check.';
  }
  if (/rate limit/i.test(message)) {
    return '🚦 <b>Rate limit hit.</b>\nGitHub or the model provider is limiting requests. I can try again later.';
  }
  if (/permission|403|not authorized|resource not accessible/i.test(message)) {
    return '🔒 <b>Permission problem.</b>\nThe token probably does not have access for that action.';
  }
  return `⚠️ <b>Something went wrong.</b>\n${escapeMinimal(message)}`;
}

function escapeMinimal(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = {
  startTyping,
  delayedProgress,
  withTyping,
  friendlyError,
};
