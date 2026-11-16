import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { csvTable, formatScore, orderedEntries } from '../../docs/leaderboard.mjs';

const data = JSON.parse(readFileSync(new URL('../../docs/results.json', import.meta.url), 'utf8'));
const https = value => {
  const url = new URL(value);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.username + url.password, '');
};

function validateEntry(entry, board) {
  assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(typeof entry.method === 'string' && entry.method.trim());
  assert.ok(['reference', 'community'].includes(entry.origin));
  assert.deepEqual(Object.keys(entry.metrics).sort(), board.columns.map(c => c.key).sort());
  for (const column of board.columns) {
    const value = entry.metrics[column.key];
    if (value === null) continue;
    assert.ok(Number.isFinite(value) && value >= 0, `${entry.id}: invalid ${column.key}`);
    if (column.maximum != null) assert.ok(value <= column.maximum);
    if (column.total) assert.ok(Number.isInteger(value));
  }
  assert.ok(Number.isFinite(entry.metrics[board.primary]), 'Primary score is required');
  if (entry.origin === 'community') {
    const r = entry.reproduction;
    assert.ok(r, 'Community results need reproduction evidence');
    assert.equal(r.version, board.version);
    [r.code, r.artifacts, r.review].forEach(https);
    assert.match(r.review, /^https:\/\/github\.com\/XiaoLuoLYG\/agentic-waterfall-dataset\/(issues|pull)\/[1-9]\d*(?:#.*)?$/);
    assert.match(r.revision, /^[a-f0-9]{40}$/);
    assert.ok(typeof r.command === 'string' && r.command.trim());
    assert.ok(typeof r.configuration === 'string' && r.configuration.trim());
    assert.ok(Number.isInteger(r.expected) && r.expected > 0);
    assert.ok(Number.isInteger(r.evaluated) && r.evaluated >= 0 && r.evaluated <= r.expected);
    for (const column of board.columns) {
      if (column.key.includes('votes')) assert.equal(entry.metrics[column.key], null, 'New vote comparisons need a separate track');
      if (column.total) assert.equal(r.expected, column.total);
    }
    if (entry.metrics.scored != null) assert.equal(r.evaluated, entry.metrics.scored);
    if (entry.metrics.complete != null) assert.ok(entry.metrics.complete >= r.evaluated);
  }
}

test('published result data has valid tracks, metrics, URLs and contribution evidence', () => {
  assert.equal(new Set(data.boards.map(b => b.id)).size, data.boards.length);
  for (const board of data.boards) {
    https(board.source);
    assert.ok(['waterfall', 'public', 'ablation'].includes(board.group));
    assert.ok(board.version && board.description && board.protocol && board.evidence);
    assert.equal(new Set(board.columns.map(c => c.key)).size, board.columns.length);
    assert.ok(board.columns.some(c => c.key === board.primary));
    assert.equal(new Set(board.entries.map(e => e.id)).size, board.entries.length);
    for (const column of board.columns) assert.ok(Number.isInteger(column.digits) && column.digits >= 0 && column.digits <= 6);
    for (const view of board.views) {
      assert.ok(view.columns.length);
      for (const key of view.columns) assert.ok(board.columns.some(c => c.key === key));
    }
    for (const entry of board.entries) validateEntry(entry, board);
  }
});

test('the original reported rows retain every reported value and coverage count', () => {
  const values = data.boards.map(b => [b.id, b.entries.filter(e => e.origin === 'reference').map(e => [e.id, e.method, e.metrics])]);
  // Frozen from the original HTML tables before moving the data into JSON.
  assert.equal(createHash('sha256').update(JSON.stringify(values)).digest('hex'), '9fc2467c40401bbd8f9f99334695c505cbd73a31c84c1c915a55a14c0c6a91d4');
});

test('community rows require matching protocols, outputs, coverage and a review', () => {
  const board = data.boards.find(b => b.id === 'independent');
  const entry = {
    id: 'test-method', method: 'Test method', origin: 'community',
    metrics: { dcg: 7, votes: null, scored: 298, complete: 300 },
    reproduction: {
      version: board.version, code: 'https://example.org/code', revision: 'a'.repeat(40),
      artifacts: 'https://example.org/outputs', review: 'https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/issues/1',
      configuration: 'Frozen model, inputs and judge', command: 'python score.py predictions.jsonl', evaluated: 298, expected: 300,
    },
  };
  assert.doesNotThrow(() => validateEntry(entry, board));
  for (const [key, value] of Object.entries({ version: 'other-split', code: 'javascript:alert(1)', artifacts: '', review: 'https://example.org/1', revision: 'main', configuration: '', evaluated: 299, expected: 299 })) {
    assert.throws(() => validateEntry({ ...entry, reproduction: { ...entry.reproduction, [key]: value } }, board), key);
  }
  assert.throws(() => validateEntry({ ...entry, metrics: { ...entry.metrics, votes: 100 } }, board));
});

test('sorting is numeric, missing scores stay last, ties share ranks and filters keep full-table ranks', () => {
  const entries = [
    { id: 'a', method: 'Alpha', origin: 'reference', metrics: { score: 2 } },
    { id: 'b', method: 'Beta', origin: 'community', metrics: { score: 10 } },
    { id: 'c', method: 'Gamma', origin: 'reference', metrics: { score: 10 } },
    { id: 'd', method: 'Missing', origin: 'reference', metrics: { score: null } },
  ];
  assert.deepEqual(orderedEntries(entries, 'score').map(e => [e.id, e.rank]), [['b', 1], ['c', 1], ['a', 3], ['d', null]]);
  assert.deepEqual(orderedEntries(entries, 'score', 'asc').map(e => e.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(orderedEntries(entries, 'score', 'desc', ' ALPHA ', 'reference').map(e => e.rank), [3]);
  assert.equal(orderedEntries(entries, 'score', 'desc', '', 'community').length, 1);
  assert.equal(orderedEntries(entries, 'score', 'desc', 'absent').length, 0);
  assert.deepEqual(entries.map(e => e.id), ['a', 'b', 'c', 'd']);
});

test('score formatting keeps zeros, published precision and coverage', () => {
  assert.equal(formatScore(7.33, { digits: 3 }), '7.330');
  assert.equal(formatScore(0, { digits: 2 }), '0.00');
  assert.equal(formatScore(null, { digits: 2 }), 'Not reported');
  assert.equal(formatScore(299, { digits: 0, total: 300 }), '299/300');
});

test('CSV preserves values and safely quotes formula-like method names', () => {
  const csv = csvTable({ version: 'test', source: 'https://example.org' }, [{ key: 'score' }], [
    { method: '=HYPERLINK("bad")', origin: 'community', metrics: { score: 0 } },
    { method: 'A, B\nC', origin: 'reference', metrics: { score: null } },
  ]);
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"A, B\nC"'));
  assert.ok(csv.includes('"0"'));
  assert.ok(!csv.includes('"null"'));
});
