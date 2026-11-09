import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { sourceCatalog } from '../../../output/agentic-waterfall/comparison-20261106-synthetic-10x20-all-methods-v4/source/site/lib/waterfall/sources.mjs';
import { installMeteredFetch } from './api.mjs';
import { checkpointsFor, collectUser, errorText, makeDecks, modelConfigPath, now, phaseAt, pilotUsers, read, readLines, referenceArchive, reviewBatch, ROUNDS, save, scenarios, sha, userPath } from './collection.mjs';
import { loadCohort } from './cohort.mjs';
import { packDataset } from './pack.mjs';
import { loadReviewedUsers } from './reuse-reviewed.mjs';

function cohortSchedule({ decks, checkpoints, pilotUsers }) {
  const rounds_by_user = Object.fromEntries([...decks].map(([id, deck]) => [id, deck.length]));
  return {
    rounds_by_user, checkpoints_by_user: Object.fromEntries(checkpoints),
    total_rounds: Object.values(rounds_by_user).reduce((sum, length) => sum + length, 0),
    pilot_rounds: pilotUsers.reduce((sum, id) => sum + rounds_by_user[id], 0),
  };
}
const rootArg = process.argv[2];
if (rootArg === '--check-cohort') {
  const checkReuse = process.argv.length === 6 && process.argv[4] === '--reuse-reviewed';
  assert(process.argv.length === 4 || checkReuse, 'Usage: node run.mjs --check-cohort COHORT_JSON [--reuse-reviewed OLD_ROOT]');
  const checked = loadCohort(process.argv[3]);
  const { total_rounds, ...schedule } = cohortSchedule(checked);
  const reused = checkReuse ? await loadReviewedUsers(process.argv[5], checked) : null;
  console.log(JSON.stringify({ passed: true, users: checked.personas.length, rounds: total_rounds,
    pilot_users: checked.pilotUsers, groups: checked.counts, unique_materials: checked.unique_materials, manifest: checked.manifest, ...schedule,
    ...(reused ? { reused_users: [...reused.ids], reused_rounds: reused.results.reduce((sum, row) => sum + row.trajectory.length, 0),
      fresh_users: checked.personas.length - reused.ids.size } : {}) }));
  process.exit(0);
}
const continuing = process.argv[3] === '--continue-pilot';
const fromCohort = process.argv[3] === '--cohort';
const withPool = continuing || fromCohort && process.argv.length === 7 && process.argv[5] === '--evaluate';
const withReuse = fromCohort && process.argv.length === 7 && process.argv[5] === '--reuse-reviewed';
assert(rootArg && (fromCohort ? process.argv.length === 5 || withPool || withReuse : process.argv.length <= 4),
  'Usage: node run.mjs RUN_DIR [REVIEWED_PILOT_DIR | --cohort COHORT_JSON [--evaluate CONTENTS_JSONL_GZ | --reuse-reviewed OLD_ROOT] | --continue-pilot]');
const root = resolve(rootArg);
const originalPlan = continuing && read(join(root, 'plan.json'));
const cohort = continuing ? loadCohort(originalPlan.cohort.path) : fromCohort ? loadCohort(process.argv[4]) : null;
const contentPool = withPool ? resolve(continuing ? originalPlan.evaluation_pool.path : process.argv[6]) : undefined;
const compare = !cohort || withPool;
const evaluationPool = contentPool && { path: contentPool, sha256: sha(readFileSync(contentPool)) };
const reuseRoot = !cohort && process.argv[3] && resolve(process.argv[3]);
const participants = cohort?.personas || scenarios;
const pilot = cohort?.pilotUsers || pilotUsers;
const schedule = cohort && cohortSchedule(cohort);
const pilotRounds = schedule?.pilot_rounds ?? pilot.length * ROUNDS;
const fullRounds = schedule?.total_rounds ?? participants.length * ROUNDS;
const code = dirname(fileURLToPath(import.meta.url));
const dataset = join(root, 'dataset');
if (cohort) assert(!existsSync(dataset) && !existsSync(join(root, 'dataset-pending-review')), 'generation requires a fresh dataset directory');
const reused = withReuse ? await loadReviewedUsers(process.argv[6], cohort) : null;
if (reused) {
  let existing = root;
  while (!existsSync(existing)) existing = dirname(existing);
  const destination = resolve(realpathSync(existing), relative(existing, root));
  assert(destination !== reused.lineage.root && !destination.startsWith(reused.lineage.root + sep) &&
    ['users', 'plan.json', 'progress.json', 'run.lock'].every(file => !existsSync(join(root, file))),
  'reuse requires a fresh directory outside the source run');
}
let priorProgress;
if (continuing) {
  priorProgress = read(join(root, 'progress.json'));
  const final = read(join(root, 'api', 'stats.json'));
  assert(['stopped', 'blocked'].includes(priorProgress.status) && priorProgress.phase === '五方法小样验收' && priorProgress.generation.done === pilotRounds,
    'continuation requires a settled comparison pilot at its review gate');
  assert.deepEqual(originalPlan.cohort, cohort.manifest);
  assert.deepEqual(originalPlan.evaluation_pool, evaluationPool);
  assert.equal(read(join(root, 'run.lock')).pid, priorProgress.pid);
  assert.throws(() => process.kill(priorProgress.pid, 0), { code: 'ESRCH' });
  assert(final.closed_at && final.in_flight === 0 && final.http_in_flight === 0 && final.waiting === 0 && !final.pending.length,
    'prior API requests require reconciliation');
  assert(!existsSync(join(root, 'comparison', 'comparison.lock')) && participants.every(p => pilot.includes(p.id) || !existsSync(userPath(root, p))));
  const generationFile = join(root, 'quality', 'generation-pilot.json');
  const review = read(join(root, 'quality', 'generation-pilot-review.json'));
  assert(read(generationFile).pass && review.accept && review.sha256 === sha(readFileSync(generationFile)) && review.notes, 'prior generation approval mismatch');
  const comparison = read(join(root, 'quality', 'comparison-pilot.json'));
  assert(comparison.integrity.passed && comparison.coverage.done === priorProgress.evaluation.total &&
    !existsSync(join(root, 'quality', 'comparison-pilot-review.json')), 'prior comparison was not awaiting reconciliation');
}
mkdirSync(root, { recursive: true, mode: 0o700 });
const state = {
  status: 'preparing', phase: '预检', pid: process.pid,
  generation: { done: 0, valid: 0, total: pilotRounds, status: 'waiting' },
  evaluation: continuing ? { ...priorProgress.evaluation, status: 'passed' }
    : { done: 0, total: cohort ? 0 : 30, labels_done: 0, contexts_done: 0, contexts_total: cohort ? 0 : 6, status: 'waiting' },
};
const update = () => save(join(root, 'progress.json'), { ...state, updated_at: now() });
writeFileSync(join(root, continuing ? 'run-continuation.lock' : 'run.lock'), JSON.stringify({ pid: process.pid, started_at: now() }) + '\n', { flag: 'wx', mode: 0o600 });
const heartbeat = setInterval(update, 5000);
const abort = new AbortController();
const deadline = setTimeout(() => halt('run_deadline'), 4 * 60 * 60 * 1000);
let api, probes;
function halt(reason) {
  abort.abort(Error(reason));
  api?.drain();
}
const sigint = () => halt('stopped_by_signal');
process.once('SIGINT', sigint);
process.once('SIGTERM', sigint);

async function reviewGate(name, report) {
  const file = join(root, 'quality', name + '.json');
  save(file, report);
  assert(report.pass, name + ' automated acceptance failed');
  state.message = '等待核对' + name;
  update();
  const review = join(root, 'quality', name + '-review.json');
  const until = Date.now() + 35 * 60 * 1000;
  while (!existsSync(review)) {
    if (Date.now() >= until) throw Error(name + ' review timed out');
    await delay(1000, undefined, { signal: abort.signal });
  }
  const decision = read(review);
  assert(decision.accept && decision.sha256 === sha(readFileSync(file)) && decision.notes, name + ' reviewer rejected or evidence changed');
  delete state.message;
}

async function proReview(results, label) {
  if (!api.stats().slots.some(slot => slot.enabled.pro)) await probes;
  if (!api.stats().slots.some(slot => slot.enabled.pro)) return { status: 'no_pro_route' };
  const audits = await Promise.all(results.map(async result => {
    const { persona, trajectory } = result;
    const rounds = trajectory.map(row => ({
      round: row.round, command: row.command, status: row.behavior_status,
      shown: row.presented_cards.map(card => ({ title: card.title, modality: card.modality, duration: card.duration })),
      views: row.behavior?.views,
    }));
    const messages = [
      { role: 'system', content: '审查合成浏览的合理性。判断开局后是否出现与阶段一致的可见行为，参考卡能否支持目标，限制是否遵守。若有用户指令，核查是否像该用户在当时会说的话，以及更改和放宽是否自然连贯。卡片标题和动作是观察依据，不能假定已看完整视频。非目标卡偶尔略看属正常。输出JSON {verdict:"pass"或"needs_review", evidence:[轮次和具体依据], issues:[简短问题]}。' },
      { role: 'user', content: JSON.stringify({ subset: persona.subset, background: persona.hidden_profile, phases: persona.phases.map(({ start, goal, hard }) => ({ start, goal, hard })), rounds }) },
    ];
    try {
      const response = await api.generate(messages, { model: 'pro', stage: 'trajectory_audit', user: persona.id, max_tokens: 4096, temperature: .1, signal: abort.signal });
      const decision = JSON.parse(response.choices[0].message.content);
      assert(['pass', 'needs_review'].includes(decision.verdict) && Array.isArray(decision.evidence) && Array.isArray(decision.issues), 'invalid_trajectory_audit');
      return { user: persona.id, model: response.model, ...decision };
    } catch (error) {
      return { user: persona.id, verdict: 'unavailable', error: errorText(error) };
    }
  }));
  save(join(root, 'quality', label + '-pro.json'), audits);
  return { status: 'recorded', audits: audits.map(({ user, verdict }) => ({ user, verdict })) };
}

function reuseCameraPair(decks) {
  if (!reuseRoot) return [];
  const phase = read(join(reuseRoot, 'progress.json'));
  const final = read(join(reuseRoot, 'api', 'final.json'));
  assert.equal(phase.status, 'blocked');
  assert.equal(final.in_flight, 0);
  assert.equal(final.http_in_flight, 0);
  const prior = read(join(reuseRoot, 'plan.json'));
  const gateFile = join(reuseRoot, 'quality', 'generation-pilot.json');
  const review = read(join(reuseRoot, 'quality', 'generation-pilot-review.json'));
  assert.deepEqual(review.reuse_users, ['u03', 'u04']);
  assert.equal(review.sha256, sha(readFileSync(gateFile)));
  const accepted = read(gateFile);
  assert(accepted.format.valid && accepted.pairs.find(row => row.pair === 'camera')?.pass, 'prior camera pair not approved for reuse');
  return scenarios.filter(persona => review.reuse_users.includes(persona.id)).map(persona => {
    const deck = decks.get(persona.id), path = userPath(reuseRoot, persona);
    assert.equal(sha(JSON.stringify(deck)), prior.per_user_decks[persona.id], 'prior reference deck changed');
    assert.deepEqual(read(join(path, 'persona.json')), persona, 'prior persona changed');
    const trajectory = readLines(join(path, 'trajectory.jsonl'));
    for (const [index, row] of trajectory.entries()) assert.deepEqual(row.presented_cards, deck[index].map(entry => entry.card));
    const inputs = checkpointsFor(persona).map(round => {
      const context = read(join(path, 'checkpoints', 'r' + String(round).padStart(2, '0') + '.json'));
      const phase = phaseAt(persona, round);
      return { user: persona.id, round, persona: { id: persona.id, subset: persona.subset }, phase: { goal: phase.goal, hard: phase.hard }, context };
    });
    cpSync(path, userPath(root, persona), { recursive: true, force: false, errorOnExist: true });
    return { persona, trajectory, inputs, deck };
  });
}

function readApprovedPilot(decks) {
  return participants.filter(persona => pilot.includes(persona.id)).map(persona => {
    const path = userPath(root, persona), deck = decks.get(persona.id), checkpoints = cohort.checkpoints.get(persona.id);
    assert.deepEqual(read(join(path, 'persona.json')), persona);
    assert.equal(sha(JSON.stringify(deck)), originalPlan.per_user_decks[persona.id]);
    const trajectory = readLines(join(path, 'trajectory.jsonl'));
    for (const [index, row] of trajectory.entries()) assert.deepEqual(row.presented_cards, deck[index].map(entry => entry.card));
    const inputs = checkpoints.map(round => {
      const context = read(join(path, 'checkpoints', 'r' + String(round).padStart(2, '0') + '.json'));
      const { goal, hard } = phaseAt(persona, round);
      return { user: persona.id, round, persona: { id: persona.id, subset: persona.subset, hidden_profile: persona.hidden_profile }, phase: { goal, hard }, context };
    });
    return { persona, trajectory, inputs, deck, checkpoints };
  });
}

try {
  update();
  const decks = cohort?.decks || makeDecks(scenarios);
  const hashFiles = ['collection.mjs', 'pack.mjs', 'run.mjs', 'api.mjs', ...(cohort ? ['cohort.mjs'] : []),
    ...(reused ? ['reuse-reviewed.mjs', 'delivery.mjs'] : [])];
  const lengths = new Set(schedule ? Object.values(schedule.rounds_by_user) : [ROUNDS]);
  if (continuing) {
    for (const [name, digest] of Object.entries(originalPlan.generation_code)) if (!['api.mjs', 'run.mjs'].includes(name)) {
      assert.equal(sha(readFileSync(join(code, name))), digest, 'generation source changed: ' + name);
    }
    save(join(root, 'archive', 'pre-continuation-progress.json'), priorProgress);
    cpSync(join(root, 'api', 'preflight.json'), join(root, 'archive', 'pre-continuation-api-preflight.json'));
    save(join(root, 'continuation-plan.json'), { started_at: now(), prior_pid: priorProgress.pid,
      original_plan_sha256: sha(readFileSync(join(root, 'plan.json'))),
      code_sha256: Object.fromEntries(['api.mjs', 'run.mjs', '../shared/request-gate.mjs'].map(name => [name, sha(readFileSync(join(code, name)))])),
      policy: 'Reuse immutable reviewed pilot and comparison prefix. Only API transport cooldown routing changed.' });
  } else save(join(root, 'plan.json'), {
    protocol: 'synthetic-collection/1', created_at: now(), origin: 'synthetic', users: participants.length,
    ...(lengths.size === 1 ? { rounds_per_user: lengths.values().next().value } : {}),
    pilot_users: pilot,
    stage_user_counts: cohort?.counts || { general: 2, behavior_ambiguity: 4, interactive_revision: 4 },
    ...(cohort ? { generation_only: !compare, cohort: cohort.manifest, ...schedule, ...(evaluationPool ? { evaluation_pool: evaluationPool } : {}) }
      : { total_rounds: fullRounds, pilot_rounds: pilotRounds, pilot_checkpoints_per_user: 2 }),
    reuse_reviewed_camera_pair_from: reuseRoot || null,
    ...(reused ? { reused_reviewed: reused.lineage } : {}),
    generation_code: Object.fromEntries(hashFiles.map(name => [name, sha(readFileSync(join(code, name)))])),
    reference_archive: { path: cohort?.manifest.archive || referenceArchive, sha256: cohort?.manifest.archive_sha256 || sha(readFileSync(referenceArchive)),
      provenance: 'archived real reference material, fixed for the simulator only' },
    per_user_decks: Object.fromEntries([...decks].map(([user, deck]) => [user, sha(JSON.stringify(deck))])),
    quality: 'at least 90% valid rounds per user; key cutoffs and exact commands; paired matching opening and discriminating stage behavior; standard export validation',
  });
  api = await installMeteredFetch({ configPath: modelConfigPath, outputDir: root });
  let ready;
  const flashReady = new Promise(resolve => { ready = resolve; });
  probes = api.preflight({ onResult(row) { if (row.family === 'flash' && row.ok) ready(true); } });
  assert(await Promise.race([flashReady, probes.then(rows => rows.some(row => row.family === 'flash' && row.ok))]), 'no verified Flash route');
  abort.signal.throwIfAborted();
  const sources = { providers: api.raw.providers || {}, composio: api.raw.composio || {}, allowed: api.raw.runtime?.waterfall?.sources || {}, rssFeeds: api.raw.runtime?.waterfall?.rssFeeds || [] };
  const catalog = sourceCatalog(sources).filter(row => row.configured && row.allowed !== false);
  assert(catalog.length, 'no configured online sources');

  async function generate(personas) {
    const pending = await Promise.allSettled(personas.map(persona => collectUser({
      root, persona, deck: decks.get(persona.id), checkpoints: cohort?.checkpoints.get(persona.id), catalog, api, signal: abort.signal,
      onRound(row) {
        state.generation.done++;
        if (row.behavior_status !== 'failed') state.generation.valid++;
        update();
      },
    })));
    const errors = pending.filter(item => item.status === 'rejected').map(item => errorText(item.reason));
    if (errors.length) throw Error('generation interrupted: ' + errors.join(', '));
    return pending.map(({ value }) => {
      if (withPool) for (const input of value.inputs) input.persona.hidden_profile = value.persona.hidden_profile;
      return value;
    });
  }

  state.status = 'running';
  state.phase = '生成小样';
  const preserved = continuing ? readApprovedPilot(decks) : reuseCameraPair(decks);
  state.generation.done = preserved.reduce((sum, row) => sum + row.trajectory.length, 0);
  state.generation.valid = preserved.reduce((sum, row) => sum + row.trajectory.filter(round => round.behavior_status !== 'failed').length, 0);
  Object.assign(state.generation, { status: 'running', started_at: now(), baseline_done: state.generation.done });
  update();
  const pilotResults = [...preserved, ...await generate(participants.filter(p => pilot.includes(p.id) && !preserved.some(row => row.persona.id === p.id)))];
  const pilotQuality = reviewBatch(pilotResults);
  state.generation.status = 'checking';
  state.phase = '生成小样验收';
  update();
  if (continuing) assert(pilotQuality.pass, 'archived pilot no longer passes');
  else {
    pilotQuality.format = packDataset({ root, target: join(root, 'archive', 'format-check', 'pilot'), results: pilotResults, quality: pilotQuality, includeCutoffs: !!cohort });
    pilotQuality.pro = await proReview(pilotResults, 'generation-pilot');
    if (reused && (pilotQuality.pro.status !== 'recorded' || pilotQuality.pro.audits.some(audit => audit.verdict === 'unavailable'))) pilotQuality.pass = false;
    await reviewGate('generation-pilot', pilotQuality);
  }

  const comparisonRoot = join(root, 'comparison');
  async function evaluate(rows) {
    if (evaluationPool) assert.equal(sha(readFileSync(contentPool)), evaluationPool.sha256, 'evaluation pool changed');
    const { runComparison } = await import('./comparison.mjs');
    return runComparison({ root: comparisonRoot, inputs: rows, api, contentPool, signal: abort.signal, onProgress: stats => {
      Object.assign(state.evaluation, stats);
      update();
    } });
  }
  const smoke = pilotResults.flatMap(({ persona, inputs }) => {
    if (!withPool) return inputs.slice(0, 2);
    const index = inputs.findIndex(({ round }) => round >= (persona.pair ? persona.phases[1].start : persona.phases[2].start));
    assert(index >= 0, 'pilot misses transition evidence');
    return inputs.slice(0, index + 1);
  });
  async function evaluatePilot() {
    state.phase = '五方法小样';
    Object.assign(state.evaluation, { status: 'running', started_at: now(), total: smoke.length * 5, contexts_total: smoke.length });
    update();
    const trial = await evaluate(smoke);
    const coversMethods = Object.values(trial.by_subset.all.methods).every(method => method.complete_lists > 0);
    state.evaluation.status = 'checking';
    state.phase = '五方法小样验收';
    update();
    await reviewGate('comparison-pilot', {
      pass: trial.integrity.passed && trial.coverage.done === smoke.length * 5 &&
        trial.coverage.labels_total > 0 && trial.coverage.label_failures / trial.coverage.labels_total <= .05 &&
        (!withPool || coversMethods && trial.by_subset.all.blind.available_choices >= 5),
      all_methods_delivered_top5: coversMethods,
      coverage: trial.coverage, integrity: trial.integrity, methods: trial.by_subset.all.methods,
      blind: trial.by_subset.all.blind,
    });
    state.evaluation.status = 'passed';
    update();
  }
  if (withPool) await evaluatePilot();

  state.phase = '生成扩批';
  for (const { persona, trajectory } of reused?.results || []) {
    const raw = reused.lineage.users[persona.id], target = userPath(root, persona);
    cpSync(raw.path, target, { recursive: true, force: false, errorOnExist: true });
    for (const [file, digest] of Object.entries(raw.files)) assert.equal(sha(readFileSync(join(target, file))), digest, 'reused raw bytes changed: ' + file);
    state.generation.done += trajectory.length;
    state.generation.valid += trajectory.filter(round => round.behavior_status !== 'failed').length;
  }
  Object.assign(state.generation, { status: 'running', total: fullRounds, started_at: now(), baseline_done: state.generation.done });
  update();
  const extra = await generate(participants.filter(p => !pilot.includes(p.id) && !reused?.ids.has(p.id)));
  const results = [...pilotResults, ...(reused?.results || []), ...extra].sort((a, b) => a.persona.id.localeCompare(b.persona.id));
  const quality = reviewBatch(results);
  state.phase = '扩批验收';
  state.generation.status = 'checking';
  update();
  const pending = join(root, 'dataset-pending-review');
  const target = compare || reused ? join(root, 'archive', 'format-check', 'batch') : pending;
  quality.format = packDataset({ root, target, results, quality, includeCutoffs: !!cohort });
  const auditPair = extra.find(row => row.persona.pair)?.persona.pair;
  const auditSample = cohort ? [...extra.filter(row => auditPair && row.persona.pair === auditPair),
    ...extra.filter(row => row.persona.subset === 'interactive_revision').slice(0, 1)] : extra.filter(x => ['u05', 'u06', 'u09'].includes(x.persona.id));
  quality.pro = await proReview(auditSample, 'generation-batch');
  await reviewGate('generation-batch', quality);
  state.generation.status = 'passed';

  if (!compare) {
    if (reused) {
      const { augmentComparison } = await import('./delivery.mjs');
      const exported = packDataset({ root, target: pending, results, quality, includeCutoffs: true,
        augment: (episode, result) => { if (reused.ids.has(result.persona.id)) augmentComparison(episode, result, reused.comparison); } });
      for (const table of ['studies', 'questions', 'ratings', 'blind_choices', 'model_calls', 'tool_calls']) {
        assert.equal(exported.table_counts[table], reused.tableCounts[table], 'reused comparison table count changed: ' + table);
      }
    }
    renameSync(pending, dataset);
    state.status = 'completed';
    state.phase = '轨迹生成完成';
    update();
  } else {
    const inputs = results.flatMap(result => result.inputs);
    if (!withPool) await evaluatePilot();

    state.phase = '五方法完整对照';
    Object.assign(state.evaluation, { status: 'running', total: inputs.length * 5, contexts_total: inputs.length,
      started_at: now(), baseline_done: smoke.length * 5 });
    update();
    const full = await evaluate(inputs);
    const { augmentComparison, writeReport } = await import('./delivery.mjs');
    state.phase = '结果验收';
    state.evaluation.status = 'checking';
    update();
    const verification = packDataset({ root, target: join(root, 'dataset'), results, quality,
      augment: (episode, result) => augmentComparison(episode, result, comparisonRoot) });
    await writeReport({ root, results, quality, full, verification, api });
    const complete = full.integrity.passed && full.coverage.done === inputs.length * 5 && full.coverage.contexts_done === inputs.length;
    state.evaluation.status = complete ? 'completed' : 'blocked';
    state.status = complete ? 'completed' : 'blocked';
    state.phase = complete ? '完成' : '对照不完整';
    update();
  }
} catch (error) {
  state.status = abort.signal.aborted ? 'stopped' : /failed|rejected|timed out/i.test(errorText(error)) && state.phase.includes('验收') ? 'blocked' : 'failed';
  state.message = errorText(error);
  console.error(state.message);
  update();
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  clearTimeout(deadline);
  if (api) {
    api.drain();
    await probes?.catch(() => {});
    api.restore();
    save(join(root, 'api', 'final.json'), api.stats());
  }
  process.removeListener('SIGINT', sigint);
  process.removeListener('SIGTERM', sigint);
}
