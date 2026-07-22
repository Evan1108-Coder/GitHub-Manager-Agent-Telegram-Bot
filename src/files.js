const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const JSZip = require('jszip');
const { getConfig } = require('./config');

const SUPPORTED = {
  text: ['.txt', '.md', '.csv', '.json', '.html'],
  document: ['.pdf', '.docx', '.pptx', '.rtf'],
  image: ['.png', '.jpg', '.jpeg', '.avif'],
};

function classifyFile(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  for (const [kind, extensions] of Object.entries(SUPPORTED)) {
    if (extensions.includes(ext)) return { kind, ext };
  }
  return null;
}

function getSupportedExtensions() {
  return Object.values(SUPPORTED).flat();
}

async function downloadTelegramFile(api, fileId, fileName) {
  const config = getConfig();
  const file = await api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  const safeName = path.basename(fileName || file.file_path || 'upload.bin');
  const outDir = path.join(config.dataDir, 'uploads');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${Date.now()}-${safeName}`);
  await fs.writeFile(outPath, Buffer.from(res.data));
  return outPath;
}

async function extractText(filePath, fileName = filePath) {
  const type = classifyFile(fileName);
  if (!type) throw new Error(`Unsupported file type: ${fileName}`);
  const ext = type.ext;
  if (type.kind === 'image') return '';
  if (['.txt', '.md', '.csv', '.json', '.html', '.rtf'].includes(ext)) {
    const raw = await fs.readFile(filePath, 'utf8');
    return ext === '.rtf' ? stripRtf(raw) : raw;
  }
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: new Uint8Array(await fs.readFile(filePath)) });
    try {
      const result = await parser.getText();
      return result.text || '';
    } finally {
      await parser.destroy?.();
    }
  }
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || '';
  }
  if (ext === '.pptx') {
    return extractPptxText(await fs.readFile(filePath));
  }
  return '';
}

async function getImageBase64(filePath) {
  return (await fs.readFile(filePath)).toString('base64');
}

function getMimeType(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.avif') return 'image/avif';
  return 'application/octet-stream';
}

function stripRtf(raw) {
  return String(raw)
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-z]+\d* ?/gi, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractPptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(naturalSort);
  const chunks = [];
  for (const name of names) {
    const xml = await zip.files[name].async('text');
    const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map(match => decodeXml(match[1]))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) chunks.push(text);
  }
  return chunks.join('\n\n');
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

function voiceCapabilityMessage() {
  return 'I received your voice message, but GitHub Manager cannot transcribe audio yet. Please send the request as text; I won’t guess at audio I cannot hear.';
}

function unsupportedAttachmentMessage(kind = 'attachment') {
  return `I received the ${kind}, but GitHub Manager cannot process that attachment type yet. Please send text or one of these supported uploads: ${getSupportedExtensions().join(', ')}.`;
}

module.exports = {
  classifyFile,
  getSupportedExtensions,
  downloadTelegramFile,
  extractText,
  getImageBase64,
  getMimeType,
  voiceCapabilityMessage,
  unsupportedAttachmentMessage,
};
