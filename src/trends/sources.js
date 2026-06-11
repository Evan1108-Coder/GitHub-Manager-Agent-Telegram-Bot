const axios = require('axios');
const cheerio = require('cheerio');

async function fetchGitHubTrending(language = '') {
  const url = `https://github.com/trending/${encodeURIComponent(language)}?since=daily`;
  const res = await axios.get(url, { timeout: 30000, headers: { 'User-Agent': 'GitHub-Manager-Agent-Telegram-Bot' } });
  const $ = cheerio.load(res.data);
  const repos = [];
  $('article.Box-row').slice(0, 8).each((_, el) => {
    const title = $(el).find('h2 a').text().replace(/\s+/g, ' ').trim();
    const href = $(el).find('h2 a').attr('href');
    const description = $(el).find('p').first().text().replace(/\s+/g, ' ').trim();
    const meta = $(el).text().replace(/\s+/g, ' ');
    const starsToday = (meta.match(/(\d[\d,]*) stars today/) || [])[1] || '';
    if (title && href) repos.push({ source: 'GitHub', title, description, url: `https://github.com${href}`, metric: starsToday ? `${starsToday} today` : '' });
  });
  return repos;
}

async function fetchHackerNews() {
  const ids = await axios.get('https://hacker-news.firebaseio.com/v0/topstories.json', { timeout: 20000 }).then(r => r.data.slice(0, 12));
  const items = await Promise.all(ids.map(id => axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeout: 20000 }).then(r => r.data).catch(() => null)));
  return items.filter(Boolean).slice(0, 8).map(item => ({
    source: 'HN',
    title: item.title,
    description: `${item.score || 0} points, ${item.descendants || 0} comments`,
    url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
    metric: `${item.score || 0} pts`,
  }));
}

async function fetchDevTo() {
  const res = await axios.get('https://dev.to/api/articles', { params: { top: 1, per_page: 8 }, timeout: 20000 });
  return res.data.map(item => ({
    source: 'Dev.to',
    title: item.title,
    description: item.description || item.tags,
    url: item.url,
    metric: `${item.public_reactions_count || 0} reactions`,
  }));
}

async function fetchReddit() {
  const url = 'https://www.reddit.com/r/programming+webdev+javascript+python+opensource/hot.json?limit=8';
  const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'GitHubManagerAgentBot/0.1' } });
  return res.data.data.children.map(child => {
    const item = child.data;
    return {
      source: 'Reddit',
      title: item.title,
      description: `r/${item.subreddit}, ${item.score || 0} upvotes, ${item.num_comments || 0} comments`,
      url: `https://www.reddit.com${item.permalink}`,
      metric: `${item.score || 0} upvotes`,
    };
  });
}

async function fetchProductHunt() {
  const res = await axios.get('https://www.producthunt.com/feed', { timeout: 20000 });
  const $ = cheerio.load(res.data, { xmlMode: true });
  const items = [];
  $('item').slice(0, 8).each((_, el) => {
    items.push({
      source: 'Product Hunt',
      title: $(el).find('title').text().trim(),
      description: $(el).find('description').text().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      url: $(el).find('link').text().trim(),
      metric: '',
    });
  });
  return items;
}

async function fetchAllTrends() {
  const settled = await Promise.allSettled([
    fetchGitHubTrending(),
    fetchHackerNews(),
    fetchReddit(),
    fetchProductHunt(),
    fetchDevTo(),
  ]);
  return settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

module.exports = {
  fetchGitHubTrending,
  fetchHackerNews,
  fetchReddit,
  fetchProductHunt,
  fetchDevTo,
  fetchAllTrends,
};
