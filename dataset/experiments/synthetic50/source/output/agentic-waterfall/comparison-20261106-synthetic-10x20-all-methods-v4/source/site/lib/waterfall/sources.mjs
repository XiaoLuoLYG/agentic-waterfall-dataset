import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export function nextSourcePage(records,sessionId,action,maxPage=50){
  const inputs=new Set(records.filter(row=>row.kind==='input'&&row.session_id===sessionId&&row.track==='feed').map(row=>row.input_snapshot?.id));
  const issued=records.filter(row=>row.kind==='dataset_capture'&&row.session_id===sessionId&&inputs.has(row.input_snapshot_id)&&row.returned_count>0&&row.capture_status!=='failed'&&row.request?.source===action.source&&row.request?.mode===action.mode&&String(row.request?.query||'').trim()===String(action.query||'').trim()&&Number.isInteger(row.request?.page)&&row.request.page>0);
  const at=row=>Date.parse(row.request_started_at||row.available_at)||0;
  issued.sort((a,b)=>at(a)-at(b)||(a.sequence||0)-(b.sequence||0)||a.request.page-b.request.page);
  return issued.length?issued.at(-1).request.page%maxPage+1:1;
}
export const DEFAULT_SOURCE_CONFIG_PATH = resolve(here, '../../HyperAgent/.worktrees/xuanji-device-latest-20261021/entry/src/main/resources/rawfile/hyperagent_config.local.json');
const DEFINITIONS = [
  ['youtube', 'YouTube', ['search', 'explore'], ['video'], 'Composio YouTube'],
  ['bilibili', '哔哩哔哩', ['search'], ['video'], 'Bilibili public search'],
  ['x', 'X', ['search'], ['text'], 'Composio Twitter'],
  ['hackernews', 'Hacker News', ['search'], ['text'], 'Public Algolia search'],
  ['reddit', 'Reddit', ['search'], ['text'], 'Composio Reddit'],
  ['zhihu', '知乎', ['search', 'explore'], ['text'], 'Zhihu developer API'],
  ['applepodcasts', 'Apple Podcasts', ['search'], ['text'], 'Apple podcast directory'],
  ['twitch', 'Twitch', ['search', 'explore'], ['video'], 'Twitch Helix'],
  ['github', 'GitHub', ['search', 'explore'], ['text'], 'GitHub public API'],
  ['steam', 'Steam 新闻', ['explore'], ['text'], 'Steam news API'],
  ['cnnews', '中文资讯', ['explore'], ['text'], 'Configured public RSS collection'],
  ['globalnews', '国际资讯', ['search', 'explore'], ['text'], 'Guardian / NewsAPI'],
  ['wikipedia', '维基百科', ['search'], ['text'], 'MediaWiki public API']
];
const FEEDS = [
  ['中国新闻网', 'https://www.chinanews.com.cn/rss/scroll-news.xml'],
  ['IT 之家', 'https://www.ithome.com/rss/'],
  ['少数派', 'https://sspai.com/feed'],
  ['爱范儿', 'https://www.ifanr.com/feed']
];
const HOSTS = new Set(['backend.composio.dev', 'api.bilibili.com', 'hn.algolia.com', 'developer.zhihu.com', 'itunes.apple.com', 'id.twitch.tv', 'api.twitch.tv', 'api.github.com', 'api.steampowered.com', 'content.guardianapis.com', 'newsapi.org', 'zh.wikipedia.org', ...FEEDS.map(([, u]) => new URL(u).hostname)]);
const health = new WeakMap();
const accounts = new WeakMap();
const twitchTokens = new WeakMap();
const failure = code => Object.assign(new Error(code), { sourceCode: code });
const RETRY_DELAY_MS = 5 * 60 * 1000;
const retryableFailure = error => error?.retryable === true || /^(?:source_timeout|source_network_error|source_body_error|empty_response|(?:provider_)?http_(?:408|425|429|5\d\d))$/.test(error?.sourceCode || '');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => String(value ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, x => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ' })[x]).replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => { const v = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : ''; }).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

function publicUrl(value) {
  try {
    if (/[\\\s\u0000-\u001f]/.test(String(value || ''))) return '';
    const u = new URL(String(value || '').replace(/^\/\//, 'https://'));
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port || !u.hostname.includes('.') || /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname) || u.hostname.includes(':') || u.hostname.endsWith('.local')) return '';
    u.hash = ''; return u.href;
  } catch { return ''; }
}

// Secrets stay in this server-only object; publish only sourceCatalog(config).
export function loadSourceConfig(path = process.env.XUANJI_CONFIG_FILE || process.env.MODEL_CONFIG_FILE || DEFAULT_SOURCE_CONFIG_PATH) {
  let raw;
  try { raw = JSON.parse(readFileSync(resolve(path), 'utf8')); } catch { throw failure('source_config_unreadable'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('source_config_invalid');
  const config = { providers: raw.providers || {}, composio: raw.composio || {}, allowed: raw.runtime?.waterfall?.sources || {}, rssFeeds: raw.runtime?.waterfall?.rssFeeds || [] };
  health.set(config, {}); return config;
}

function configured(id, c) {
  const p = c.providers || {}, co = c.composio || {};
  if (['youtube', 'reddit', 'x'].includes(id)) return Boolean(co.apiKey && co.userId && co.baseUrl && !co.proxyBaseUrl);
  if (id === 'zhihu') return Boolean(p.ZHIHU_API_KEY);
  if (id === 'twitch') return Boolean(p.TWITCH_CLIENT_ID && p.TWITCH_CLIENT_SECRET);
  if (id === 'globalnews') return Boolean(p.GUARDIAN_API_KEY || p.NEWSAPI_API_KEY);
  return true;
}

export function sourceCatalog(config) {
  const c = config || {}; const observed = health.get(c) || {};
  return DEFINITIONS.map(([id, name, modes, modalities, transport]) => {
    const allowed = c.allowed?.[id]?.allowed !== false;
    const ready = configured(id, c);
    const checks = Object.fromEntries(Object.entries(observed[id]?.checks || {}).map(([mode, check]) => [mode, { ...check, ...(check.status === 'failed' && check.retry_after && Date.now() >= Date.parse(check.retry_after) ? { status: 'unverified' } : {}) }]));
    const statuses = Object.values(checks).map(x => x.status);
    const status = statuses.includes('failed') ? (statuses.every(s => s === 'failed') ? 'failed' : 'partial') : statuses.includes('ok') ? 'ok' : statuses.includes('empty') ? 'empty' : 'unverified';
    return { id, name, modes: [...modes], modalities: [...modalities], configured: ready, allowed, transport, status: !allowed ? 'disabled' : !ready ? 'unconfigured' : status, ...(observed[id] ? { last_check: { ...observed[id].last }, mode_checks: structuredClone(checks) } : {}) };
  });
}

function url(base, params = {}) { const u = new URL(base); u.search = new URLSearchParams(params); return u; }

async function requestSource(address, options = {}, json = true) {
  const u = new URL(address);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !HOSTS.has(u.hostname)) throw failure('endpoint_not_allowed');
  let response;
  try { response = await fetch(u, { ...options, headers: { Accept: 'application/json', 'User-Agent': 'WaterfallDemo/0.2', ...options.headers }, redirect: 'manual', signal: options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) }); }
  catch (e) { throw failure(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'source_timeout' : 'source_network_error'); }
  // Redirects are not followed with credentials or to unreviewed hosts.
  if (!response.ok) { await response.body?.cancel(); throw failure(`http_${response.status}`); }
  const reader = response.body?.getReader(); const chunks = []; let bytes = 0;
  if (!reader) throw failure('empty_response');
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw failure('response_too_large'); } chunks.push(value); }
  } catch (e) { if (e.sourceCode) throw e; throw failure('source_body_error'); }
  const body = Buffer.concat(chunks).toString('utf8');
  if (!json) return body;
  try { return JSON.parse(body); } catch { throw failure('invalid_source_json'); }
}

function item(source, query, raw) {
  const title = text(raw.title).slice(0, 300), link = publicUrl(raw.url);
  if (!title || !link) return null;
  const body = { source, source_item_id: String(raw.id || link), title, summary: text(raw.summary).slice(0, 1600), topic: query || source, url: link, origin: 'live', modality: raw.modality || 'text' };
  if (raw.image) { const image = publicUrl(raw.image); if (image) body.image_url = image.replace(/^http:/, 'https:'); }
  if (raw.author) body.author = text(raw.author).slice(0, 160);
  if (raw.published) body.published_at = text(raw.published).slice(0, 80);
  if (raw.duration) body.duration = text(raw.duration).slice(0, 40);
  const { topic, ...content } = body;
  return { ...body, id: hash([source, body.source_item_id]).slice(0, 24), content_hash: hash(content), captured_at: new Date().toISOString() };
}

function composioBase(c) {
  const u = new URL(c.composio.baseUrl);
  if (u.origin !== 'https://backend.composio.dev' || !/^\/api\/v3(?:\.1)?\/?$/.test(u.pathname) || u.search || u.hash || c.composio.proxyBaseUrl) throw failure('composio_endpoint_not_allowed');
  return u.href.replace(/\/$/, '');
}

async function composio(c, toolkit, slug, args) {
  const base = composioBase(c), headers = { 'x-api-key': c.composio.apiKey, 'Content-Type': 'application/json' };
  // shortcut: first 100 accounts cover the current configuration; paginate if the source account falls beyond that page.
  if (!accounts.has(c)) accounts.set(c, requestSource(url(base + '/connected_accounts', { user_ids: c.composio.userId, statuses: 'ACTIVE', limit: '100', order_by: 'updated_at', order_direction: 'desc' }), { headers,signal:c.signal }).then(d => d.items || []).catch(e => { accounts.delete(c); throw e; }));
  const account = (await accounts.get(c)).find(a => a.toolkit?.slug === toolkit && a.status === 'ACTIVE' && !a.is_disabled);
  if (!account) throw failure('connected_account_unavailable');
  const data = await requestSource(base + '/tools/execute/' + slug, { method: 'POST', headers, signal:c.signal, body: JSON.stringify({ connected_account_id: account.id, user_id: c.composio.userId, arguments: args }) });
  if (data.successful === false || data.error) { const code = Number(data.data?.status_code); throw failure(code >= 400 && code <= 599 ? `provider_http_${code}` : 'provider_execution_failed'); }
  return data.data ?? data;
}

function list(value, ...keys) { for (const key of keys) if (Array.isArray(value?.[key])) return value[key]; return []; }
function epoch(value) { const n = Number(value); return n > 0 && Number.isFinite(n) ? new Date(n * 1000).toISOString() : ''; }

async function getSource(a, c) {
  const request=(address,options={},json=true)=>requestSource(address,{...options,signal:c.signal},json);
  const limits={youtube:50,x:100,hackernews:1000,reddit:100,applepodcasts:200,twitch:100,github:100,steam:1000,globalnews:100,wikipedia:50};
  const q=a.query,explore=a.mode==='explore',n=Math.min(a.limit||6,a.source==='zhihu'?(explore?30:10):(limits[a.source]||6)),p=c.providers||{};
  if (a.source === 'youtube') {
    const d = await composio(c, 'youtube', explore ? 'YOUTUBE_LIST_MOST_POPULAR_VIDEOS' : 'YOUTUBE_SEARCH_YOU_TUBE', explore ? { chart: 'mostPopular', part: 'snippet,statistics', maxResults: n } : { q, part: 'snippet', type: 'video', order: 'relevance', maxResults: n });
    return list(d, 'items').map(v => ({ id: typeof v.id === 'string' ? v.id : v.id?.videoId, title: v.snippet?.title, summary: v.snippet?.description, url: `https://www.youtube.com/watch?v=${typeof v.id === 'string' ? v.id : v.id?.videoId}`, image: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url, author: v.snippet?.channelTitle, published: v.snippet?.publishedAt, modality: 'video' })).filter(v => /^[\w-]{11}$/.test(v.id || ''));
  }
  if (a.source === 'bilibili') {
    const searchUrl=url('https://api.bilibili.com/x/web-interface/search/all/v2', { keyword: q, page: String(a.page || 1) });
    const headers={ Referer: 'https://search.bilibili.com/', Origin: 'https://search.bilibili.com', 'User-Agent': 'Mozilla/5.0 AIPhoneDemo/0.1' };
    let d;
    try { d=await request(searchUrl,{headers});if(d.code===-412)throw failure('http_412'); }
    catch(error) {
      if(error.sourceCode!=='http_412'||!c.bilibiliRelay||!c.browserAcquire)throw error;
      const relay=await c.browserAcquire(a);
      return relay.results.map(row=>({...row,url:`https://www.bilibili.com/video/${row.id}`,modality:'video'}));
    }
    if (d.code !== 0) throw failure(`bilibili_code_${Number(d.code) || 'unknown'}`);
    return list(d.data, 'result').flatMap(x => x.result_type === 'video' ? list(x, 'data') : x.bvid ? [x] : []).filter(x => /^BV[A-Za-z0-9]{10}$/.test(x.bvid)).map(x => ({ id: x.bvid, title: x.title, summary: x.description, url: `https://www.bilibili.com/video/${x.bvid}`, image: x.pic, author: x.author, published: epoch(x.pubdate), duration: x.duration, modality: 'video' }));
  }
  if (a.source === 'hackernews') {
    const d = await request(url('https://hn.algolia.com/api/v1/search', { query: q, tags: 'story', hitsPerPage: String(n) }));
    return list(d, 'hits').filter(x => /^\d+$/.test(x.objectID)).map(x => ({ id: x.objectID, title: x.title, summary: x.story_text || `${Number(x.points) || 0} points · ${Number(x.num_comments) || 0} comments`, url: `https://news.ycombinator.com/item?id=${x.objectID}`, author: x.author, published: x.created_at }));
  }
  if (a.source === 'reddit') {
    const d = await composio(c, 'reddit', 'REDDIT_SEARCH_ACROSS_SUBREDDITS', { search_query: q, limit: n });
    return list(d.data || d, 'children', 'posts', 'results').map(x => x.data || x).map(x => ({ id: x.id || x.name, title: x.title, summary: x.selftext || `${x.subreddit || ''} · ${Number(x.score) || 0} points`, url: x.permalink ? (x.permalink.startsWith('/') ? 'https://www.reddit.com' + x.permalink : x.permalink) : x.url, image: publicUrl(x.thumbnail), author: x.author, published: epoch(x.created_utc) }));
  }
  if (a.source === 'x') {
    const d = await composio(c, 'twitter', 'TWITTER_RECENT_SEARCH', { query: q + ' -is:retweet', max_results: Math.max(10,n), tweet_fields: 'id,text,author_id,created_at', expansions: 'author_id' });
    const users = list(d.includes, 'users');
    return list(d, 'data', 'tweets').map(x => ({ id: x.id, title: text(x.text).slice(0, 110), summary: x.text, url: `https://x.com/i/status/${x.id}`, author: users.find(u => u.id === x.author_id)?.username, published: x.created_at }));
  }
  if (a.source === 'zhihu') {
    const d = await request(url('https://developer.zhihu.com/api/v1/content/' + (explore ? 'hot_list' : 'zhihu_search'), explore ? { Limit: String(n) } : { Query: q, Count: String(n) }), { headers: { Authorization: `Bearer ${p.ZHIHU_API_KEY}`, 'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)) } });
    if (d.Code != null && String(d.Code) !== '0' || d.code != null && String(d.code) !== '0') throw failure('zhihu_provider_error');
    return list(d.Data || d.data || d, 'Items', 'items', 'Results', 'results', 'List', 'list').map(x => ({ id: x.ContentID || x.contentID || x.id || x.Url, title: x.Title || x.title, summary: x.ContentText || x.contentText || x.Snippet || x.snippet || x.Summary || x.summary || x.Description, url: x.Url || x.url || x.Link, image: x.ThumbnailUrl || x.thumbnailUrl, author: x.AuthorName || x.authorName, published: x.EditTime || x.editTime }));
  }
  if (a.source === 'applepodcasts') {
    let d;
    try { d = await request(url('https://itunes.apple.com/search', { term: q, country: /[\u3400-\u9fff]/.test(q) ? 'CN' : 'US', media: 'podcast', entity: 'podcast', limit: String(n) })); }
    catch (error) { if (error.sourceCode !== 'http_429' || !c.browserAcquire) throw error; d = await c.browserAcquire(a); }
    return list(d, 'results').map(x => ({ id: x.collectionId, title: x.collectionName, summary: `播客节目 · ${(x.genres || []).join(' / ')} · ${Number(x.trackCount) || 0} episodes`, url: x.collectionViewUrl, image: x.artworkUrl600 || x.artworkUrl100, author: x.artistName, published: x.releaseDate }));
  }
  if (a.source === 'twitch') {
    let token = twitchTokens.get(c);
    if (!token || token.expires <= Date.now()) { const d = await request('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: p.TWITCH_CLIENT_ID, client_secret: p.TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' }).toString() }); if (!d.access_token) throw failure('twitch_token_unavailable'); token = { value: d.access_token, expires: Date.now() + (Number(d.expires_in) - 60) * 1000 }; twitchTokens.set(c, token); }
    const headers = { 'Client-Id': p.TWITCH_CLIENT_ID, Authorization: `Bearer ${token.value}` };
    const streamItems = explore ? await partial([
      (async () => { const games = await request(url('https://api.twitch.tv/helix/games', [['name', 'Science & Technology'], ['name', 'Software and Game Development'], ['name', 'Makers & Crafting']]), { headers }); const ids = list(games, 'data').map(x => x.id); if (!ids.length) return []; const d = await request(url('https://api.twitch.tv/helix/streams', [['first', String(n<=6?3:n)], ...ids.map(id => ['game_id', id])]), { headers }); return list(d, 'data'); })(),
      (async () => { const games = list(await request(url('https://api.twitch.tv/helix/games/top', { first: '10' }), { headers }), 'data'); const game = games.find(x => x.igdb_id) || games[0]; if (!game) return []; const d = await request(url('https://api.twitch.tv/helix/streams', { game_id: game.id, first: String(n<=6?1:n) }), { headers }); return list(d, 'data'); })()
    ]) : list(await request(url('https://api.twitch.tv/helix/search/channels', { query: q, first: String(n) }), { headers }), 'data');
    const mapped = streamItems.filter(x => x.broadcaster_login || x.user_login).map(x => ({ id: x.id, title: x.title || x.display_name || x.user_name, summary: `${x.game_name || ''} · ${x.is_live === false ? '频道' : '直播'}`, url: `https://www.twitch.tv/${encodeURIComponent(x.broadcaster_login || x.user_login)}`, image: x.thumbnail_url?.replace('{width}', '640').replace('{height}', '360'), author: x.display_name || x.user_name, published: x.started_at, modality: 'video' }));
    mapped.warnings = streamItems.warnings; return mapped;
  }
  if (a.source === 'github') {
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const repositories = (async () => { const d = await request(url('https://api.github.com/search/repositories', { q: explore ? `created:>=${since}` : `${q} in:name,description`, sort: 'stars', order: 'desc', per_page: String(explore && n<=6 ? 2 : n) }), { headers }); return list(d, 'items').map(x => ({ id: 'repo-' + x.id, title: x.full_name, summary: x.description, url: x.html_url, author: x.owner?.login, published: x.updated_at })); })();
    if (!explore) return repositories;
    return partial([repositories, ...['openai/codex', 'microsoft/vscode'].map(async repo => { const d = await request(`https://api.github.com/repos/${repo}/releases/latest`, { headers }); return [{ id: 'release-' + d.id, title: `${repo} · ${d.name || d.tag_name}`, summary: d.body, url: d.html_url, author: d.author?.login, published: d.published_at }]; })]);
  }
  if (a.source === 'steam') {
    const groups = await partial([730, 570, 440].map(async appid => { const d = await request(url('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/', { appid: String(appid), count: String(n), ...(n>6?{maxlength:'1600'}:{}), format: 'json' })); return list(d.appnews, 'newsitems').map(x => ({ id: x.gid, title: x.title, summary: x.contents, url: x.url, author: x.author, published: epoch(x.date) })); }));
    return groups.sort((a, b) => String(b.published).localeCompare(String(a.published)));
  }
  if (a.source === 'cnnews') return partial(FEEDS.map(async ([name, address]) => parseFeed(await request(address, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } }, false), name)));
  if (a.source === 'globalnews') {
    const calls = [];
    if (p.GUARDIAN_API_KEY) calls.push((async () => { const d = await request(url('https://content.guardianapis.com/search', { ...(explore ? {} : { q }), 'order-by': explore ? 'newest' : 'relevance', 'page-size': String(n), 'show-fields': 'trailText,bodyText,byline,thumbnail', 'api-key': p.GUARDIAN_API_KEY })); if (d.response?.status !== 'ok') throw failure('guardian_provider_error'); return list(d.response, 'results').map(x => ({ id: x.id, title: x.webTitle, summary: x.fields?.trailText || x.fields?.bodyText, url: x.webUrl, image: x.fields?.thumbnail, author: x.fields?.byline, published: x.webPublicationDate })); })());
    if (p.NEWSAPI_API_KEY) calls.push((async () => { const d = await request(url('https://newsapi.org/v2/' + (explore ? 'top-headlines' : 'everything'), { ...(explore ? {} : { q, sortBy: 'publishedAt' }), language: 'en', pageSize: String(n) }), { headers: { 'X-Api-Key': p.NEWSAPI_API_KEY } }); if (d.status !== 'ok') throw failure('newsapi_provider_error'); return list(d, 'articles').map(x => ({ id: x.url, title: x.title, summary: x.description || x.content, url: x.url, image: x.urlToImage, author: x.author || x.source?.name, published: x.publishedAt })); })());
    return partial(calls);
  }
  if (a.source === 'wikipedia') {
    const d = await request(url('https://zh.wikipedia.org/w/api.php', { action: 'query', list: 'search', srsearch: q, srlimit: String(n), format: 'json' }));
    return list(d.query, 'search').map(x => ({ id: x.pageid, title: x.title, summary: x.snippet, url: `https://zh.wikipedia.org/?curid=${Number(x.pageid)}` }));
  }
  throw failure('unsupported_source');
}

async function partial(pending) {
  const replies = await Promise.allSettled(pending), good = replies.filter(r => r.status === 'fulfilled');
  if (!good.length) throw Object.assign(failure('all_provider_requests_failed'), { retryable: replies.some(r => retryableFailure(r.reason)) });
  const result = [];
  const groups = good.map(r => r.value);
  for (let i = 0; i < Math.max(0, ...groups.map(g => g.length)); i++) for (const group of groups) if (group[i]) result.push(group[i]);
  result.warnings = replies.filter(r => r.status === 'rejected').map(r => r.reason.sourceCode || 'provider_failed');
  return result;
}

// shortcut: bounded RSS/Atom extraction for the four existing feeds; use an XML parser before adding arbitrary feed formats.
function parseFeed(xml, author) {
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(xml) || /<!ENTITY/i.test(xml)) throw failure('invalid_rss_response');
  const tag = (s, names) => { for (const name of names) { const m = s.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i')); if (m) return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); } return ''; };
  return [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].slice(0, 50).map(([, , s]) => {
    const html = tag(s, ['content:encoded', 'content', 'description', 'summary']);
    return { id: tag(s, ['guid', 'id']), title: tag(s, ['title']), summary: html, url: text(tag(s, ['link'])) || s.match(/<link\b[^>]*href=["']([^"']+)/i)?.[1], image: html.match(/<img\b[^>]*src=["']([^"']+)/i)?.[1] || s.match(/<(?:media:thumbnail|media:content|enclosure)\b[^>]*url=["']([^"']+)/i)?.[1], author: text(tag(s, ['dc:creator', 'author'])) || author, published: tag(s, ['pubDate', 'published', 'updated']) };
  });
}

export async function acquireSource(action, config, { page = 1, excludedIds = [], limit = 6 } = {}) {
  const result = { source: action?.source, query: typeof action?.query === 'string' ? action.query : '', mode: action?.mode, modality: action?.modality, status: 'failed', items: [] };
  let attempted = false, retryable = false, returned = [];
  const started_at = new Date().toISOString();
  try {
    const entry = sourceCatalog(config).find(s => s.id === action?.source);
    if (!entry) throw failure('unsupported_source');
    if (!entry.allowed) throw failure('source_disabled');
    if (!entry.configured) throw failure('source_unconfigured');
    if (!entry.modes.includes(action.mode) || !entry.modalities.includes(action.modality)) throw failure('unsupported_source_mode_or_modality');
    if (typeof action.query !== 'string' || action.query.length > 120 || action.mode === 'search' && !action.query.trim()) throw failure('invalid_source_query');
    attempted = true;
    if(!Number.isInteger(limit)||limit<1||limit>1000)throw failure('invalid_source_limit');
    const rows = await getSource({ ...action, query: action.query.trim(), page, limit }, config);
    returned = rows.map(raw=>({...raw,...item(action.source,action.query.trim(),raw),source:action.source,source_item_id:String(raw.id||raw.url||''),title:raw.title??'',summary:raw.summary??'',text:raw.text??raw.content_text??'',published_at:raw.published??raw.published_at}));
    if (action.source === 'bilibili') result.page = page;
    const items = rows.map(x => item(action.source, action.query.trim(), x)).filter(Boolean);
    result.items = [...new Map(items.map(x => [x.url, x])).values()].filter(x => !excludedIds.includes(x.id)).slice(0, limit);
    result.excluded_count = items.filter(x => excludedIds.includes(x.id)).length;
    if (result.excluded_count) result.raw_items = items;
    result.status = result.items.length ? 'ok' : 'empty';
    if (rows.warnings?.length) result.warnings = rows.warnings;
  } catch (e) { result.error = e.sourceCode || 'source_request_failed'; retryable = retryableFailure(e); }
  result.completed_at = new Date().toISOString();
  if(config?.onCapture&&attempted){try{await config.onCapture({source:action.source,request:{...action,page,limit},results:returned,started_at,completed_at:result.completed_at,status:result.status,...(result.error?{error:result.error}:{})});}catch{console.error('dataset_capture_record_failed');}}
  if (config && attempted) { const h = health.get(config) || {}; const last = { status: result.status, mode: result.mode, count: result.items.length, at: result.completed_at, ...(result.error ? { error: result.error } : {}), ...(retryable ? { retry_after: new Date(Date.now() + RETRY_DELAY_MS).toISOString() } : {}) }; h[action.source] = { last, checks: { ...h[action.source]?.checks, [result.mode]: last } }; health.set(config, h); }
  return result;
}
