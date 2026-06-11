require('dotenv').config();
const { getConfig, envStatus } = require('../src/config');
const { openDb } = require('../src/db');
const { GitHubClient } = require('../src/github/client');
const { getAvailableModels, chooseDefaultModel } = require('../src/llm/providers');

async function main() {
  const config = getConfig();
  openDb();
  console.log('Environment readiness:');
  const status = envStatus(config);
  for (const [key, set] of Object.entries(status)) console.log(`${key}: ${set ? 'set' : 'missing'}`);
  console.log(`Available models: ${getAvailableModels(config).join(', ') || 'none'}`);
  console.log(`Chosen default model: ${chooseDefaultModel(config) || 'none'}`);
  if (config.githubToken) {
    const github = new GitHubClient();
    const user = await github.getCurrentUser();
    console.log(`GitHub API ok: ${user.login}`);
    console.log(`Rate limit remaining: ${github.lastRateLimit?.remaining || 'unknown'}`);
    if (github.tokenExpiration) console.log(`Token expiration: ${github.tokenExpiration}`);
  }
  console.log('Smoke check complete.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
