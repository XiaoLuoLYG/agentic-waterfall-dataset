import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { normalizeContent } from '../../../output/agentic-waterfall/comparison-20261106-synthetic-10x20-all-methods-v4/source/site/lib/waterfall/dataset-format.mjs';

const hash = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

export function readContentPool(path, allowedSources) {
  assert(typeof path === 'string' && isAbsolute(path), 'contentPool must be an absolute frozen archive path');
  path = realpathSync(path);
  const sidecar = path.replace(/\.jsonl\.gz$/, '.manifest.json');
  const manifestPath = sidecar !== path && existsSync(sidecar) ? sidecar : join(dirname(path), 'manifest.json');
  const bytes = readFileSync(path), manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes), cards_sha256 = hash(bytes);
  assert.equal(manifest.cards_path, basename(path), 'frozen pool archive path mismatch');
  assert.equal(manifest.cards_sha256, cards_sha256, 'frozen pool archive hash mismatch');
  const rows = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8').trimEnd().split('\n').map(JSON.parse);
  assert(rows.length >= 21 && rows.length <= 1000, 'frozen pool must contain 21–1000 normalized cards');
  assert.equal(rows.length, manifest.cards_count, 'frozen pool count mismatch');
  assert(Array.isArray(manifest.selected_sources), 'frozen pool source roster missing');
  assert.deepEqual([...new Set(rows.map(row => row.source))].sort(), [...manifest.selected_sources].sort(), 'frozen pool source roster mismatch');
  const cards = rows.map(row => {
    assert(allowedSources.includes(row.source) && row.canonical_url?.startsWith('https://'), 'unavailable or nonpublic frozen source');
    assert(typeof row.source_item_id === 'string' && row.source_item_id && typeof row.title === 'string' && row.title.trim() &&
      typeof row.summary === 'string' && ['text', 'video'].includes(row.metadata?.modality), 'invalid frozen public card');
    const normalized = normalizeContent(row);
    assert.equal(row.content_id, normalized.content_id, 'frozen content identity mismatch');
    assert.equal(row.content_version_id, normalized.content_version_id, 'frozen content version mismatch');
    return {
      id: hash([row.source, row.source_item_id]).slice(0, 24), source_item_id: row.source_item_id,
      content_id: row.content_id, content_version_id: row.content_version_id, content_hash: row.content_version_id.slice(8),
      title: row.title, summary: row.summary, source: row.source, url: row.canonical_url,
      modality: row.metadata.modality, origin: 'frozen_pool',
      ...(row.metadata.duration === undefined ? {} : { duration: row.metadata.duration }),
      ...(row.metadata.published_at === undefined ? {} : { published_at: row.metadata.published_at }),
    };
  });
  for (const field of ['id', 'url', 'content_id', 'content_version_id']) {
    assert.equal(new Set(cards.map(card => card[field])).size, cards.length, 'duplicate frozen pool ' + field);
  }
  return { cards, lineage: {
    path, cards_sha256, manifest_path: manifestPath, manifest_sha256: hash(manifestBytes),
    cards_count: cards.length, selected_sources: manifest.selected_sources, selection_sha256: manifest.selection_sha256 ?? null,
    candidate_policy: 'same public-evidence lexical shortlist of 20 plus a held-out neutral contrast for i2Agent',
  } };
}

function terms(value) {
  const words = String(value ?? '').normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]{2,}/gu) ?? [];
  return new Set(words.flatMap(word => {
    if (!/\p{Script=Han}/u.test(word)) return [word];
    const chars = Array.from(word);
    return chars.slice(0, -1).map((char, index) => char + chars[index + 1]);
  }));
}

export function candidatesForCheckpoint(pool, { provided_profile, evidence }) {
  const seen = new Set(evidence.map(row => row.content_id).filter(Boolean));
  const cards = pool.cards.filter(card => ![card.id, card.content_id, 'ref-' + card.content_id.slice(8, 32)].some(id => seen.has(id)));
  const weights = new Map();
  const add = (text, weight) => { for (const term of terms(text)) weights.set(term, Math.max(weights.get(term) ?? 0, weight)); };
  add([provided_profile.profile, ...provided_profile.interests, ...provided_profile.entries.map(row => row.value)].join(' '), 1);
  for (const row of evidence.filter(row => row.type === 'open' || row.type === 'feedback' && ['like', 'save', 'comment'].includes(row.value)).slice(-20)) {
    add(row.title, 2);
    if (row.value === 'comment') add(row.text, 2);
  }
  evidence.filter(row => row.type === 'command').slice(-3).reverse().forEach((row, index) => add(row.text, 6 - index * 2));
  const query = [...weights.keys()];
  const indexed = cards.map(card => ({ card, title: terms(card.title), snippet: terms(card.summary) }));
  const idf = new Map(query.map(term => [term, Math.log1p(cards.length /
    (1 + indexed.filter(row => row.title.has(term) || row.snippet.has(term)).length))]));
  const ranked = indexed.map(({ card, title, snippet }) => ({
    id: card.id, score: query.reduce((sum, term) => sum + weights.get(term) * idf.get(term) *
      (title.has(term) ? 2 : snippet.has(term) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { cards, candidate_ids: ranked.slice(0, 20).map(row => row.id), contrast_id: ranked[20]?.id ?? null };
}
