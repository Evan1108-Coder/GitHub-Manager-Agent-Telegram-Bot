const axios = require('axios');
const { getConfig } = require('../config');

class GitHubClient {
  constructor(token = getConfig().githubToken) {
    this.token = token;
    this.http = axios.create({
      baseURL: 'https://api.github.com',
      timeout: 45000,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    this.lastRateLimit = null;
    this.tokenExpiration = null;
  }

  async request(method, url, data, params) {
    try {
      const res = await this.http.request({ method, url, data, params });
      this.lastRateLimit = {
        limit: res.headers['x-ratelimit-limit'],
        remaining: res.headers['x-ratelimit-remaining'],
        reset: res.headers['x-ratelimit-reset'],
      };
      this.tokenExpiration = res.headers['github-authentication-token-expiration'] || this.tokenExpiration;
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const message = err.response?.data?.message || err.message;
      const e = new Error(`GitHub ${method.toUpperCase()} ${url} failed${status ? ` (${status})` : ''}: ${message}`);
      e.status = status;
      e.response = err.response?.data;
      throw e;
    }
  }

  get(url, params) {
    return this.request('get', url, null, params);
  }

  post(url, data) {
    return this.request('post', url, data);
  }

  patch(url, data) {
    return this.request('patch', url, data);
  }

  put(url, data) {
    return this.request('put', url, data);
  }

  delete(url) {
    return this.request('delete', url);
  }

  async getCurrentUser() {
    return this.get('/user');
  }

  async listRepos(username, options = {}) {
    const repos = [];
    const perPage = options.perPage || 100;
    for (let page = 1; page <= (options.pages || 3); page++) {
      const batch = await this.get(`/users/${encodeURIComponent(username)}/repos`, {
        per_page: perPage,
        page,
        sort: options.sort || 'updated',
        direction: options.direction || 'desc',
        type: 'owner',
      });
      repos.push(...batch);
      if (batch.length < perPage) break;
    }
    return repos;
  }

  async listAuthenticatedRepos(options = {}) {
    const repos = [];
    const perPage = options.perPage || 100;
    for (let page = 1; page <= (options.pages || 5); page++) {
      const batch = await this.get('/user/repos', {
        per_page: perPage,
        page,
        sort: options.sort || 'updated',
        direction: options.direction || 'desc',
        visibility: 'all',
        affiliation: 'owner,collaborator,organization_member',
      });
      repos.push(...batch);
      if (batch.length < perPage) break;
    }
    return repos;
  }

  async getRepo(fullName) {
    const [owner, repo] = splitRepo(fullName);
    return this.get(`/repos/${owner}/${repo}`);
  }

  async listCommits(fullName, options = {}) {
    const [owner, repo] = splitRepo(fullName);
    return this.get(`/repos/${owner}/${repo}/commits`, {
      per_page: options.perPage || 30,
      since: options.since,
      until: options.until,
      sha: options.sha,
      path: options.path,
    });
  }

  async listIssues(fullName, options = {}) {
    const [owner, repo] = splitRepo(fullName);
    return this.get(`/repos/${owner}/${repo}/issues`, {
      state: options.state || 'open',
      per_page: options.perPage || 30,
      since: options.since,
      labels: options.labels,
    });
  }

  async listPulls(fullName, options = {}) {
    const [owner, repo] = splitRepo(fullName);
    return this.get(`/repos/${owner}/${repo}/pulls`, {
      state: options.state || 'open',
      per_page: options.perPage || 30,
    });
  }

  async listReleases(fullName, options = {}) {
    const [owner, repo] = splitRepo(fullName);
    return this.get(`/repos/${owner}/${repo}/releases`, { per_page: options.perPage || 20 });
  }

  async listWorkflowRuns(fullName, options = {}) {
    const [owner, repo] = splitRepo(fullName);
    return this.get(`/repos/${owner}/${repo}/actions/runs`, {
      per_page: options.perPage || 20,
      status: options.status,
      branch: options.branch,
    });
  }

  async rerunWorkflowRun(fullName, runId) {
    const [owner, repo] = splitRepo(fullName);
    return this.post(`/repos/${owner}/${repo}/actions/runs/${runId}/rerun`, {});
  }

  async cancelWorkflowRun(fullName, runId) {
    const [owner, repo] = splitRepo(fullName);
    return this.post(`/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, {});
  }

  async dispatchWorkflow(fullName, workflowId, ref, inputs = {}) {
    const [owner, repo] = splitRepo(fullName);
    return this.post(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, { ref, inputs });
  }

  async listWorkflowRunJobs(fullName, runId) {
    const [owner, repo] = splitRepo(fullName);
    return this.get(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, { per_page: 100 });
  }

  async getReadme(fullName) {
    const [owner, repo] = splitRepo(fullName);
    const content = await this.get(`/repos/${owner}/${repo}/readme`);
    return decodeContent(content);
  }

  async getFile(fullName, filePath, ref) {
    const [owner, repo] = splitRepo(fullName);
    const content = await this.get(`/repos/${owner}/${repo}/contents/${encodePath(filePath)}`, ref ? { ref } : undefined);
    return decodeContent(content);
  }

  async updateFile(fullName, filePath, content, message, sha, branch) {
    const [owner, repo] = splitRepo(fullName);
    return this.put(`/repos/${owner}/${repo}/contents/${encodePath(filePath)}`, {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha,
      branch,
    });
  }

  async deleteFile(fullName, filePath, message, sha, branch) {
    const [owner, repo] = splitRepo(fullName);
    return this.request('delete', `/repos/${owner}/${repo}/contents/${encodePath(filePath)}`, {
      message,
      sha,
      branch,
    });
  }

  async createIssue(fullName, title, body, options = {}) {
    const [owner, repo] = splitRepo(fullName);
    return this.post(`/repos/${owner}/${repo}/issues`, {
      title,
      body,
      labels: options.labels,
      assignees: options.assignees,
    });
  }

  async updateIssue(fullName, issueNumber, payload) {
    const [owner, repo] = splitRepo(fullName);
    return this.patch(`/repos/${owner}/${repo}/issues/${issueNumber}`, payload);
  }

  async commentIssue(fullName, issueNumber, body) {
    const [owner, repo] = splitRepo(fullName);
    return this.post(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
  }

  async addLabelsToIssue(fullName, issueNumber, labels) {
    const [owner, repo] = splitRepo(fullName);
    return this.post(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, { labels });
  }

  async updateRepo(fullName, payload) {
    const [owner, repo] = splitRepo(fullName);
    return this.patch(`/repos/${owner}/${repo}`, payload);
  }

  async replaceTopics(fullName, names) {
    const [owner, repo] = splitRepo(fullName);
    return this.put(`/repos/${owner}/${repo}/topics`, { names });
  }

  async getBranch(fullName, branch) {
    const [owner, repo] = splitRepo(fullName);
    return this.get(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
  }

  async getRef(fullName, ref) {
    const [owner, repo] = splitRepo(fullName);
    return this.get(`/repos/${owner}/${repo}/git/ref/${encodePath(ref)}`);
  }

  async createRef(fullName, ref, sha) {
    const [owner, repo] = splitRepo(fullName);
    return this.post(`/repos/${owner}/${repo}/git/refs`, { ref, sha });
  }

  async createBranch(fullName, branch, fromBranch) {
    const repo = await this.getRepo(fullName);
    const source = await this.getBranch(fullName, fromBranch || repo.default_branch);
    return this.createRef(fullName, `refs/heads/${branch}`, source.commit.sha);
  }

  async createPullRequest(fullName, { title, head, base, body, draft = false, maintainerCanModify = true }) {
    const [owner, repo] = splitRepo(fullName);
    return this.post(`/repos/${owner}/${repo}/pulls`, {
      title,
      head,
      base,
      body,
      draft,
      maintainer_can_modify: maintainerCanModify,
    });
  }

  async createRelease(fullName, { tagName, targetCommitish, name, body, draft = false, prerelease = false }) {
    const [owner, repo] = splitRepo(fullName);
    return this.post(`/repos/${owner}/${repo}/releases`, {
      tag_name: tagName,
      target_commitish: targetCommitish,
      name,
      body,
      draft,
      prerelease,
    });
  }

  async getTrafficViews(fullName) {
    const [owner, repo] = splitRepo(fullName);
    return this.get(`/repos/${owner}/${repo}/traffic/views`);
  }

  async getTrafficClones(fullName) {
    const [owner, repo] = splitRepo(fullName);
    return this.get(`/repos/${owner}/${repo}/traffic/clones`);
  }

  async listDependabotAlerts(fullName) {
    const [owner, repo] = splitRepo(fullName);
    return this.get(`/repos/${owner}/${repo}/dependabot/alerts`, { per_page: 30 });
  }
}

function splitRepo(fullName) {
  const parts = String(fullName || '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`Invalid repo name: ${fullName}`);
  return parts.map(encodeURIComponent);
}

function encodePath(filePath) {
  return String(filePath).split('/').map(encodeURIComponent).join('/');
}

function decodeContent(content) {
  if (!content || content.type !== 'file') {
    throw new Error('GitHub content is not a file');
  }
  return {
    path: content.path,
    sha: content.sha,
    encoding: content.encoding,
    content: Buffer.from(String(content.content || '').replace(/\n/g, ''), 'base64').toString('utf8'),
    htmlUrl: content.html_url,
  };
}

module.exports = { GitHubClient, splitRepo };
