import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { acquireSource, loadSourceConfig } from '../comparison-20261106-synthetic-10x20-all-methods-v4/source/site/lib/waterfall/sources.mjs';
import { normalizeContent } from '../comparison-20261106-synthetic-10x20-all-methods-v4/source/site/lib/waterfall/dataset-format.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const prior = resolve(root, '../synthetic-20261107-balanced/pool/reference-with-live.jsonl.gz');
const destination = join(root, 'reference-with-supplement.jsonl.gz');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = bytes => gunzipSync(bytes).toString('utf8').trim().split('\n').map(JSON.parse);
const now = () => new Date().toISOString();
const saved = (name, value) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const configPath = process.env.WATERFALL_SOURCE_CONFIG || resolve(root, '../../../HyperAgent/.worktrees/xuanji-device-latest-20261021/entry/src/main/resources/rawfile/hyperagent_config.local.json');

async function addPhoneText() {
  const manifestPath = join(root, 'reference-supplement.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  const original = readFileSync(destination);
  assert.equal(sha(original), manifest.archive_sha256);
  assert(!existsSync(join(root, 'reference-phone-captures.json.gz')), 'phone text source already queried');
  saved('reference-phone.lock', { pid: process.pid, started_at: now() });
  const config = loadSourceConfig(configPath);
  let captured = null;
  config.onCapture = receipt => { captured = receipt; };
  const action = { source: 'zhihu', mode: 'search', modality: 'text', query: '手机拍照 专业模式 相机参数 曝光 构图 手机摄影设置教程' };
  const result = await acquireSource(action, config, { limit: 10, page: 1 });
  const capture_file = 'reference-phone-captures.json.gz';
  const captureBytes = gzipSync(JSON.stringify({ action, result, captured }));
  writeFileSync(join(root, capture_file), captureBytes, { mode: 0o600, flag: 'wx' });
  const used = new Set(parse(original).flatMap(row => [row.content_id, row.canonical_url]));
  const rows = [];
  for (const [rank, item] of result.items.entries()) {
    if (!item.url?.startsWith('https://') || !/手机|手機|iPhone|Pixel|Galaxy/i.test(item.title) ||
        !/专业模式|專業模式|曝光|构图|構圖|相机参数|相機參數|快门|快門|相机设置|相機設定|HDR|夜景/i.test(item.title + ' ' + item.summary) ||
        /预算|預算|买哪|買哪|选购|選購|收音|配件|手机壳|手機殼/i.test(item.title) || item.summary.length < 55) continue;
    const row = normalizeContent(item);
    if (used.has(row.content_id) || used.has(row.canonical_url)) continue;
    used.add(row.content_id);
    used.add(row.canonical_url);
    rows.push({ row, rank: rank + 1 });
  }
  assert(rows.length, 'no new on-topic phone tutorial text captured');
  const combined = Buffer.concat([original, gzipSync(rows.map(({ row }) => JSON.stringify(row)).join('\n') + '\n')]);
  writeFileSync(destination + '.tmp', combined, { mode: 0o600 });
  renameSync(destination + '.tmp', destination);
  manifest.actions.push({ ...action, status: result.status, count: result.items.length, error: result.error || null,
    capture_file, capture_sha256: sha(captureBytes) });
  manifest.archive_sha256 = sha(combined);
  manifest.appended_rows += rows.length;
  manifest.lineage.push(...rows.map(({ row, rank }) => ({ content_version_id: row.content_version_id, topic: 'phone_photo',
    origin: 'live_search', capture_file, rank })));
  writeFileSync(manifestPath + '.tmp', JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  renameSync(manifestPath + '.tmp', manifestPath);
  console.log(JSON.stringify({ appended_phone_text: rows.map(({ row }) => [row.content_version_id, row.title]),
    archive_sha256: sha(combined) }));
}

if (process.argv[2] === '--append-phone-text') {
  await addPhoneText();
  process.exit(0);
}
assert(process.argv[2] === '--capture', 'Use --capture for the four reviewed source actions');
assert(!existsSync(destination) && !existsSync(join(root, 'reference-supplement.lock')), 'supplement already attempted');
saved('reference-supplement.lock', { pid: process.pid, started_at: now() });

const source = loadSourceConfig(configPath);
const observations = new Map();
source.onCapture = receipt => { observations.set(receipt.source + '\0' + receipt.request.query, receipt); };
const actions = [
  { source: 'zhihu', mode: 'search', modality: 'text', query: '适合全家和孩子一起看的电影 纪录片 推荐 片单' },
  { source: 'bilibili', mode: 'search', modality: 'video', query: '适合亲子一起看 高分自然科普纪录片 电影片单 推荐' },
  { source: 'youtube', mode: 'search', modality: 'video', query: 'best family friendly documentaries for kids nature film recommendations to watch together' },
  { source: 'bilibili', mode: 'search', modality: 'video', query: '适合家长孩子一起看 亲子电影 片单 推荐 周末' },
];
const receipts = [];
for (let start = 0; start < actions.length; start += 2) {
  receipts.push(...await Promise.all(actions.slice(start, start + 2).map(async action => {
    const result = await acquireSource(action, source, { limit: 12, page: 1 });
    return { action, result, captured: observations.get(action.source + '\0' + action.query) || null };
  })));
}
const captureFile = 'reference-film-captures.json.gz';
const captureBytes = gzipSync(JSON.stringify(receipts));
writeFileSync(join(root, captureFile), captureBytes, { mode: 0o600, flag: 'wx' });
const original = readFileSync(prior), initial = parse(original);
const used = new Set(initial.flatMap(row => [row.content_id, row.canonical_url]));
const appended = [], lineage = [];
function add(row, topic, origin) {
  if (used.has(row.content_id) || used.has(row.canonical_url)) return;
  assert(row.canonical_url?.startsWith('https://') && ['video', 'text'].includes(row.metadata?.modality));
  used.add(row.content_id); used.add(row.canonical_url);
  appended.push(row);
  lineage.push({ content_version_id: row.content_version_id, topic, ...origin });
}
for (const [index, receipt] of receipts.entries()) {
  let accepted = 0;
  for (const [rank, item] of receipt.result.items.entries()) {
    if (accepted >= 5 || !item.url?.startsWith('https://')) break;
    const title = item.title;
    if (!/纪录片|紀錄片|电影|電影|片单|片單|movie|film|documentar/i.test(title) ||
        !/亲子|親子|孩子|儿童|兒童|推荐|推薦|片单|片單|适合|適合|科普|family|kids|children|nature|recommend|watch/i.test(title + ' ' + item.summary) ||
        /拍摄教程|拍攝教程|电影感|電影感|剪辑教程|剪輯教程|摄影机/i.test(title)) continue;
    const before = appended.length;
    add(normalizeContent(item), 'films', { origin: 'live_search', capture_index: index, rank: rank + 1 });
    if (appended.length > before) accepted++;
  }
}
const archivePins = [
  ['running_plan', '../synthetic-20261107-balanced/pool/evaluation-catalog.jsonl.gz',
    ['98e7ad8c2b478f685d442bdcdbcc4f757569ed3c986544fba8b3c6ccd421a3c9', 'a7c894f4cd0c21390e4ccf0e67f722e864ad823dca89090ab23eb43b82ac5acd']],
  ['running_plan', '../synthetic-repair-20261106-r2/dataset/main/contents.jsonl.gz',
    ['2aa497db451495fe2dc093e5fd24834b6ba11ca5d90065e1dff358ee7f25b549']],
  ['running_knee', '../synthetic-pilot-20261105-10x20/main-v2/contents.jsonl.gz',
    ['34b816c3ee51540d5501bebf8fe71bb6c0d41f65bb60a228f75e72539d2dcff6', '18ab620a43f5f3bac6b96b58ac509e6b5655ec6fa192c536467a38333dc58866']],
];
for (const [topic, path, pins] of archivePins) {
  const absolute = resolve(root, path), bytes = readFileSync(absolute), rows = parse(bytes);
  for (const pin of pins) {
    const row = rows.find(value => value.content_version_id === 'version:' + pin);
    if (row) add(row, topic, { origin: 'prior_verified_archive', archive: absolute, archive_sha256: sha(bytes) });
  }
}
assert(lineage.filter(row => row.topic === 'films').length >= 4, 'fewer than four relevant public film captures');
const suffix = gzipSync(appended.map(row => JSON.stringify(row)).join('\n') + '\n');
const combined = Buffer.concat([original, suffix]);
assert(combined.subarray(0, original.length).equals(original));
assert.equal(parse(combined).length, initial.length + appended.length);
writeFileSync(destination, combined, { mode: 0o600, flag: 'wx' });
saved('reference-supplement.json', {
  base_path: prior, base_sha256: sha(original), base_bytes: original.length, base_rows: initial.length,
  archive_sha256: sha(combined), appended_rows: appended.length, capture_file: captureFile, capture_sha256: sha(captureBytes),
  captured_at: now(), actions: receipts.map(({ action, result }) => ({ ...action, status: result.status, count: result.items.length, error: result.error || null })),
  lineage,
});
console.log(JSON.stringify({ base_rows: initial.length, appended: appended.length, archive_sha256: sha(combined),
  film_count: lineage.filter(row => row.topic === 'films').length, captures: receipts.map(row => [row.action.source, row.result.status, row.result.items.length]) }));
