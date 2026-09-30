// Generates the stats and language cards under images/.
// Pull request counts need only a token that can search public pull requests.
// The language card needs STATS_TOKEN, a PAT with read access to repository
// metadata, so that private repositories are counted; without it the existing
// language card is left untouched.

import { mkdir, writeFile } from 'node:fs/promises';

const LOGIN = 'saryn17';
const TOKEN = process.env.STATS_TOKEN || process.env.GITHUB_TOKEN;
const HAS_USER_TOKEN = Boolean(process.env.STATS_TOKEN);
const TOP_LANGUAGES = 6;

const THEMES = {
  light: { accent: '#0E6E66', muted: '#3A9188', text: '#1F2D2B', sub: '#5B6B69', bg: '#F3F8F7', track: '#DDE9E7' },
  dark: { accent: '#7FD1C7', muted: '#7FD1C7', text: '#FFFFFF', sub: '#9AA7B2', bg: '#151B23', track: '#2A333D' },
};

// Colors from github-linguist; anything else falls back to FALLBACK_COLOR.
const LANGUAGE_COLORS = {
  TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572A5', Go: '#00ADD8', Java: '#b07219',
  Shell: '#89e051', HTML: '#e34c26', CSS: '#663399', SCSS: '#c6538c', Rust: '#dea584', Swift: '#F05138',
  Ruby: '#701516', 'C#': '#178600', PowerShell: '#012456', Dockerfile: '#384d54', HCL: '#844FBA',
  Kotlin: '#A97BFF', Vue: '#41b883', MDX: '#fcb32c', Astro: '#ff5a03', Bicep: '#519aba', PLpgSQL: '#336790',
  TSQL: '#e38c00', Makefile: '#427819', 'Jupyter Notebook': '#DA5B0B', Svelte: '#ff3e00',
};
const FALLBACK_COLOR = '#8b949e';
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

async function request(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', ...init.headers },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function graphql(query, variables) {
  const { data, errors } = await request('https://api.github.com/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  if (errors) {
    throw new Error(JSON.stringify(errors));
  }
  return data;
}

async function searchPullRequests(filter) {
  const query = `query($q: String!, $after: String) {
    search(type: ISSUE, query: $q, first: 100, after: $after) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest { repository { nameWithOwner } } }
    }
  }`;
  const repositories = new Set();
  let after = null;
  let count = 0;
  do {
    const { search } = await graphql(query, { q: `is:pr author:${LOGIN} -user:${LOGIN} ${filter}`, after });
    count = search.issueCount;
    search.nodes.forEach((node) => repositories.add(node.repository.nameWithOwner));
    after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
  } while (after);
  return { count, repositories };
}

async function listOwnRepositories() {
  const base = 'https://api.github.com/user/repos?affiliation=owner&visibility=all';
  const repositories = [];
  for (let page = 1; ; page++) {
    const batch = await request(`${base}&per_page=100&page=${page}`);
    repositories.push(...batch);
    if (batch.length < 100) {
      return repositories.filter((repository) => !repository.fork);
    }
  }
}

async function countLanguages() {
  const totals = new Map();
  for (const repository of await listOwnRepositories()) {
    const languages = await request(repository.languages_url);
    for (const [language, bytes] of Object.entries(languages)) {
      totals.set(language, (totals.get(language) ?? 0) + bytes);
    }
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_LANGUAGES)
    .map(([name, bytes]) => ({ name, share: bytes / sum, color: LANGUAGE_COLORS[name] ?? FALLBACK_COLOR }));
}

function escapeXml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

function card(width, height, title, theme, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <rect width="${width}" height="${height}" rx="10" fill="${theme.bg}"/>
  <text x="24" y="36" font-family="${FONT}" font-size="15" font-weight="600" fill="${theme.accent}">${escapeXml(title)}</text>
${body}
</svg>
`;
}

function statsCard(stats, theme) {
  const columns = [
    ['MERGED', stats.merged],
    ['REPOS', stats.repositories],
    ['IN REVIEW', stats.open],
  ];
  const width = 360;
  const step = (width - 48) / columns.length;
  const body = columns.map(([label, value], i) => {
    const x = 24 + step * i + step / 2;
    return `  <text x="${x}" y="98" text-anchor="middle" font-family="${FONT}" font-size="34" font-weight="700" fill="${theme.text}">${value}</text>
  <text x="${x}" y="124" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" letter-spacing="1" fill="${theme.sub}">${label}</text>`;
  }).join('\n');
  return card(width, 154, 'External pull requests', theme, body);
}

function languagesCard(languages, theme) {
  const width = 360;
  const barWidth = width - 48;
  let offset = 24;
  const segments = languages.map(({ share, color }) => {
    const segmentWidth = Math.max(barWidth * share / languages.reduce((a, l) => a + l.share, 0), 2);
    const rect = `    <rect x="${offset.toFixed(2)}" y="52" width="${segmentWidth.toFixed(2)}" height="8" fill="${color}"/>`;
    offset += segmentWidth;
    return rect;
  }).join('\n');
  const legend = languages.map(({ name, share, color }, i) => {
    const x = 24 + (i % 2) * (barWidth / 2);
    const y = 88 + Math.floor(i / 2) * 22;
    return `  <circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${color}"/>
  <text x="${x + 16}" y="${y}" font-family="${FONT}" font-size="12" fill="${theme.text}">${escapeXml(name)} <tspan fill="${theme.sub}">${(share * 100).toFixed(1)}%</tspan></text>`;
  }).join('\n');
  const height = 88 + Math.ceil(languages.length / 2) * 22;
  const body = `  <clipPath id="bar"><rect x="24" y="52" width="${barWidth}" height="8" rx="4"/></clipPath>
  <rect x="24" y="52" width="${barWidth}" height="8" rx="4" fill="${theme.track}"/>
  <g clip-path="url(#bar)">
${segments}
  </g>
${legend}`;
  return card(width, height, 'Languages', theme, body);
}

const [merged, open, languages] = await Promise.all([
  searchPullRequests('is:merged'),
  searchPullRequests('is:open'),
  HAS_USER_TOKEN ? countLanguages() : null,
]);
const stats = { merged: merged.count, repositories: merged.repositories.size, open: open.count };
console.log(JSON.stringify({ ...stats, mergedRepositories: [...merged.repositories], languages }, null, 2));

await mkdir('images', { recursive: true });
for (const [name, theme] of Object.entries(THEMES)) {
  await writeFile(`images/stats-${name}.svg`, statsCard(stats, theme));
  if (languages) {
    await writeFile(`images/languages-${name}.svg`, languagesCard(languages, theme));
  }
}
if (!languages) {
  console.log('STATS_TOKEN is not set; kept the existing language card');
}
