function replaceLine(content, lineNumber, replacement) {
  const lines = String(content).split('\n');
  const index = Number(lineNumber) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    throw new Error(`Line ${lineNumber} is outside the file. File has ${lines.length} line(s).`);
  }
  const before = lines[index];
  lines[index] = replacement;
  return {
    content: lines.join('\n'),
    before,
    after: replacement,
    diff: lineDiff(lineNumber, before, replacement),
  };
}

function lineDiff(lineNumber, before, after) {
  return [
    `@@ line ${lineNumber} @@`,
    `- ${before}`,
    `+ ${after}`,
  ].join('\n');
}

function textDiff(before, after, label = 'change') {
  if (before === after) return `No ${label} changes.`;
  return [
    `@@ ${label} @@`,
    `- ${before || ''}`,
    `+ ${after || ''}`,
  ].join('\n');
}

module.exports = { replaceLine, lineDiff, textDiff };
