// Generates the stats and language cards under images/.
// Pull request counts and the language card for merged pull requests need only
// a token that can read public pull requests. The language card for own
// repositories needs STATS_TOKEN, a PAT with read access to repository
// metadata, so that private repositories are counted; without it the existing
// card is left untouched.

import { mkdir, writeFile } from 'node:fs/promises';

const LOGIN = 'saryn17';
const TOKEN = process.env.STATS_TOKEN || process.env.GITHUB_TOKEN;
const HAS_USER_TOKEN = Boolean(process.env.STATS_TOKEN);
const TOP_LANGUAGES = 6;

const THEMES = {
  light: { accent: '#0E6E66', muted: '#3A9188', text: '#1F2D2B', sub: '#5B6B69', bg: '#F3F8F7', track: '#DDE9E7' },
  dark: { accent: '#7FD1C7', muted: '#7FD1C7', text: '#FFFFFF', sub: '#9AA7B2', bg: '#151B23', track: '#2A333D', lightenDark: true },
};

// Colors from github-linguist; anything else falls back to FALLBACK_COLOR.
const LANGUAGE_COLORS = {
  TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572A5', Go: '#00ADD8', Java: '#b07219',
  Shell: '#89e051', HTML: '#e34c26', CSS: '#663399', SCSS: '#c6538c', Rust: '#dea584', Swift: '#F05138',
  Ruby: '#701516', 'C#': '#178600', PowerShell: '#012456', Dockerfile: '#384d54', HCL: '#844FBA',
  Kotlin: '#A97BFF', Vue: '#41b883', MDX: '#fcb32c', Astro: '#ff5a03', Bicep: '#519aba', PLpgSQL: '#336790',
  TSQL: '#e38c00', Makefile: '#427819', 'Jupyter Notebook': '#DA5B0B', Svelte: '#ff3e00',
  Markdown: '#083fa1', YAML: '#cb171e', JSON: '#292929', SQL: '#e38c00', TOML: '#9c4221', C: '#555555',
  'C++': '#f34b7d', Other: '#8b949e',
};

// Extensions of files changed in pull requests; unlisted ones count as Other.
const EXTENSION_LANGUAGES = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  java: 'Java', go: 'Go', py: 'Python', rs: 'Rust', swift: 'Swift', rb: 'Ruby', kt: 'Kotlin', cs: 'C#',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', hpp: 'C++', sh: 'Shell', ps1: 'PowerShell', psm1: 'PowerShell',
  tf: 'HCL', bicep: 'Bicep', sql: 'SQL', html: 'HTML', css: 'CSS', scss: 'SCSS', vue: 'Vue', svelte: 'Svelte',
  astro: 'Astro', md: 'Markdown', mdx: 'MDX', yml: 'YAML', yaml: 'YAML', json: 'JSON', toml: 'TOML',
};
const FILENAME_LANGUAGES = { Dockerfile: 'Dockerfile', Makefile: 'Makefile' };
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
      nodes { ... on PullRequest { number repository { nameWithOwner } } }
    }
  }`;
  const repositories = new Set();
  const pulls = [];
  let after = null;
  let count = 0;
  do {
    const { search } = await graphql(query, { q: `is:pr author:${LOGIN} -user:${LOGIN} ${filter}`, after });
    count = search.issueCount;
    for (const node of search.nodes) {
      repositories.add(node.repository.nameWithOwner);
      pulls.push({ repository: node.repository.nameWithOwner, number: node.number });
    }
    after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
  } while (after);
  return { count, repositories, pulls };
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

async function countRepositoryLanguages() {
  const totals = new Map();
  for (const repository of await listOwnRepositories()) {
    const languages = await request(repository.languages_url);
    for (const [language, bytes] of Object.entries(languages)) {
      totals.set(language, (totals.get(language) ?? 0) + bytes);
    }
  }
  return topLanguages(totals);
}

function fileLanguage(path) {
  const name = path.split('/').pop();
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return FILENAME_LANGUAGES[name] ?? EXTENSION_LANGUAGES[extension] ?? 'Other';
}

// Weighs each language by the lines added and deleted in merged pull requests.
async function countPullRequestLanguages(pulls) {
  const totals = new Map();
  for (const { repository, number } of pulls) {
    for (let page = 1; ; page++) {
      const files = await request(`https://api.github.com/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`);
      for (const file of files) {
        const language = fileLanguage(file.filename);
        totals.set(language, (totals.get(language) ?? 0) + file.additions + file.deletions);
      }
      if (files.length < 100) {
        break;
      }
    }
  }
  return topLanguages(totals);
}

function topLanguages(totals) {
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_LANGUAGES)
    .map(([name, bytes]) => ({ name, share: bytes / sum, color: LANGUAGE_COLORS[name] ?? FALLBACK_COLOR }));
}

// Mixes dark language colors with white so they stay visible on a dark card.
function readableColor(color, theme) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (!theme.lightenDark || luminance >= 0.3) {
    return color;
  }
  return '#' + [r, g, b].map((c) => Math.round(c + (255 - c) * 0.45).toString(16).padStart(2, '0')).join('');
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

function languagesCard(title, languages, theme) {
  const width = 360;
  const barWidth = width - 48;
  let offset = 24;
  languages = languages.map((language) => ({ ...language, color: readableColor(language.color, theme) }));
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
  const height = 88 + Math.ceil(TOP_LANGUAGES / 2) * 22;
  const body = `  <clipPath id="bar"><rect x="24" y="52" width="${barWidth}" height="8" rx="4"/></clipPath>
  <rect x="24" y="52" width="${barWidth}" height="8" rx="4" fill="${theme.track}"/>
  <g clip-path="url(#bar)">
${segments}
  </g>
${legend}`;
  return card(width, height, title, theme, body);
}

const [merged, open, repositoryLanguages] = await Promise.all([
  searchPullRequests('is:merged'),
  searchPullRequests('is:open'),
  HAS_USER_TOKEN ? countRepositoryLanguages() : null,
]);
const pullRequestLanguages = await countPullRequestLanguages(merged.pulls);
const stats = { merged: merged.count, repositories: merged.repositories.size, open: open.count };
console.log(JSON.stringify({ ...stats, mergedRepositories: [...merged.repositories], repositoryLanguages, pullRequestLanguages }, null, 2));

await mkdir('images', { recursive: true });
for (const [name, theme] of Object.entries(THEMES)) {
  await writeFile(`images/stats-${name}.svg`, statsCard(stats, theme));
  await writeFile(`images/pr-languages-${name}.svg`, languagesCard('Languages in merged pull requests', pullRequestLanguages, theme));
  if (repositoryLanguages) {
    await writeFile(`images/languages-${name}.svg`, languagesCard('Languages in my repositories', repositoryLanguages, theme));
  }
}
if (!repositoryLanguages) {
  console.log('STATS_TOKEN is not set; kept the existing language card');
}
