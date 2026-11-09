import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadCohort } from './cohort.mjs';
import { phaseAt, read, readLines, reviewBatch, sha, userPath } from './collection.mjs';

const pin = path => ({ path, sha256: sha(readFileSync(path)) });

export async function loadReviewedUsers(source, cohort) {
  const root = realpathSync(source);
  const planPath = join(root, 'plan.json');
  const plan = read(planPath), progress = read(join(root, 'progress.json'));
  assert(progress.status === 'completed' && progress.generation.status === 'passed' &&
    progress.generation.done === plan.total_rounds && progress.generation.total === plan.total_rounds,
  'reuse requires completed, reviewed generation');
  const continuation = join(root, 'run-continuation.lock');
  const locks = [read(join(root, 'run.lock')), ...(existsSync(continuation) ? [read(continuation)] : [])];
  assert.equal(locks.at(-1).pid, progress.pid, 'source run lock does not match its progress');
  for (const { pid } of locks) {
    assert(Number.isSafeInteger(pid) && pid > 1, 'invalid source run PID');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'source run is still alive');
  }
  const finalPath = join(root, 'api', 'final.json'), final = read(finalPath);
  assert(final.closed_at && final.in_flight === 0 && final.http_in_flight === 0 && final.waiting === 0 && final.pending.length === 0,
    'source API requests require reconciliation');
  const reportPath = join(root, 'quality', 'generation-batch.json'), report = read(reportPath);
  const reviewPath = join(root, 'quality', 'generation-batch-review.json'), review = read(reviewPath);
  const reportPin = pin(reportPath);
  assert(report.pass && report.format.valid && review.accept === true && review.sha256 === reportPin.sha256 && review.notes,
    'source batch approval mismatch');
  const prior = loadCohort(plan.cohort.path);
  assert.deepEqual(prior.manifest, plan.cohort, 'source cohort changed');
  const ids = prior.personas.map(persona => persona.id).sort();
  assert.equal(ids.length, plan.users);
  assert.deepEqual(ids, report.users.filter(user => user.pass).map(user => user.user).sort(), 'source participant review mismatch');
  assert(cohort.pilotUsers.every(id => !ids.includes(id)), 'pilot users must be fresh');

  const refsPath = join(root, 'archive', 'format-check', 'batch', 'main', 'artifact_refs.json');
  const refs = new Map(read(refsPath).filter(row => row.kind === 'private_raw_session')
    .map(row => [resolve(dirname(refsPath), row.path), row]));
  const rawNames = ['events.jsonl', 'persona.json', 'trajectory.jsonl'];
  const users = {};
  const results = prior.personas.map(persona => {
    const { id } = persona, path = userPath(root, persona), deck = cohort.decks.get(id), checkpoints = cohort.checkpoints.get(id);
    assert.deepEqual(cohort.personas.find(row => row.id === id), persona, id + ': reviewed persona changed');
    assert.deepEqual(read(join(path, 'persona.json')), persona, id + ': raw persona changed');
    assert.equal(deck.length, plan.rounds_by_user[id], id + ': reviewed round count changed');
    assert.equal(sha(JSON.stringify(deck)), plan.per_user_decks[id], id + ': reviewed reference deck changed');
    assert.deepEqual(deck, prior.decks.get(id), id + ': original cohort deck changed');
    assert.deepEqual(checkpoints, plan.checkpoints_by_user[id], id + ': reviewed checkpoint schedule changed');
    assert.deepEqual(checkpoints, prior.checkpoints.get(id), id + ': original checkpoint schedule changed');
    assert(lstatSync(path).isDirectory() && lstatSync(join(path, 'checkpoints')).isDirectory(), id + ': invalid raw directory');
    assert.deepEqual(readdirSync(path).sort(), ['checkpoints', ...rawNames], id + ': unexpected raw files');
    const names = checkpoints.map(round => 'r' + String(round).padStart(2, '0') + '.json');
    assert.deepEqual(readdirSync(join(path, 'checkpoints')).sort(), names, id + ': raw checkpoint files changed');
    const files = Object.fromEntries([...rawNames, ...names.map(name => join('checkpoints', name))].map(file => {
      const location = join(path, file);
      assert(lstatSync(location).isFile(), id + ': invalid raw file');
      const { sha256 } = pin(location);
      if (rawNames.includes(file)) assert.equal(sha256, refs.get(location)?.sha256, id + ': reviewed raw file changed: ' + file);
      return [file, sha256];
    }));
    const trajectory = readLines(join(path, 'trajectory.jsonl'));
    assert.equal(trajectory.length, deck.length, id + ': raw round count changed');
    for (const [index, row] of trajectory.entries()) assert.deepEqual(row.presented_cards, deck[index].map(entry => entry.card));
    const inputs = checkpoints.map((round, i) => {
      const context = read(join(path, 'checkpoints', names[i]));
      const { goal, hard } = phaseAt(persona, round);
      return { user: id, round, persona: { id, subset: persona.subset, hidden_profile: persona.hidden_profile }, phase: { goal, hard }, context };
    });
    users[id] = { path, files, session_id: refs.get(join(path, 'events.jsonl')).session_id };
    return { persona, trajectory, inputs, deck, checkpoints };
  });
  assert(reviewBatch(results).pass, 'source trajectories fail current structural checks');

  const comparison = join(root, 'comparison');
  assert(!existsSync(join(comparison, 'comparison.lock')), 'source comparison is locked');
  const analysisPath = join(comparison, 'analysis.json'), analysis = read(analysisPath);
  const lineagePath = join(comparison, 'input-lineage.json');
  const { prepareInputs } = await import('./comparison.mjs');
  const inputs = results.flatMap(result => result.inputs);
  const lineage = Object.fromEntries([...prepareInputs(inputs)].map(([id, track]) => [id,
    track.map(({ round, subset, input_sha256, public_input_sha256, phase_sha256 }) => ({ round, subset, input_sha256, public_input_sha256, phase_sha256 }))]));
  assert.deepEqual(lineage, read(lineagePath), 'source comparison checkpoint lineage changed');
  assert(analysis.status === 'completed' && analysis.integrity.passed && progress.evaluation.status === 'completed' &&
    analysis.coverage.contexts_done === inputs.length && analysis.coverage.done === progress.evaluation.total, 'source comparison is incomplete');
  const manifestPath = join(root, 'dataset', 'main', 'manifest.json');
  const tableCounts = read(manifestPath).table_counts;
  assert.equal(tableCounts.participants, results.length, 'source dataset participant count changed');
  const receiptsPath = join(root, 'api', 'receipts.jsonl');
  assert.equal(readLines(receiptsPath).length, final.attempts, 'source API receipt count changed');
  return {
    results, ids: new Set(ids), comparison, tableCounts,
    lineage: { root, users, plan: pin(planPath), generation_report: reportPin, generation_review: pin(reviewPath),
      raw_refs: pin(refsPath), api_final: pin(finalPath), api_receipts: { ...pin(receiptsPath), count: final.attempts },
      comparison_analysis: pin(analysisPath), comparison_inputs: pin(lineagePath), dataset_manifest: pin(manifestPath) },
  };
}
