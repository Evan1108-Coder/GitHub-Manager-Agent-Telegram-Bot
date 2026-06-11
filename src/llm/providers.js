const axios = require('axios');
const { getConfig } = require('../config');
const { DEFAULT_PRICING, rankByCost } = require('../models/pricing');

const PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-4o', 'gpt-4o-mini'],
    envKey: 'openai',
    authHeader: key => ({ Authorization: `Bearer ${key}` }),
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-3.5-sonnet'],
    envKey: 'anthropic',
  },
  google: {
    models: ['gemini-3.1-pro', 'gemini-3-flash', 'gemini-2.5-flash-lite'],
    envKey: 'google',
  },
  together: {
    url: 'https://api.together.xyz/v1/chat/completions',
    models: ['llama-4-maverick', 'llama-4-scout', 'llama-3.3-70b'],
    envKey: 'together',
    authHeader: key => ({ Authorization: `Bearer ${key}` }),
    modelMap: {
      'llama-4-maverick': 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
      'llama-4-scout': 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
      'llama-3.3-70b': 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    },
  },
  minimax: {
    url: 'https://api.minimaxi.chat/v1/chat/completions',
    models: ['minimax-m2.7', 'minimax-m2.5-lightning'],
    envKey: 'minimax',
    authHeader: key => ({ Authorization: `Bearer ${key}` }),
    modelMap: {
      'minimax-m2.7': 'MiniMax-M1',
      'minimax-m2.5-lightning': 'MiniMax-M1',
    },
  },
};

const VISION_MODELS = new Set([
  'gpt-5.4-pro',
  'gpt-5.4-mini',
  'gpt-4o',
  'gpt-4o-mini',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-3.5-sonnet',
  'gemini-3.1-pro',
  'gemini-3-flash',
  'gemini-2.5-flash-lite',
]);

function getAllModels() {
  return Object.values(PROVIDERS).flatMap(provider => provider.models);
}

function getProviderForModel(model) {
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    if (provider.models.includes(model)) return { name, ...provider };
  }
  return null;
}

function getAvailableModels(config = getConfig()) {
  return getAllModels().filter(model => {
    const provider = getProviderForModel(model);
    return provider && Boolean(config.apiKeys[provider.envKey]);
  });
}

function chooseDefaultModel(config = getConfig()) {
  const available = getAvailableModels(config);
  if (config.defaultModel && available.includes(config.defaultModel)) return config.defaultModel;
  return rankByCost(available, DEFAULT_PRICING)[0] || null;
}

function supportsVision(model) {
  return VISION_MODELS.has(model);
}

async function callOpenAICompatible(provider, key, model, messages, options = {}) {
  const resolvedModel = provider.modelMap?.[model] || model;
  const res = await axios.post(provider.url, {
    model: resolvedModel,
    messages,
    max_tokens: options.maxTokens || 1600,
    temperature: options.temperature ?? 0.3,
    response_format: options.json ? { type: 'json_object' } : undefined,
  }, {
    headers: { 'Content-Type': 'application/json', ...provider.authHeader(key) },
    timeout: options.timeout || 120000,
  });
  return String(res.data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

async function callAnthropic(key, model, messages, options = {}) {
  const system = messages.find(m => m.role === 'system')?.content || '';
  const userMessages = messages.filter(m => m.role !== 'system');
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model,
    max_tokens: options.maxTokens || 1600,
    system,
    messages: userMessages,
  }, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    timeout: options.timeout || 120000,
  });
  return String(res.data.content?.[0]?.text || '').trim();
}

async function callGoogle(key, model, messages, options = {}) {
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const systemInstruction = messages.find(m => m.role === 'system');
  const body = {
    contents,
    generationConfig: {
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: options.maxTokens || 1600,
      responseMimeType: options.json ? 'application/json' : undefined,
    },
  };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction.content }] };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' }, timeout: options.timeout || 120000 });
  return String(res.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

async function chat(model, messages, options = {}) {
  const config = getConfig();
  const activeModel = model || chooseDefaultModel(config);
  if (!activeModel) {
    throw new Error('No model available. Set at least one provider API key in .env.');
  }
  const provider = getProviderForModel(activeModel);
  if (!provider) throw new Error(`Unknown model: ${activeModel}`);
  const key = config.apiKeys[provider.envKey];
  if (!key) throw new Error(`No API key set for ${provider.name}`);
  if (provider.name === 'anthropic') return callAnthropic(key, activeModel, messages, options);
  if (provider.name === 'google') return callGoogle(key, activeModel, messages, options);
  return callOpenAICompatible(provider, key, activeModel, messages, options);
}

async function chatJson(model, messages, options = {}) {
  const text = await chat(model, messages, { ...options, json: true });
  const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

async function chatWithVision(model, messages, imageBase64, mimeType, options = {}) {
  const config = getConfig();
  const activeModel = model || chooseDefaultModel(config);
  if (!activeModel) throw new Error('No model available. Set at least one provider API key in .env.');
  if (!supportsVision(activeModel)) throw new Error(`Model does not support vision: ${activeModel}`);
  const provider = getProviderForModel(activeModel);
  const key = config.apiKeys[provider.envKey];
  if (!key) throw new Error(`No API key set for ${provider.name}`);

  if (provider.name === 'anthropic') {
    const system = messages.find(m => m.role === 'system')?.content || '';
    const lastUser = messages.filter(m => m.role === 'user').at(-1)?.content || 'Analyze this image.';
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: activeModel,
      max_tokens: options.maxTokens || 1200,
      system,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          { type: 'text', text: lastUser },
        ],
      }],
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      timeout: options.timeout || 120000,
    });
    return String(res.data.content?.[0]?.text || '').trim();
  }

  if (provider.name === 'google') {
    const systemInstruction = messages.find(m => m.role === 'system');
    const lastUser = messages.filter(m => m.role === 'user').at(-1)?.content || 'Analyze this image.';
    const body = {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: imageBase64 } },
          { text: lastUser },
        ],
      }],
      generationConfig: { temperature: options.temperature ?? 0.3, maxOutputTokens: options.maxTokens || 1200 },
    };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction.content }] };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${key}`;
    const res = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' }, timeout: options.timeout || 120000 });
    return String(res.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  }

  const resolvedModel = provider.modelMap?.[activeModel] || activeModel;
  const visionMessages = messages.map(message => {
    if (message.role !== 'user') return message;
    return {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        { type: 'text', text: message.content },
      ],
    };
  });
  const res = await axios.post(provider.url, {
    model: resolvedModel,
    messages: visionMessages,
    max_tokens: options.maxTokens || 1200,
    temperature: options.temperature ?? 0.3,
  }, {
    headers: { 'Content-Type': 'application/json', ...provider.authHeader(key) },
    timeout: options.timeout || 120000,
  });
  return String(res.data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

module.exports = {
  PROVIDERS,
  getAllModels,
  getAvailableModels,
  chooseDefaultModel,
  supportsVision,
  chat,
  chatJson,
  chatWithVision,
};
