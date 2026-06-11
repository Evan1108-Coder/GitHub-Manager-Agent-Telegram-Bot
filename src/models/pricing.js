const DEFAULT_PRICING = {
  'gpt-5.4-pro': { input: 10, output: 30, relative: 10 },
  'gpt-5.4-mini': { input: 1, output: 3, relative: 2 },
  'gpt-4o': { input: 2.5, output: 10, relative: 4 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, relative: 1 },
  'claude-opus-4-6': { input: 15, output: 75, relative: 12 },
  'claude-sonnet-4-6': { input: 3, output: 15, relative: 5 },
  'claude-haiku-4-5': { input: 0.8, output: 4, relative: 2 },
  'claude-3.5-sonnet': { input: 3, output: 15, relative: 5 },
  'gemini-3.1-pro': { input: 3, output: 10, relative: 5 },
  'gemini-3-flash': { input: 0.3, output: 1, relative: 2 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, relative: 1 },
  'llama-4-maverick': { input: 0.9, output: 0.9, relative: 2 },
  'llama-4-scout': { input: 0.2, output: 0.2, relative: 1 },
  'llama-3.3-70b': { input: 0.9, output: 0.9, relative: 2 },
  'minimax-m2.7': { input: 0.5, output: 2, relative: 2 },
  'minimax-m2.5-lightning': { input: 0.1, output: 0.4, relative: 1 },
};

function rankByCost(models, pricing = DEFAULT_PRICING) {
  return [...models].sort((a, b) => {
    const ca = pricing[a]?.relative ?? 999;
    const cb = pricing[b]?.relative ?? 999;
    return ca - cb || a.localeCompare(b);
  });
}

module.exports = { DEFAULT_PRICING, rankByCost };
