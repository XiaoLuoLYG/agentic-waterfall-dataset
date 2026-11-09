import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { read, save, sha } from './collection.mjs';
import { augmentComparison, writeReport } from './delivery.mjs';
import { packDataset } from './pack.mjs';

const at = '2026-11-06T00:00:00.000Z';
const persona = { id: 'u03', subset: 'behavior_ambiguity' };
const options = { A: 'clawrec', B: 'fixed-retrieval', C: 'i2agent', D: 'generic-agent', E: 'waterfall' };
const constraint = { status: 'not_applicable', requirements: {} };
const hash = value => sha(JSON.stringify(value));

function archiveStudy(comparison, round, { legacy = false, partial = false } = {}) {
  const dir = join(comparison, 'studies', persona.id, String(round));
  const ratingQuestions = new Map(), cards = [], slates = {};
  for (const method of Object.values(options)) {
    const length = partial && method === 'i2agent' ? 4 : 5;
    const slate = Array.from({ length }, (_, i) => {
      const duplicate = i === 0 && ['waterfall', 'clawrec'].includes(method);
      const id = duplicate ? 'shared-card' : method + '-card-' + (i + 1);
      const material = { id, title: id, source: 'fixture', content_hash: hash(id), url: 'https://example.test/' + id + '?key=fixture-key' };
      const question = { id: 'rating-' + id, material, material_sha256: hash(material) };
      ratingQuestions.set(id, question);
      cards.push({ method, rank: i + 1, item_id: id, question_id: question.id, material_sha256: question.material_sha256, constraint });
      return { ...material, text: 'Source text for ' + method };
    });
    slates[method] = slate.map(({ text, ...material }) => ({ material, constraint }));
    save(join(comparison, 'runs', persona.id, String(round), method + '.json.gz'),
      gzipSync(JSON.stringify({ run_id: method + '-' + round, methods: [{ method_id: method, status: 'submitted', slate }] })));
  }
  const ratings = [...ratingQuestions.values()];
  const label = (question, decision, origin = 'model') => save(join(dir, 'labels', question.id + '.json'), {
    question_id: question.id, decision, material_sha256: question.material_sha256, origin, evaluated_at: at,
  });
  label(ratings[0], { status: 'rated', rating: 2 });
  if (legacy) {
    const material = { A: slates.waterfall, B: slates.clawrec };
    const pair = { id: 'old-pair', material, material_sha256: hash(material), unavailable: false, same_content: false };
    save(join(dir, 'questions.json'), { ratings, pairs: [pair] });
    save(join(dir, 'mapping.json'), { cards, pairs: [{ question_id: pair.id, A: 'waterfall', B: 'clawrec', opponent: 'clawrec' }] });
    label(pair, { choice: 'B' });
  } else {
    const blind = Array.from({ length: 5 }, (_, i) => {
      const material = Object.fromEntries(Object.entries(options).map(([slot, method]) => [slot, slates[method][i] ?? null]));
      return { id: 'ballot-' + (i + 1), rank: i + 1, material, material_sha256: hash(material), unavailable: partial, same_content: false };
    });
    save(join(dir, 'questions.json'), { ratings, blind });
    save(join(dir, 'mapping.json'), { cards, blind: blind.map(q => ({ question_id: q.id, rank: q.rank, options })) });
    if (partial) label(blind[0], { choice: 'insufficient' }, 'protocol');
    else ['E', 'tie', 'neither', 'insufficient'].forEach((choice, i) => label(blind[i], { choice }));
  }
  return { user: persona.id, round, persona, context: { snapshot: { id: 'checkpoint-' + round, captured_at: at, hash: 'checkpoint-hash-' + round }, public_input: {} } };
}

test('standard import preserves five ranked ballot questions and sparse answers alongside archived A/B', async t => {
  const root = mkdtempSync(join(tmpdir(), 'awf-blind-export-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const user = join(root, 'users', persona.id), comparison = join(root, 'comparison'), target = join(root, 'dataset');
  const session = { id: 'start', kind: 'session', record_kind: 'synthetic', user_id: 'offline-user', participant_id: 'offline-user',
    session_id: 'offline-session', event_time: at, available_at: at };
  save(join(user, 'persona.json'), persona);
  save(join(user, 'events.jsonl'), Buffer.from(JSON.stringify(session) + '\n'));
  save(join(user, 'trajectory.jsonl'), Buffer.from(''));
  const inputs = [archiveStudy(comparison, 4), archiveStudy(comparison, 8, { partial: true }), archiveStudy(comparison, 12, { legacy: true })];
  const results = [{ persona, inputs, trajectory: [] }];
  const quality = { users: [{ user: persona.id, pass: true, valid_rounds: 3 }], pairs: [] };
  const result = packDataset({ root, target, results, quality, augment: (episode, record) => augmentComparison(episode, record, comparison) });
  assert.equal(result.valid, true);
  assert.equal(result.table_counts.ratings, 3);
  assert.equal(result.table_counts.blind_choices, 5);

  const table = name => gunzipSync(readFileSync(join(target, 'main', name + '.jsonl.gz'))).toString().trim().split('\n').map(JSON.parse);
  const ballots = table('questions').filter(q => q.study_id === 'checkpoint-4-blind');
  assert.deepEqual(ballots.map(q => q.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(ballots[0].mapping, options);
  assert.deepEqual(Object.keys(ballots[0].options), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(ballots[0].displayed_material.E.material.id, 'shared-card');
  assert.match(ballots[0].displayed_material.E.material.url, /key=\[REDACTED\]/);
  assert.equal(ballots[4].displayed_material.C.material.id, 'i2agent-card-5');
  const waterfall = table('slates').find(row => row.slate_id === 'checkpoint-4-ratings:waterfall');
  assert.equal(ballots[0].options.E.slate_id, waterfall.slate_id);
  assert.equal(ballots[0].options.E.content_version_id, waterfall.items[0].content_version_id);
  assert.notEqual(ballots[0].options.A.content_version_id, ballots[0].options.E.content_version_id);
  const partial = table('questions').filter(q => q.study_id === 'checkpoint-8-blind');
  assert.equal(partial.length, 5);
  assert(partial.every(q => q.unavailable));
  assert.equal(partial[4].displayed_material.C, null);
  assert.equal(partial[4].options.C.content_version_id, null);
  const pair = table('questions').find(q => q.original_question_id === 'old-pair');
  assert.equal(pair.A.length, 5);
  assert.deepEqual(pair.mapping, { A: 'waterfall', B: 'clawrec' });
  assert.deepEqual(table('blind_choices').map(row => [row.question_id, row.choice]), [
    ['checkpoint-4-blind:ballot-1', 'E'], ['checkpoint-4-blind:ballot-2', 'tie'],
    ['checkpoint-4-blind:ballot-3', 'neither'], ['checkpoint-4-blind:ballot-4', 'insufficient'],
    ['checkpoint-12-blind:old-pair', 'B'],
  ]);

  const blind = { expected_choices: 10, available_choices: 5, answered_choices: 4, unavailable_choices: 5, missing_choices: 1,
    outcomes: { selected: 1, tie: 1, neither: 1, insufficient: 1, unavailable: 5, missing: 1 },
    votes_by_method: { waterfall: .5, clawrec: .5 } };
  const method = { complete_lists: 2, checkpoints: 2, mean_card_interest: 2, rated_cards: 2, mean_dcg_at_5: null,
    dcg_at_5_denominator: 0, hard_compliance: { unknown: 0 } };
  const full = { status: 'completed', by_subset: { all: { methods: { waterfall: method, clawrec: method }, blind } },
    checkpoints: [], coverage: { contexts_total: 2, contexts_done: 2, done: 10, total: 10, label_failures: 0, reused_runs: 0, reused_labels: 0 } };
  save(join(root, 'plan.json'), { created_at: at });
  const api = { stats: () => ({ slots: [], attempts: 0, prompt_tokens: 0, completion_tokens: 0, usage_missing: 0 }) };
  await writeReport({ root, results, quality, full, verification: result, api });
  const report = readFileSync(join(root, 'REPORT.md'), 'utf8');
  assert.match(report, /synthetic-blind\/same-rank-5-v1/);
  assert.match(report, /^\| Waterfall .* \| 0\.50 \|$/m);
  assert.match(report, /^\| 10 \| 5 \| 4 \| 1 \| 1 \| 1 \| 1 \| 5 \| 1 \|$/m);

  const manifest = read(join(target, 'main', 'manifest.json'));
  assert.deepEqual(manifest.content_pool, {
    file: 'contents.jsonl.gz', sha256: sha(readFileSync(join(target, 'main', 'contents.jsonl.gz'))),
    content_versions: result.table_counts.contents,
  });

  const newPersona = { id: 'u10', subset: 'general' };
  const newUser = join(root, 'users', newPersona.id);
  save(join(newUser, 'persona.json'), newPersona);
  save(join(newUser, 'trajectory.jsonl'), Buffer.from(''));
  save(join(newUser, 'events.jsonl'), Buffer.from(JSON.stringify({ ...session,
    id: 'new-start', user_id: 'new-user', participant_id: 'new-user', session_id: 'new-session' }) + '\n'));
  const mixedTarget = join(root, 'mixed');
  const mixed = packDataset({ root, target: mixedTarget, quality, includeCutoffs: true,
    results: [...results, { persona: newPersona, inputs: [{ ...inputs[0], context: { ...inputs[0].context,
      snapshot: { ...inputs[0].context.snapshot, id: 'unlabelled-checkpoint' } } }] }],
    augment: (episode, record) => { if (record.persona.id === persona.id) augmentComparison(episode, record, comparison); },
  });
  assert.equal(mixed.table_counts.contexts, result.table_counts.contexts + 1);
  assert.equal(mixed.table_counts.ratings, result.table_counts.ratings);
  assert.equal(mixed.table_counts.blind_choices, result.table_counts.blind_choices);
  const mixedManifest = read(join(mixedTarget, 'main', 'manifest.json'));
  assert.equal(mixedManifest.collection_stage, 'mixed_evaluated_and_trajectories');
  assert.deepEqual(mixedManifest.evaluation_coverage, { participants_with_studies: 1, participants_without_studies: 1 });
});
