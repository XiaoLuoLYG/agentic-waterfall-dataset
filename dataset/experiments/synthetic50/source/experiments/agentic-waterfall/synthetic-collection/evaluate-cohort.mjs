import assert from 'node:assert/strict';
import { constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { installMeteredFetch } from './api.mjs';
import { loadCohort } from './cohort.mjs';
import { errorText, modelConfigPath, now, phaseAt, read, readLines, reviewBatch, save, sha, userPath } from './collection.mjs';
import { blindProtocol, comparisonMethods, prepareInputs, runComparison, summarizeComparison } from './comparison.mjs';
import { readContentPool } from './comparison-pool.mjs';
import { augmentComparison, writeReport } from './delivery.mjs';
import { packDataset } from './pack.mjs';
import { loadReviewedUsers } from './reuse-reviewed.mjs';

const pin = path => ({ path, sha256: sha(readFileSync(path)) });
const checkpointName = round => 'r' + String(round).padStart(2, '0') + '.json';
const isEvidence = row => row.track === 'feed' && ['command', 'feedback', 'exposure', 'open', 'return'].includes(row.kind) &&
  (row.kind !== 'exposure' || row.phase === 'end');
const archiveNames = ['manifest.json', 'input-lineage.json', 'runtime', 'runs', 'attempts', 'state', 'studies'];
const copyOptions = { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE };

function archiveHashes(root, files) {
  const entries = [];
  function visit(file) {
    const path = join(root, file), stat = lstatSync(path);
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) visit(join(file, child));
    else {
      assert(stat.isFile(), 'non-regular archive entry: ' + file);
      entries.push([file, pin(path).sha256]);
    }
  }
  for (const file of files) visit(file);
  return Object.fromEntries(entries);
}

function loadGeneration(source) {
  const root = realpathSync(source);
  const planPath = join(root, 'plan.json'), plan = read(planPath);
  const progress = read(join(root, 'progress.json'));
  const { pid } = read(join(root, 'run.lock'));
  assert(plan.generation_only && plan.users === 50 && progress.status === 'completed' && progress.pid === pid &&
    progress.generation.status === 'passed' && progress.generation.done === plan.total_rounds &&
    progress.generation.total === plan.total_rounds, '50-person generation is not complete');
  assert(Number.isSafeInteger(pid) && pid > 1);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'generation process is still alive');
  const finalPath = join(root, 'api', 'final.json'), final = read(finalPath);
  assert(final.closed_at && final.in_flight === 0 && final.http_in_flight === 0 && final.waiting === 0 && final.pending.length === 0,
    'generation API requires reconciliation');
  const reportPath = join(root, 'quality', 'generation-batch.json'), report = read(reportPath);
  const reviewPath = join(root, 'quality', 'generation-batch-review.json'), review = read(reviewPath);
  const reportPin = pin(reportPath);
  assert(report.pass && report.format.valid && review.accept === true && review.sha256 === reportPin.sha256 && review.notes,
    'generation-batch approval mismatch');
  const cohort = loadCohort(plan.cohort.path);
  assert.deepEqual(cohort.manifest, plan.cohort);
  assert.deepEqual(cohort.pilotUsers, plan.pilot_users);
  assert.deepEqual(cohort.personas.map(row => row.id).sort(), report.users.filter(row => row.pass).map(row => row.user).sort());
  const format = join(root, 'archive', 'format-check', 'batch', 'main');
  const refsPath = join(format, 'artifact_refs.json'), contextPath = join(format, 'contexts.jsonl.gz');
  const refs = new Map(read(refsPath).filter(row => row.kind === 'private_raw_session')
    .map(row => [resolve(format, row.path), row]));
  const packed = gunzipSync(readFileSync(contextPath)).toString('utf8').trimEnd().split('\n').map(JSON.parse);
  const contexts = new Map(packed.map(row => [row.source_input_snapshot.id, row]));
  assert.equal(contexts.size, report.format.table_counts.contexts, 'accepted cutoff count changed');
  const filesByUser = {};
  const results = cohort.personas.map(persona => {
    const { id } = persona, path = userPath(root, persona), deck = cohort.decks.get(id), checkpoints = cohort.checkpoints.get(id);
    assert.equal(sha(JSON.stringify(deck)), plan.per_user_decks[id], id + ': deck changed');
    assert.equal(deck.length, plan.rounds_by_user[id], id + ': planned round count changed');
    assert.deepEqual(checkpoints, plan.checkpoints_by_user[id], id + ': checkpoint schedule changed');
    const raw = ['events.jsonl', 'persona.json', 'trajectory.jsonl'];
    const checkpointFiles = checkpoints.map(checkpointName);
    assert.deepEqual(readdirSync(path).sort(), ['checkpoints', ...raw], id + ': unexpected raw files');
    assert.deepEqual(readdirSync(join(path, 'checkpoints')).sort(), checkpointFiles, id + ': unexpected cutoff files');
    const files = archiveHashes(path, [...raw, 'checkpoints']);
    for (const file of raw) assert.equal(files[file], refs.get(join(path, file))?.sha256, id + ': raw file hash changed: ' + file);
    assert.deepEqual(read(join(path, 'persona.json')), persona, id + ': persona changed');
    const trajectory = readLines(join(path, 'trajectory.jsonl'));
    const events = readLines(join(path, 'events.jsonl'));
    const evidence = events.filter(isEvidence);
    assert.equal(trajectory.length, deck.length, id + ': trajectory length changed');
    for (const [i, row] of trajectory.entries()) assert.deepEqual(row.presented_cards, deck[i].map(entry => entry.card));
    const inputs = checkpoints.map((round, i) => {
      const context = read(join(path, 'checkpoints', checkpointFiles[i]));
      const archived = contexts.get(context.snapshot.id);
      assert(archived && archived.session_id === refs.get(join(path, 'events.jsonl')).session_id, id + ': cutoff session changed');
      assert.deepEqual(context.snapshot, archived.source_input_snapshot, id + ': cutoff snapshot changed');
      assert.deepEqual(context.public_input, archived.environment.public_input, id + ': cutoff public input changed');
      assert.deepEqual(context.history, evidence.filter(row => row.pilot_round < round || row.pilot_round === round &&
        (!context.snapshot.command || row.kind === 'command')), id + ': cutoff event prefix changed');
      const { goal, hard } = phaseAt(persona, round);
      return { user: id, round, persona: { id, subset: persona.subset, hidden_profile: persona.hidden_profile }, phase: { goal, hard }, context };
    });
    filesByUser[id] = files;
    return { persona, trajectory, inputs, deck, checkpoints };
  });
  assert.equal(results.length, 50);
  const quality = reviewBatch(results);
  assert(quality.pass, 'accepted trajectories no longer pass structural validation');
  assert.deepEqual(quality.users.map(row => [row.user, row.valid_rounds]).sort(), report.users.map(row => [row.user, row.valid_rounds]).sort());
  return { root, cohort, results, quality, generation: progress.generation, filesByUser,
    lineage: { root, plan: pin(planPath), report: reportPin, review: pin(reviewPath), api_final: pin(finalPath), raw_refs: pin(refsPath), format_contexts: pin(contextPath) } };
}

function pilotPrefix(result) {
  const { persona, inputs } = result;
  const transition = persona.pair ? persona.phases[1].start : persona.phases[2].start;
  const index = inputs.findIndex(input => input.round >= transition);
  assert(index >= 1, 'pilot must include both sides of the transition: ' + persona.id);
  return inputs.slice(0, index + 2);
}

export function evaluationWaves(results, reusedIds, pilotIds) {
  const fresh = results.filter(result => !reusedIds.has(result.persona.id));
  const pilot = pilotIds.map(id => fresh.find(result => result.persona.id === id));
  assert(pilot.every(Boolean), 'evaluation pilot must be fresh');
  const prefix = new Map(pilot.map(result => [result.persona.id, pilotPrefix(result)]));
  const blocks = new Map();
  for (const result of fresh) {
    const key = result.persona.pair ? 'pair:' + result.persona.pair : result.persona.id;
    blocks.set(key, [...(blocks.get(key) || []), result]);
  }
  const added = group => group.reduce((sum, result) => sum + result.inputs.length - (prefix.get(result.persona.id)?.length ?? 0), 0);
  const waves = Array.from({ length: Math.ceil(fresh.length / 10) }, () => ({ results: [], added_contexts: 0 }));
  for (const block of [...blocks.values()].sort((a, b) => added(b) - added(a))) {
    const wave = waves.filter(wave => wave.results.length + block.length <= 12)
      .sort((a, b) => a.added_contexts - b.added_contexts || a.results.length - b.results.length)[0];
    assert(wave, 'wave capacity cannot keep the pair together');
    wave.results.push(...block);
    wave.added_contexts += added(block);
  }
  return { prefix, waves };
}

async function preflight(generationRoot, evaluatedRoot) {
  const source = loadGeneration(generationRoot);
  const reused = await loadReviewedUsers(evaluatedRoot, source.cohort);
  const allInputs = source.results.flatMap(row => row.inputs);
  assert.equal(allInputs.length, 300, 'evaluation needs the 300 accepted checkpoints');
  assert.equal(reused.ids.size, 10);
  for (const { persona, inputs } of reused.results) {
    assert.deepEqual(source.results.find(row => row.persona.id === persona.id).inputs, inputs, persona.id + ': accepted comparison cutoffs changed');
    assert.deepEqual(source.filesByUser[persona.id], reused.lineage.users[persona.id].files, persona.id + ': reused raw bytes changed');
  }
  prepareInputs(allInputs);
  const baseline = read(join(reused.comparison, 'analysis.json'));
  const manifestPath = join(reused.comparison, 'manifest.json');
  const { frozen, blinding_seed } = read(manifestPath);
  assert.equal(frozen.module_sha256, sha(readFileSync(new URL('./comparison.mjs', import.meta.url))), 'comparison source differs from accepted baseline');
  assert.deepEqual(frozen.methods, comparisonMethods);
  assert.equal(frozen.blind_protocol, blindProtocol);
  assert.equal(sha(JSON.stringify(frozen)), baseline.config_sha256, 'baseline comparison configuration changed');
  assert(typeof blinding_seed === 'string' && blinding_seed, 'baseline blinding seed missing');
  const pool = readContentPool(frozen.fixed_pool.path, frozen.sources.map(row => row.id));
  assert.deepEqual(pool.lineage, frozen.fixed_pool, 'baseline evaluation pool changed');
  for (const { inputs } of reused.results) for (const { user, round } of inputs) {
    for (const method of comparisonMethods) {
      assert(existsSync(join(reused.comparison, 'runs', user, String(round), method + '.json.gz')), 'baseline cached run missing');
      assert(existsSync(join(reused.comparison, 'attempts', user, String(round), method + '.json')), 'baseline method attempt missing');
    }
    const dir = join(reused.comparison, 'studies', user, String(round));
    const questions = read(join(dir, 'questions.json'));
    assert(existsSync(join(dir, 'mapping.json')), 'baseline question mapping missing');
    for (const { id } of [...questions.ratings, ...questions.blind]) {
      assert(existsSync(join(dir, 'labels', id + '.json')), 'baseline cached label missing');
    }
  }
  assert.equal(baseline.coverage.contexts_done, 57);
  assert.equal(baseline.coverage.labels_done, baseline.coverage.labels_total);
  const { prefix, waves } = evaluationWaves(source.results, reused.ids, source.cohort.pilotUsers);
  const pilotContexts = [...prefix.values()].reduce((sum, inputs) => sum + inputs.length, 0);
  assert(pilotContexts >= 10 && pilotContexts <= 15, 'fresh evaluation pilot should cover 10–15 contexts');
  let cumulative = baseline.coverage.contexts_done + pilotContexts;
  const staged = waves.map(({ results, added_contexts }, i) => ({ wave: i + 1, users: results.map(row => row.persona.id),
    added_contexts, cumulative_contexts: cumulative += added_contexts, cumulative_method_slots: cumulative * comparisonMethods.length }));
  assert.equal(cumulative, allInputs.length, 'waves must cover every cutoff once');
  const plan = { protocol: 'synthetic-cohort-evaluation/1', generation: source.lineage, reused: reused.lineage,
    comparison_manifest: pin(manifestPath), comparison_config_sha256: baseline.config_sha256, evaluation_pool: pool.lineage,
    methods: comparisonMethods, judge: frozen.judge_model, blind_protocol: blindProtocol, users: source.results.length, contexts: allInputs.length,
    method_slots: allInputs.length * comparisonMethods.length, baseline: baseline.coverage,
    pilot: { checkpoints: Object.fromEntries([...prefix].map(([id, rows]) => [id, rows.map(row => row.round)])), fresh_contexts: pilotContexts,
      cumulative_contexts: baseline.coverage.contexts_done + pilotContexts }, waves: staged, raw_files_by_user: source.filesByUser };
  return { source, reused, baseline, prefix, waves, plan, contentPool: pool.lineage.path };
}

function validateStage(full, contexts) {
  return full.status === 'completed' && full.integrity.passed && full.coverage.contexts_done === contexts &&
    full.coverage.done === contexts * comparisonMethods.length && full.coverage.labels_done === full.coverage.labels_total;
}

const [rootArg, generationArg, evaluatedArg] = process.argv.slice(2);
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] || '')) {
  assert(rootArg && generationArg && evaluatedArg && process.argv.length === 5,
    'Usage: node evaluate-cohort.mjs (--check | NEW_EVAL_ROOT) GENERATION_ROOT EVALUATED_ROOT');
  const verified = await preflight(generationArg, evaluatedArg);
  if (rootArg === '--check') {
    const { plan } = verified;
    console.log(JSON.stringify({ passed: true, users: plan.users, contexts: plan.contexts, method_slots: plan.method_slots,
      cached_contexts: plan.baseline.contexts_done, pilot: plan.pilot, waves: plan.waves, comparison_config_sha256: plan.comparison_config_sha256 }));
  } else await evaluate(rootArg, verified);
}

async function evaluate(destination, { source, reused, baseline, prefix, waves, plan, contentPool }) {
  const target = resolve(destination);
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  const root = resolve(realpathSync(existing), relative(existing, target));
  assert([source.root, reused.lineage.root].every(old => root !== old && !root.startsWith(old + sep) && !old.startsWith(root + sep)),
    'evaluation output overlaps accepted evidence');
  assert(['plan.json', 'progress.json', 'comparison', 'users', 'api', 'dataset', 'dataset-pending-review', 'run.lock']
    .every(name => !existsSync(join(root, name))), 'evaluation requires a fresh run directory');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'run.lock'), JSON.stringify({ pid: process.pid, started_at: now() }) + '\n', { flag: 'wx', mode: 0o600 });
  const comparison = join(root, 'comparison'), abort = new AbortController();
  let api, checking = false, lastUpdate = 0;
  const state = { status: 'preparing', phase: '验证既有对比', pid: process.pid, generation: { ...source.generation, status: 'passed' },
    evaluation: { status: 'waiting', done: 0, total: plan.method_slots, labels_done: 0, labels_total: 0, contexts_done: 0, contexts_total: plan.contexts } };
  const update = () => { save(join(root, 'progress.json'), { ...state, updated_at: now() }); lastUpdate = Date.now(); };
  const stop = () => { abort.abort(Error('stopped_by_signal')); api?.drain(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const heartbeat = setInterval(update, 5000);
  try {
    update();
    const archive = archiveHashes(reused.comparison, archiveNames);
    mkdirSync(comparison, { mode: 0o700 });
    for (const entry of archiveNames) cpSync(join(reused.comparison, entry), join(comparison, entry), copyOptions);
    assert.deepEqual(archiveHashes(comparison, archiveNames), archive, 'copied comparison bytes changed');
    for (const { persona } of source.results) {
      const targetUser = userPath(root, persona), files = source.filesByUser[persona.id];
      cpSync(userPath(source.root, persona), targetUser, copyOptions);
      assert.deepEqual(archiveHashes(targetUser, ['events.jsonl', 'persona.json', 'trajectory.jsonl', 'checkpoints']), files, 'copied user bytes changed');
    }
    save(join(root, 'plan.json'), { ...plan, created_at: now(), evaluation_runner_sha256: sha(readFileSync(fileURLToPath(import.meta.url))),
      cached_archive_sha256: sha(JSON.stringify(archive)), cached_archive_files: Object.keys(archive).length });
    api = await installMeteredFetch({ configPath: modelConfigPath, outputDir: root });
    assert.equal(api.stats().slots.length, 3, 'evaluation requires the three reviewed API routes');
    const inputs = new Map(reused.results.map(row => [row.persona.id, row.inputs]));
    const collectProgress = stats => {
      for (const field of ['done', 'labels_done', 'labels_total', 'contexts_done']) state.evaluation[field] = Math.max(state.evaluation[field], stats[field]);
      if (Date.now() - lastUpdate >= 1000) update();
    };
    const run = transport => runComparison({ root: comparison, inputs: [...inputs.values()].flat(), api: transport,
      contentPool, signal: abort.signal, onProgress: collectProgress });
    let unexpectedCalls = 0;
    const forbidden = () => { unexpectedCalls++; throw Error('cached comparison unexpectedly attempted inference'); };
    let full = await run({ ...api, complete: forbidden, generate: forbidden });
    assert.equal(unexpectedCalls, 0, 'cached comparison attempted inference');
    assert(validateStage(full, baseline.coverage.contexts_done) && full.coverage.reused_runs === baseline.coverage.done &&
      full.coverage.reused_labels === baseline.coverage.labels_total, 'baseline comparison did not replay completely');
    assert.deepEqual(full.checkpoints, baseline.checkpoints, 'baseline comparison summary changed');
    assert.deepEqual(archiveHashes(comparison, archiveNames), archive, 'baseline replay changed copied artifacts');
    const probes = await api.preflight();
    assert(probes.some(row => row.family === 'flash' && row.ok), 'no reviewed Flash route is available');

    let previous = full;
    const summarizeNew = (full, previous, contexts) => {
      const seen = new Set(previous.checkpoints.map(row => row.user + ':' + row.round));
      const added = full.checkpoints.filter(row => !seen.has(row.user + ':' + row.round));
      const labels = Object.fromEntries(['labels_done', 'labels_total', 'label_failures', 'label_answers', 'label_protocol_unavailable']
        .map(field => [field, full.coverage[field] - previous.coverage[field]]));
      labels.missing = labels.labels_total - labels.labels_done;
      const summary = summarizeComparison(added, comparisonMethods).by_subset;
      const pass = validateStage(full, contexts) && full.coverage.reused_runs === previous.coverage.done &&
        full.coverage.reused_labels === previous.coverage.labels_total && added.length === contexts - previous.coverage.contexts_done;
      return { pass, expected_contexts: contexts, new_contexts: added.length, new_labels: labels, coverage: full.coverage,
        integrity: full.integrity, by_subset: summary, failures: full.failures };
    };
    for (const [id, rows] of prefix) inputs.set(id, rows);
    state.status = 'running';
    state.phase = '五方法小样';
    Object.assign(state.evaluation, { status: 'running', started_at: now(), baseline_done: previous.coverage.done });
    update();
    full = await run(api);
    const pilot = summarizeNew(full, previous, plan.pilot.cumulative_contexts);
    pilot.pass &&= pilot.new_labels.labels_total > 0 && pilot.new_labels.label_failures / pilot.new_labels.labels_total <= .05 &&
      Object.values(pilot.by_subset.all.methods).every(method => method.complete_lists > 0) && pilot.by_subset.all.blind.answered_choices >= 5;
    const reportPath = join(root, 'quality', 'comparison-pilot.json');
    save(reportPath, { ...pilot, checkpoints: plan.pilot.checkpoints });
    checking = true;
    state.phase = '五方法小样验收';
    state.evaluation.status = 'checking';
    update();
    assert(pilot.pass, 'fresh comparison pilot failed automated acceptance');
    const reviewPath = join(root, 'quality', 'comparison-pilot-review.json');
    while (!existsSync(reviewPath)) await delay(1000, undefined, { signal: abort.signal });
    abort.signal.throwIfAborted();
    const decision = read(reviewPath);
    assert(decision.accept === true && decision.sha256 === pin(reportPath).sha256 && decision.notes, 'comparison pilot approval mismatch');
    checking = false;
    previous = full;

    for (const [{ results }, expected] of waves.map((wave, i) => [wave, plan.waves[i]])) {
      for (const result of results) inputs.set(result.persona.id, result.inputs);
      state.phase = '五方法扩批 ' + expected.wave + '/' + waves.length;
      state.evaluation.status = 'running';
      state.evaluation.wave = expected.wave;
      update();
      full = await run(api);
      const summary = summarizeNew(full, previous, expected.cumulative_contexts);
      summary.pass &&= summary.new_labels.label_failures <= .05 * summary.new_labels.labels_total;
      save(join(root, 'quality', 'comparison-wave-' + String(expected.wave).padStart(2, '0') + '.json'), { ...expected, ...summary });
      checking = true;
      assert(summary.pass, 'comparison wave failed acceptance: ' + expected.wave);
      checking = false;
      previous = full;
    }
    assert(validateStage(full, plan.contexts));
    state.phase = '评估数据导出';
    state.evaluation.status = 'checking';
    update();
    const pending = join(root, 'dataset-pending-review'), dataset = join(root, 'dataset');
    const results = source.results, quality = source.quality;
    const verification = packDataset({ root, target: pending, results, quality, includeCutoffs: true,
      augment: (episode, result) => augmentComparison(episode, result, comparison) });
    assert.equal(verification.table_counts.participants, plan.users);
    assert.equal(verification.table_counts.studies, plan.contexts * 2);
    renameSync(pending, dataset);
    await writeReport({ root, results, quality, full, verification, api, auditResults: results.filter(row => !reused.ids.has(row.persona.id)) });
    state.status = 'completed';
    state.phase = '完成';
    state.evaluation.status = 'completed';
    update();
  } catch (error) {
    state.status = abort.signal.aborted ? 'stopped' : checking ? 'blocked' : 'failed';
    state.evaluation.status = 'blocked';
    state.message = errorText(error);
    update();
    console.error(state.message);
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    if (api) {
      api.restore();
      save(join(root, 'api', 'final.json'), api.stats());
    }
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
