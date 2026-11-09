import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, closeSync, cpSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { SOURCE_SHA256 } from '../../../demos/agentic-feed-site/lib/waterfall/waterfall-version.mjs';
import { RESEARCH_METHODS } from '../../../output/agentic-waterfall/comparison-20261106-synthetic-10x20-all-methods-v4/source/site/lib/waterfall/research-methods.mjs';
import { researchPublicInput } from '../../../output/agentic-waterfall/comparison-20261106-synthetic-10x20-all-methods-v4/source/site/lib/waterfall/research-input.mjs';
import { acquireSource, sourceCatalog } from '../../../output/agentic-waterfall/comparison-20261106-synthetic-10x20-all-methods-v4/source/site/lib/waterfall/sources.mjs';
import { cleanBgePayload, repairBgeRecord } from './bge-recovery.mjs';
import { candidatesForCheckpoint, readContentPool } from './comparison-pool.mjs';
import { patchedHybridWorker, patchedPoolRunner, patchedResearchPython, replaceOnce } from './comparison-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outputRoot = resolve(here, '../../../output/agentic-waterfall');
const baseline = join(outputRoot, 'comparison-20261106-synthetic-10x20-all-methods-v4');
const authors = join(baseline, 'author-methods');
const python = resolve(here, '../../../methods/agentic-waterfall/fixed-retrieval/.venv/bin/python');
const benchmark = resolve(here, '../agentrecbench');
const recPython = join(benchmark, '.venv/bin/python');
const authorRecAgent = 'upstream/AgentSocietyChallenge-3f575247a5778d34c3ae6b0297139c7d4a3597fd';
const recAuthorFiles = [
  'example/RecAgent_baseline.py', 'websocietysimulator/tools/evaluation_tool.py',
  'websocietysimulator/tools/interaction_tool.py', 'websocietysimulator/tasks/recommendation_task.py',
  'websocietysimulator/llm/llm.py', 'websocietysimulator/agent/agent.py',
  'websocietysimulator/agent/recommendation_agent.py', 'websocietysimulator/agent/modules/planning_modules.py',
  'websocietysimulator/agent/modules/reasoning_modules.py',
];
export const comparisonMethods = Object.freeze(RESEARCH_METHODS.map(id => id === 'generic-agent' ? 'recagent' : id));
const poolMethods = ['recagent', 'i2agent', 'fixed-retrieval'];
const fixedWorker = 'fixed-retrieval/persistent_worker.py';
const cachedWorker = 'scripts/bge_pool_worker.py';
const bgeCacheValidation = Object.freeze({
  pool_sha256: '69090ea55beca10683bbab2d34f9a79851b73bfbee5f44df5054525ec70776bf',
  worker_sha256: '3c641c84d456af628e824dbb1a5e977e727ddf5c67c544a56ed165f0d51d0bf4',
  device: 'mps', eligible: 999, acquired_order_equal: true, full_ranking_equal: true,
  max_rerank_score_delta: 0, cold_ms: 81566, first_cached_ms: 85601, warm_ms: 10674,
});
const topK = 5;
const relevantInterest = 2;
const limits = { mode: 'acquire', top_k: topK, max_model_calls: 20, max_tool_calls: 20, max_acquired_items: 1000, max_items_per_request: 50, max_output_tokens: 32768 };
const durationAdapter = 'online-method-v4-waterfall-bilibili-duration-v1';
const historyOrder = 'oldest_to_newest_by_availability';
export const blindProtocol = 'synthetic-blind/same-rank-5-v1';
const blindOptions = ['A', 'B', 'C', 'D', 'E'];
const abstentions = ['tie', 'neither', 'insufficient'];
const privateKey = /^(?:hidden(?:_profile|_goal|_intent|_target)|private_(?:plan|goal|profile|background)|future_(?:plan|goal|phases)|evaluation_(?:goal|labels)|hard_constraints)$/i;
const sha = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const errorText = error => String(error?.message ?? error).replace(/sk-[\w-]+|Bearer\s+[^\s"']+/gi, '[REDACTED]');

function write(path, value, durable = false) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n');
    if (durable) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  if (durable) {
    const folder = openSync(dirname(path), 'r');
    try { fsyncSync(folder); } finally { closeSync(folder); }
  }
}

function fileHashes(root, relative = '') {
  return Object.fromEntries(readdirSync(join(root, relative)).sort().flatMap(name => {
    const path = join(relative, name);
    const absolute = join(root, path);
    const info = lstatSync(absolute);
    if (info.isDirectory()) return Object.entries(fileHashes(root, path));
    if (!info.isFile() || name.endsWith('.pyc')) return [];
    return [[path, sha(readFileSync(absolute))]];
  }));
}

function bilibiliDurationSeconds(item) {
  // Bilibili search reports M:S with unpadded seconds and can exceed 59 minutes.
  if (item.source !== 'bilibili' || item.modality !== 'video' || typeof item.duration !== 'string') return null;
  const clock = /^(\d+):([0-5]?\d)$/.exec(item.duration);
  if (!clock) return null;
  const seconds = Number(clock[1]) * 60 + Number(clock[2]);
  return Number.isSafeInteger(seconds * 1000) && seconds > 0 ? seconds : null;
}

export function evaluateHardConstraints(item, hard = {}) {
  const durationSeconds = bilibiliDurationSeconds(item);
  const requirements = {};
  if (hard.modality !== undefined) {
    requirements.modality = ['video', 'text'].includes(item.modality)
      ? (item.modality === hard.modality ? 'pass' : 'fail') : 'unknown';
  }
  if (hard.max_duration_seconds !== undefined) {
    requirements.max_duration_seconds = durationSeconds === null
      ? 'unknown' : (durationSeconds <= hard.max_duration_seconds ? 'pass' : 'fail');
  }
  const results = Object.values(requirements);
  const status = !results.length ? 'not_applicable'
    : results.includes('fail') ? 'fail' : results.includes('unknown') ? 'unknown' : 'pass';
  return {
    status, requirements, source: item.source ?? null, modality: item.modality ?? null,
    raw_duration: item.duration ?? null, duration_seconds: durationSeconds,
    duration_format: durationSeconds === null ? null : 'bilibili_search_M:S',
  };
}

export function patchedWaterfallSource(original, canonicalPrior = true) {
  const projection = '({id:item.id,title:item.title,abstract:item.summary,source_id:item.source,content_type:item.modality,url:item.url,content_hash:item.content_hash,published_at:item.published_at})';
  const boundary = '\n input.protocol={mode:';
  assert.equal(original.split(projection).length, 3, 'unexpected frozen Waterfall projections');
  assert.equal(original.split(boundary).length, 2, 'unexpected frozen Waterfall history boundary');
  if (canonicalPrior) {
    original = replaceOnce(original, 'lookupHistory,onAction,topK=1000', 'lookupHistory,onAction,canonicalState,topK=1000');
    original = replaceOnce(original, 'const input=demoInput(snapshot,{userId,sessionId});',
      'const input=demoInput(snapshot,{userId,sessionId});\n if(canonicalState)input.observation.user_state=structuredClone(canonicalState);');
  }
  return original.replaceAll(projection, 'acquiredCoreItem(item)')
    .replace(boundary, "\n for(const field of ['dialogue','behavior_events'])input.observation[field].sort(compareHistoryTime);" + boundary)
    + '\n' + bilibiliDurationSeconds.toString()
    + '\n' + compareHistoryTime.toString()
    + '\nfunction acquiredCoreItem(item) {\n'
    + '  const seconds = bilibiliDurationSeconds(item);\n'
    + '  return { ...' + projection + ', ...(seconds === null ? {} : { duration_ms: seconds * 1000 }) };\n}\n';
}

function compareHistoryTime(left, right) {
  const time = row => {
    for (const field of ['available_at', 'event_time', 'occurred_at']) {
      const value = Date.parse(row[field]);
      if (Number.isFinite(value)) return value;
    }
    return -Infinity;
  };
  const a = time(left), b = time(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function assertPublic(value, hiddenProfile) {
  if (typeof value === 'string' && hiddenProfile && value.includes(hiddenProfile)) throw Error('hidden profile in comparison input');
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert(!privateKey.test(key), 'private evaluation field in comparison input');
      assertPublic(child, hiddenProfile);
    }
  }
}

export function prepareInputs(inputs) {
  assert(Array.isArray(inputs) && inputs.length, 'comparison requires checkpoints');
  const tracks = new Map(), identities = new Map(), sessions = new Map();
  for (const { user, round, persona, phase, context } of inputs) {
    const { snapshot, history, public_input } = context;
    assert(/^u\d+$/.test(user) && persona.id === user && /^[a-z][a-z_]*$/.test(persona.subset), 'invalid comparison persona');
    assert(Number.isInteger(round) && round > 0 && context.round === round, 'invalid comparison round');
    assert(typeof phase.goal === 'string' && phase.goal.trim(), 'missing current evaluation goal');
    const hard = { ...phase.hard };
    assert(phase.hard == null || typeof phase.hard === 'object' && !Array.isArray(phase.hard), 'invalid hard requirements');
    assert(Object.keys(hard).every(key => ['modality', 'max_duration_seconds'].includes(key)), 'unsupported hard requirement');
    assert(hard.modality === undefined || ['video', 'text'].includes(hard.modality), 'invalid hard modality');
    assert(hard.max_duration_seconds === undefined || Number.isFinite(hard.max_duration_seconds) && hard.max_duration_seconds > 0, 'invalid hard duration');
    const { hash, ...snapshotBody } = snapshot;
    assert.equal(sha(snapshotBody), hash, 'snapshot hash mismatch');
    assert(typeof snapshot.id === 'string' && Array.isArray(snapshot.available_sources) && snapshot.available_sources.length, 'invalid source snapshot');
    const cutoff = Date.parse(snapshot.captured_at);
    assert(Number.isFinite(cutoff) && Array.isArray(history), 'invalid public history cutoff');
    const participantIds = new Set(history.map(row => row.participant_id).filter(Boolean));
    const sessionIds = new Set(history.map(row => row.session_id).filter(Boolean));
    assert(participantIds.size === 1 && sessionIds.size === 1, 'ambiguous comparison history identity');
    const [userId] = participantIds, [sessionId] = sessionIds;
    assert(typeof userId === 'string' && typeof sessionId === 'string', 'invalid comparison history identity');
    assert(!identities.has(userId) || identities.get(userId) === user, 'cross-user participant collision');
    assert(!sessions.has(sessionId) || sessions.get(sessionId) === user, 'cross-user session collision');
    identities.set(userId, user);
    sessions.set(sessionId, user);
    for (const row of [...history, ...(snapshot.behavior || []), ...(snapshot.recent_commands || [])]) {
      assert(row.track === undefined || row.track === 'feed', 'non-feed evidence in comparison input');
      assert(row.user_id == null || row.user_id === userId, 'cross-user evidence');
      assert(row.participant_id == null || row.participant_id === userId, 'cross-participant evidence');
      assert(row.session_id == null || row.session_id === sessionId, 'cross-session evidence');
      assert(row.pilot_round == null || Number.isInteger(row.pilot_round) && row.pilot_round <= round, 'future or invalid evidence round');
      assert([row.event_time, row.available_at].filter(Boolean).every(time => Number.isFinite(Date.parse(time)) && Date.parse(time) <= cutoff), 'future or invalid evidence time');
    }
    const publicHash = sha(public_input);
    assert.equal(sha(researchPublicInput(snapshot, history, userId)), publicHash, 'frozen public projection mismatch');
    if (context.generated_public_sha256 !== undefined) assert.equal(context.generated_public_sha256, publicHash, 'declared public input hash mismatch');
    const private_background = persona.hidden_profile ?? '';
    assert(typeof private_background === 'string' && private_background.length <= 8000, 'invalid private evaluation background');
    assertPublic({ snapshot, history, public_input }, private_background);
    const checkpoint = {
      user, round, subset: persona.subset, userId, sessionId, snapshot, history, public_input,
      input_sha256: sha({ snapshot, history, public_input, round }), public_input_sha256: publicHash,
      phase: { goal: phase.goal, hard }, private_background,
      phase_sha256: sha({ goal: phase.goal, hard, ...(private_background ? { private_background } : {}) }),
    };
    if (!tracks.has(user)) tracks.set(user, []);
    tracks.get(user).push(checkpoint);
  }
  for (const track of tracks.values()) {
    track.sort((a, b) => a.round - b.round);
    assert(track.every((item, i) => item.userId === track[0].userId && item.sessionId === track[0].sessionId && item.subset === track[0].subset
      && (!i || (item.round > track[i - 1].round && Date.parse(item.snapshot.captured_at) >= Date.parse(track[i - 1].snapshot.captured_at)))), 'invalid chronological checkpoint prefix');
  }
  return tracks;
}

export function checkPrefix(previous, current) {
  for (const [user, rows] of Object.entries(previous)) {
    assert.deepEqual(current[user]?.slice(0, rows.length), rows, 'existing comparison checkpoint prefix changed');
  }
}

async function freezeRuntime(root, catalog, model, transport, replayPilot, pool, methodIds) {
  const sourcePath = 'lib/waterfall/unified-demo.mjs';
  const corePath = 'lib/waterfall/waterfall-core.mjs';
  const versionPath = 'lib/waterfall/waterfall-version.mjs';
  const frozenSite = join(baseline, 'source/site'), site = join(root, 'runtime/source/site');
  const canonicalSite = resolve(here, '../../../demos/agentic-feed-site');
  const revisedSources = {
    [sourcePath]: Buffer.from(patchedWaterfallSource(readFileSync(join(frozenSite, sourcePath), 'utf8'), Boolean(pool))),
    [corePath]: readFileSync(join(canonicalSite, corePath)),
    [versionPath]: readFileSync(join(canonicalSite, versionPath)),
  };
  const documentCache = pool?.lineage.cards_sha256 === bgeCacheValidation.pool_sha256 ? bgeCacheValidation : null;
  if (documentCache) {
    revisedSources[cachedWorker] = Buffer.from(patchedHybridWorker(readFileSync(join(authors, fixedWorker), 'utf8')));
    assert.equal(sha(revisedSources[cachedWorker]), documentCache.worker_sha256, 'BGE cache worker differs from offline validation');
  }
  if (pool) {
    const runner = 'scripts/research-live-methods.mjs', bridge = 'scripts/research-python.py', roster = 'lib/waterfall/research-methods.mjs';
    revisedSources[runner] = Buffer.from(patchedPoolRunner(readFileSync(join(frozenSite, runner), 'utf8')));
    revisedSources[bridge] = Buffer.from(patchedResearchPython(readFileSync(join(frozenSite, bridge), 'utf8')));
    revisedSources[roster] = Buffer.from(replaceOnce(readFileSync(join(frozenSite, roster), 'utf8'), "'generic-agent'", "'recagent'"));
    revisedSources['scripts/recagent_pool.py'] = readFileSync(join(here, 'recagent-pool.py'));
    const paths = ['scripts/official_components.py', ...recAuthorFiles.map(file => join(authorRecAgent, file))];
    for (const file of paths) revisedSources[join('scripts/agentrecbench', file)] = readFileSync(join(benchmark, file));
    const cache = 'cache/9b5ad71b2ce5302211f9c61530b329a4922fc6a4';
    revisedSources[join('scripts/agentrecbench', cache)] = readFileSync(resolve(here, '../../../methods/agentic-waterfall/recagent', cache));
  }
  assert.equal(sha(revisedSources[corePath]), SOURCE_SHA256, 'canonical Waterfall core hash does not match its version');
  const sourceFiles = fileHashes(frozenSite);
  const originalHash = sourceFiles[sourcePath];
  for (const [name, bytes] of Object.entries(revisedSources)) sourceFiles[name] = sha(bytes);
  const weights = read(join(baseline, 'bge-model-source-manifest.json'));
  const frozen = {
    schema: 'awf-synthetic-comparison/1', module_sha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    inherited_run: baseline, source_files: sourceFiles, author_files: fileHashes(authors),
    revision: { id: 'waterfall-research-adapter-v2', path: sourcePath, original_sha256: originalHash, revised_sha256: sourceFiles[sourcePath],
      duration_adapter: durationAdapter, history_order: historyOrder },
    weights, sources: catalog, transport, methods: methodIds, limits, source_parallelism_per_platform: 4,
    method_model: { name: model, temperature: 0.3, thinking: 'enabled', max_tokens: limits.max_output_tokens },
    judge_model: { name: model, temperature: 0, thinking: 'disabled', max_tokens: 512, parallelism: pool ? 30 : 12 },
    blind_protocol: blindProtocol,
    fixed_unicode_sha256: sha(readFileSync(join(here, 'bge-recovery.mjs'))),
    ...(pool ? { fixed_pool: pool.lineage, routing: { live: ['waterfall', 'clawrec'], fixed_pool: poolMethods },
      pool_reader_sha256: sha(readFileSync(join(here, 'comparison-pool.mjs'))),
      profile_protocol: 'seed once, own committed state plus unseen operations; i2Agent reranks using own derived profiles' } : {}),
    ...(documentCache ? { bge_document_cache: documentCache } : {}),
  };
  const manifestPath = join(root, 'manifest.json');
  let salt, legacyConfig;
  if (existsSync(manifestPath)) {
    const previous = read(manifestPath);
    assert.deepEqual(previous.frozen, frozen, 'comparison configuration or source changed');
    salt = previous.blinding_seed;
  } else {
    if (!existsSync(site)) {
      cpSync(frozenSite, site, { recursive: true });
      for (const [name, bytes] of Object.entries(revisedSources)) write(join(site, name), bytes);
    }
    if (replayPilot) {
      const old = read(join(replayPilot, 'manifest.json'));
      const { module_sha256: oldModule, ...oldShared } = old.frozen;
      const { module_sha256: _module, fixed_unicode_sha256: _fix, ...shared } = frozen;
      assert.deepEqual(oldShared, shared, 'pilot differs beyond the BGE Unicode repair');
      assert.equal(oldModule, sha(readFileSync(join(dirname(replayPilot), 'code/comparison-before-bge.mjs'))), 'old comparison module hash changed');
      salt = old.blinding_seed;
      legacyConfig = sha(old.frozen);
    } else salt = randomUUID();
  }
  assert.deepEqual(fileHashes(site), sourceFiles, 'run-local comparison source changed');
  if (!existsSync(manifestPath)) write(manifestPath, { frozen, blinding_seed: salt,
    ...(legacyConfig ? { reused_pilot: { root: replayPilot, config_sha256: legacyConfig, reason: 'bge_unpaired_surrogate' } } : {}) }, true);
  const runtime = await import(pathToFileURL(join(site, 'scripts/research-live-methods.mjs')));
  const store = await import(pathToFileURL(join(site, 'scripts/research-service.mjs')));
  return { ...runtime, ...store, salt, config_sha256: sha(frozen), weights, legacyConfig, documentCache };
}

async function verifyWeights(weights) {
  await Promise.all(['bge-m3', 'bge-reranker-v2-m3'].map(async model => {
    const entry = weights[model];
    const path = join(authors, 'fixed-retrieval/weights', model, entry.weight_file.split('/').at(-1));
    const digest = createHash('sha256');
    assert.equal(realpathSync(path), entry.weight_file, 'local BGE weights path changed');
    for await (const bytes of createReadStream(path)) digest.update(bytes);
    assert.equal(digest.digest('hex'), entry.sha256, 'local BGE weights hash changed');
  }));
}

async function startHybridWorker(root, documentCache) {
  const script = documentCache ? join(root, 'runtime/source/site', cachedWorker) : join(authors, fixedWorker);
  const worker = spawn(python, ['-u', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1', TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: '2',
      ...(documentCache ? { PYTHONPATH: dirname(join(authors, fixedWorker)) } : {}) },
  });
  let pending, stderr = '', fatal, ready;
  const fail = error => {
    fatal = error;
    pending?.reject(error);
    pending = undefined;
    worker.kill();
  };
  const lines = createInterface({ input: worker.stdout });
  worker.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4000); });
  worker.on('error', fail);
  worker.stdin.on('error', fail);
  worker.on('exit', code => { if (pending) fail(Error('hybrid_worker_exit_' + code + ': ' + stderr)); });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      assert(pending && message.request_id === pending.id, 'unexpected hybrid worker response');
      const { accept, reject } = pending;
      pending = undefined;
      if (message.type === 'error') reject(Error(message.error));
      else accept(message);
    } catch (error) { fail(error); }
  });
  async function receive(ms, payload) {
    if (fatal || worker.exitCode !== null || worker.signalCode !== null) throw fatal ?? Error('hybrid worker exited');
    let timer;
    try {
      return await new Promise((accept, reject) => {
        timer = setTimeout(() => fail(Error('hybrid_worker_timeout')), ms);
        const id = payload ? randomUUID() : undefined;
        pending = { id, accept, reject };
        if (payload) worker.stdin.write(JSON.stringify({ ...payload, operation: 'fixed', request_id: id }) + '\n');
      });
    } finally { clearTimeout(timer); }
  }
  try {
    ready = await receive(120000);
    assert.equal(ready.type, 'ready');
    assert.equal(ready.model_loads, 2);
    write(join(root, 'hybrid-ready.json'), { ...ready, pid: worker.pid, at: now(),
      ...(documentCache ? { document_cache_eligible: ready.device === documentCache.device } : {}) });
  } catch (error) {
    fail(error);
    throw error;
  }
  let queue = Promise.resolve();
  return {
    device: ready.device,
    request(payload, signal) {
      const next = queue.then(async () => {
        signal?.throwIfAborted();
        const abort = () => fail(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        try { return (await receive(1800000, payload)).value; }
        finally { signal?.removeEventListener('abort', abort); }
      });
      queue = next.catch(() => {});
      return next;
    },
    close() {
      lines.close();
      worker.stdin.end();
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      return new Promise(resolve => {
        const timer = setTimeout(() => worker.kill('SIGKILL'), 5000);
        worker.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

function limiter(limit) {
  let active = 0;
  const waiting = [];
  return async task => {
    if (active >= limit) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await task(); }
    finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

function publicCard(item) {
  return Object.fromEntries(['id', 'title', 'summary', 'source', 'modality', 'url', 'image_url', 'duration', 'published_at', 'content_hash']
    .filter(key => item[key] !== undefined).map(key => [key, item[key]]));
}

export function makeQuestions(input, methods, salt, methodIds = RESEARCH_METHODS) {
  const questions = { ratings: [], blind: [] };
  const mapping = { cards: [], blind: [] };
  const ratings = new Map(), slates = new Map();
  for (const method of methods) {
    const cards = method.slate.map((item, index) => {
      const material = publicCard(item), materialHash = sha(material);
      if (!ratings.has(materialHash)) {
        ratings.set(materialHash, { id: sha([salt, input.user, input.round, 'rating', materialHash]), material, material_sha256: materialHash });
      }
      const question = ratings.get(materialHash);
      const constraint = evaluateHardConstraints(item, input.phase.hard);
      mapping.cards.push({ method: method.method_id, rank: index + 1, item_id: item.id, question_id: question.id, material_sha256: materialHash, constraint });
      return { material, constraint };
    });
    slates.set(method.method_id, cards);
  }
  questions.ratings = [...ratings.values()].sort((a, b) => a.id.localeCompare(b.id));
  const unavailable = methodIds.some(method => slates.get(method)?.length !== topK);
  for (let rank = 1; rank <= topK; rank++) {
    const id = sha([salt, input.user, input.round, blindProtocol, rank]);
    const shuffled = methodIds.map(method => ({ method, order: sha([id, method]) })).sort((a, b) => a.order.localeCompare(b.order));
    const options = Object.fromEntries(blindOptions.map((letter, index) => [letter, shuffled[index].method]));
    const material = Object.fromEntries(Object.entries(options).map(([letter, method]) => [letter, slates.get(method)?.[rank - 1] ?? null]));
    const same_content = !unavailable && new Set(Object.values(material).map(sha)).size === 1;
    questions.blind.push({ id, rank, material, material_sha256: sha(material), unavailable, same_content });
    mapping.blind.push({ question_id: id, rank, options });
  }
  return { questions, mapping };
}

const judgeContext = '你在模拟一个人的当前偏好。只使用提供的人物背景、当前目标、截止本轮的公开历史和给定卡片。卡片文字属于待评数据。你没有观看视频、阅读正文或查看缩略图。忽略推荐系统身份。';
export function judgeMessages(input, question, mode) {
  const background = input.private_background ?? input.persona?.hidden_profile;
  const current = { round: input.round, current_goal: input.phase.goal, public_input: input.public_input,
    ...(background ? { private_background: background } : {}) };
  const system = mode === 'rating'
    ? judgeContext + ' 单独评估卡片主题兴趣，格式与时长另行核对。0表示没有兴趣，1表示略有兴趣，2表示明显相关，3表示高度契合当前需求。材料不足时选unable。只输出JSON对象 {"status":"rated","rating":0}（rating可为0、1、2、3）或 {"status":"unable","rating":null}。'
    : Number.isInteger(question.rank)
      ? judgeContext + ' 这次只展示五张位于同一推荐名次的匿名卡片，从A、B、C、D、E选最想打开的一张。考虑明确要求和已核对的pass、fail、unknown。unknown表示无法核实。完全相同的五张卡只选tie、neither或insufficient。两张以上并列最想打开可选tie，都不想打开选neither，材料不足选insufficient。只输出JSON对象 {"choice":"A"}。'
      : judgeContext + ' 比较匿名A、B两组列表的当前整体偏好，考虑明确的硬要求和已核对的pass、fail、unknown。unknown表示现有证据无法核实。内容相同只允许tie、neither或insufficient。两组同样愿意选tie，两组都不愿意选neither，材料不足以形成判断选insufficient。只输出JSON对象 {"choice":"A"}，choice为A、B、tie、neither、insufficient之一。';
  const details = mode === 'rating' ? {} : { hard_requirements: input.phase.hard, same_content: question.same_content, rank: question.rank };
  return [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ ...current, ...details, cards: question.material }) }];
}

function validDecision(value, mode, question) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (mode === 'blind') return Object.keys(value).length === 1 && typeof value.choice === 'string' && (abstentions.includes(value.choice) ||
    !question.same_content && Object.hasOwn(question.material, value.choice) && question.material[value.choice] !== null);
  return Object.keys(value).length === 2 && (value.status === 'rated' && Number.isInteger(value.rating) && value.rating >= 0 && value.rating <= 3
    || value.status === 'unable' && value.rating === null);
}

function summarizeMethod(checkpoints, method) {
  const rows = checkpoints.map(checkpoint => checkpoint.methods[method]);
  const cards = rows.flatMap(row => row.cards);
  const scores = cards.flatMap(card => card.interest?.status === 'rated' ? [card.interest.rating] : []);
  const counts = (values, statuses) => Object.fromEntries(statuses.map(status => [status, values.filter(value => value === status).length]));
  const statuses = ['pass', 'fail', 'unknown', 'not_applicable'];
  const dcg = rows.flatMap(row => row.cards.length === topK && row.cards.every(card => card.interest?.status === 'rated')
    ? [row.cards.reduce((sum, card) => sum + card.interest.rating / Math.log2(card.rank + 1), 0)] : []);
  const constrained = cards.filter(card => card.constraint.status !== 'not_applicable');
  const passes = constrained.filter(card => card.constraint.status === 'pass');
  return {
    checkpoints: rows.length, complete_lists: rows.filter(row => row.cards.length === topK).length,
    method_status: counts(rows.map(row => row.status), ['submitted', 'failed', 'not_applicable', 'missing']),
    expected_card_slots: rows.length * topK, delivered_cards: cards.length, rated_cards: scores.length,
    missing_card_slots: rows.length * topK - cards.length,
    unable_cards: cards.filter(card => card.interest?.status === 'unable').length,
    missing_card_labels: cards.filter(card => card.interest === null).length,
    mean_card_interest: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    dcg_at_5_denominator: dcg.length, mean_dcg_at_5: dcg.length ? dcg.reduce((a, b) => a + b, 0) / dcg.length : null,
    hard_compliance: counts(cards.map(card => card.constraint.status), statuses),
    hard_by_requirement: Object.fromEntries(['modality', 'max_duration_seconds'].map(key => [key, counts(cards.map(card => card.constraint.requirements[key] ?? 'not_applicable'), statuses)])),
    hard_relevance: {
      minimum_interest: relevantInterest, constrained_delivered_cards: constrained.length,
      pass_and_relevant: passes.filter(card => card.interest?.status === 'rated' && card.interest.rating >= relevantInterest).length,
      pass_below_threshold: passes.filter(card => card.interest?.status === 'rated' && card.interest.rating < relevantInterest).length,
      pass_unrated: passes.filter(card => card.interest?.status !== 'rated').length,
      unknown_constraint: constrained.filter(card => card.constraint.status === 'unknown').length,
      unable_interest: constrained.filter(card => card.interest?.status === 'unable').length,
      missing_interest: constrained.filter(card => card.interest === null).length,
    },
    model_calls: rows.reduce((sum, row) => sum + (row.resources?.model_calls ?? 0), 0),
    source_requests: rows.reduce((sum, row) => sum + (row.resources?.source_requests ?? 0), 0),
    source_failures: rows.reduce((sum, row) => sum + (row.source_failures ?? 0), 0),
  };
}

function summarizeBlind(checkpoints, methodIds) {
  const rows = checkpoints.flatMap(checkpoint => checkpoint.blind);
  const outcomes = Object.fromEntries(['selected', ...abstentions, 'missing', 'unavailable']
    .map(outcome => [outcome, rows.filter(row => row.outcome === outcome).length]));
  const votes_by_method = Object.fromEntries(methodIds.map(method => [method, 0]));
  for (const row of rows) for (const method of row.selected_methods) votes_by_method[method] += 1 / row.selected_methods.length;
  return {
    expected_choices: rows.length, available_choices: rows.length - outcomes.unavailable,
    answered_choices: rows.length - outcomes.unavailable - outcomes.missing,
    unavailable_choices: outcomes.unavailable, missing_choices: outcomes.missing, outcomes, votes_by_method,
  };
}

export function summarizeComparison(checkpoints, methodIds = RESEARCH_METHODS) {
  const bySubset = Object.fromEntries(['all', ...new Set(checkpoints.map(row => row.subset))].map(subset => {
    const rows = subset === 'all' ? checkpoints : checkpoints.filter(row => row.subset === subset);
    return [subset, {
      users: new Set(rows.map(row => row.user)).size, checkpoints: rows.length,
      methods: Object.fromEntries(methodIds.map(method => [method, summarizeMethod(rows, method)])),
      blind: summarizeBlind(rows, methodIds),
    }];
  }));
  return { by_subset: bySubset, checkpoints };
}

function checkRun(result, input, method, stateBefore, catalog, methodIds, poolContext) {
  assert.deepEqual(result.environment.protocol, limits, 'run protocol changed');
  assert.equal(result.data_origin, 'synthetic');
  assert.equal(sha(result.input_snapshot), sha(input.snapshot));
  assert.equal(sha(result.environment.public_input), input.public_input_sha256, 'method input parity failed');
  assert.deepEqual(result.environment.active_sources, catalog.map(source => source.id), 'method sources changed');
  assert.deepEqual(result.environment.method_ids, methodIds, 'method roster changed');
  assert.equal(result.environment.network_sources, !poolContext, 'method candidate route changed');
  assert.equal(result.methods.length, 1);
  const row = result.methods[0];
  assert.equal(row.method_id, method);
  assert.equal(row.method_version, methodIds.includes('recagent') ? 'synthetic-pool-v1' : 'online-method-v4');
  assert.deepEqual(row.protocol, limits);
  assert.equal(sha(row.trace[0].runtime.prior_state), stateBefore, 'method state chain mismatch');
  for (const [key, cap] of Object.entries({ model_calls: limits.max_model_calls, source_requests: limits.max_tool_calls, acquired_items: limits.max_acquired_items })) {
    assert(Number.isInteger(row.resources[key]) && row.resources[key] >= 0 && row.resources[key] <= cap, 'method budget exceeded');
  }
  assert(['submitted', 'failed', 'not_applicable'].includes(row.status));
  assert(row.slate.length <= topK && (row.status === 'submitted' ? row.slate.length > 0 : row.slate.length === 0));
  assert.equal(new Set(row.slate.map(item => item.id)).size, row.slate.length);
  assert.equal(sha(row.content_snapshot.items), row.content_snapshot.hash);
  if (poolContext) {
    assert.equal(row.adapter_protocol.pool_sha256, poolContext.pool_sha256, 'frozen pool fingerprint changed');
    assert.equal(row.resources.source_requests, 0, 'fixed-pool method made an online source request');
    assert.equal(sha(row.content_snapshot.items), sha(poolContext.cards), 'frozen pool materials changed');
    if (row.status === 'submitted' && method !== 'fixed-retrieval') {
      assert.deepEqual(row.adapter_protocol.selected_candidate_ids, poolContext.candidate_ids, 'pool shortlist changed');
    }
  }
  const acquired = new Map(row.content_snapshot.items.map(item => [item.id, item]));
  assert.equal(acquired.size, row.resources.acquired_items);
  for (const item of row.slate) {
    assert.equal(item.origin, poolContext ? 'frozen_pool' : 'live');
    assert.equal(sha(item), sha(acquired.get(item.id)), 'slate item differs from its acquired version');
  }
  if (method === 'fixed-retrieval') {
    assert.equal(row.resources.model_calls, 0);
    if (row.status === 'submitted') assert(row.trace.some(entry => entry.operation === 'fixed'
      && entry.response?.worker_resources?.model_loads_total === 2), 'persistent BGE receipt missing');
  }
  return {
    method_id: method, status: row.status, error: row.error ?? null, slate: row.slate,
    resources: row.resources, source_failures: row.trace.filter(entry => entry.phase === 'source_call' && entry.status === 'failed').length,
  };
}

function checkedRecord(value) {
  const { record_sha256, ...body } = value;
  assert.equal(sha(body), record_sha256, 'comparison record hash mismatch');
  return body;
}

function hashedRecord(body) {
  return { ...body, record_sha256: sha(body) };
}

function checkpointSummary(input, rows, study, methodIds) {
  const { questions, mapping, labels } = study ?? { questions: { blind: [] }, mapping: { cards: [], blind: [] }, labels: new Map() };
  const methods = Object.fromEntries(methodIds.map(method => {
    const row = rows.get(method);
    const links = mapping.cards.filter(link => link.method === method);
    const cards = (row?.slate ?? []).map((item, index) => {
      const link = links[index], label = link && labels.get(link.question_id);
      return {
        rank: index + 1, material: publicCard(item), question_id: link?.question_id ?? null,
        constraint: link?.constraint ?? evaluateHardConstraints(item, input.phase.hard),
        interest: label?.decision ?? null, label_status: label?.status ?? 'missing',
      };
    });
    return [method, {
      run_id: row?.run_id ?? null, status: row?.status ?? 'missing', error: row?.error ?? null,
      run_file_sha256: row?.run_file_sha256 ?? null, resources: row?.resources ?? null,
      source_failures: row?.source_failures ?? null, elapsed_ms: row?.elapsed_ms ?? null, cards,
    }];
  }));
  const available = methodIds.every(method => methods[method].cards.length === topK);
  const blind = Array.from({ length: topK }, (_, index) => {
    const question = questions.blind[index], link = mapping.blind[index];
    const label = question && labels.get(question.id);
    const choice = label?.decision?.choice ?? null;
    const selected = available && blindOptions.includes(choice) ? sha(question.material[choice]) : null;
    const selected_methods = selected ? Object.entries(question.material)
      .filter(([, card]) => sha(card) === selected).map(([letter]) => link.options[letter]) : [];
    return {
      rank: index + 1, available, question_id: question?.id ?? null, material_sha256: question?.material_sha256 ?? null,
      options: link?.options ?? null, choice, selected_methods, outcome: available ? selected ? 'selected' : choice ?? 'missing' : 'unavailable',
      label_status: label?.status ?? 'missing',
    };
  });
  return {
    user: input.user, round: input.round, subset: input.subset, captured_at: input.snapshot.captured_at,
    input_sha256: input.input_sha256, public_input_sha256: input.public_input_sha256, methods, blind,
  };
}

export async function runComparison({ root, inputs, api, onProgress = () => {}, signal, replayPilot, contentPool }) {
  assert(typeof root === 'string' && root, 'new comparison output root is required');
  assert(typeof api?.flashModel === 'string' && api.raw && typeof api.complete === 'function'
    && typeof api.generate === 'function' && typeof api.stats === 'function', 'preflighted comparison API is required');
  signal?.throwIfAborted();
  const tracks = prepareInputs(inputs);
  const checkpoints = [...tracks.values()].flat();
  const checkpointsByUser = Object.fromEntries([...tracks].map(([user, rows]) => [user, rows.map(item => ({
    round: item.round, subset: item.subset, input_sha256: item.input_sha256, public_input_sha256: item.public_input_sha256, phase_sha256: item.phase_sha256,
  }))]));
  const sourceConfig = {
    providers: api.raw.providers || {}, composio: api.raw.composio || {},
    allowed: api.raw.runtime?.waterfall?.sources || {}, rssFeeds: api.raw.runtime?.waterfall?.rssFeeds || [],
  };
  const transport = { credential_set_sha256: api.stats().credential_set_sha256 ?? null, source_config_sha256: sha(sourceConfig) };
  sourceConfig.signal = signal;
  const ids = input => input.snapshot.available_sources.map(source => typeof source === 'string' ? source : source.id).sort();
  const requested = ids(checkpoints[0]);
  assert.equal(new Set(requested).size, requested.length, 'duplicate source in snapshot');
  for (const input of checkpoints) assert.deepEqual(ids(input), requested, 'comparison checkpoints disagree on allowed sources');
  const catalog = sourceCatalog(sourceConfig).filter(source => requested.includes(source.id) && source.configured && source.allowed);
  assert.equal(catalog.length, requested.length, 'configured source capability changed');
  assert(!contentPool || !replayPilot, 'fixed-pool comparison requires its own fresh pilot');
  const pool = contentPool ? readContentPool(contentPool, requested) : null;
  const methodIds = pool ? comparisonMethods : RESEARCH_METHODS;
  const poolContexts = new Map(pool ? checkpoints.map(input => [input, {
    ...candidatesForCheckpoint(pool, input.public_input), pool_sha256: pool.lineage.cards_sha256,
  }]) : []);
  const protectOldRuns = path => {
    for (const old of [baseline, join(outputRoot, 'synthetic-pilot-20261105-10x20')]) {
      assert(path !== old && !path.startsWith(old + sep), 'comparison output overlaps frozen evidence');
    }
  };
  root = resolve(root);
  protectOldRuns(root);
  let existing = root;
  while (!existsSync(existing)) existing = dirname(existing);
  root = resolve(realpathSync(existing), relative(existing, root));
  protectOldRuns(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, 'comparison.lock');
  const lock = openSync(lockPath, 'wx', 0o600);
  let hybrid;
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: now() }) + '\n');
    fsyncSync(lock);
    const inputPath = join(root, 'input-lineage.json');
    if (existsSync(inputPath)) {
      assert(!replayPilot, 'pilot replay requires a new comparison directory');
      checkPrefix(read(inputPath), checkpointsByUser);
    }
    if (replayPilot) {
      assert(!existsSync(join(replayPilot, 'comparison.lock')), 'pilot still active');
      assert.deepEqual(read(join(replayPilot, 'input-lineage.json')), checkpointsByUser, 'pilot checkpoint lineage changed');
      const old = read(join(replayPilot, 'analysis.json'));
      assert(old.integrity.passed && old.coverage.done === checkpoints.length * methodIds.length, 'pilot method runs are incomplete');
    }
    const runtime = await freezeRuntime(root, catalog, api.flashModel, transport, replayPilot, pool, methodIds);
    const { salt, config_sha256, createResearchRunner, createResearchStateStore, pythonBridge } = runtime;
    write(inputPath, checkpointsByUser, true);
    const resultPath = (input, method) => join(root, 'runs', input.user, String(input.round), method + '.json.gz');
    const attemptPath = (input, method) => join(root, 'attempts', input.user, String(input.round), method + '.json');
    if (replayPilot || checkpoints.some(input => !existsSync(resultPath(input, 'fixed-retrieval')) && !existsSync(attemptPath(input, 'fixed-retrieval')))) {
      await verifyWeights(runtime.weights);
      signal?.throwIfAborted();
      hybrid = await startHybridWorker(root, runtime.documentCache);
    }
    let recoveredUnicodeRuns = 0;
    if (replayPilot) {
      cpSync(join(replayPilot, 'state'), join(root, 'state'), { recursive: true, errorOnExist: true, force: false });
      for (const input of checkpoints) for (const method of methodIds) {
        const archived = join(replayPilot, 'runs', input.user, String(input.round), method + '.json.gz');
        const bytes = readFileSync(archived);
        const oldRecord = JSON.parse(gunzipSync(bytes));
        let record = checkedRecord(oldRecord);
        assert.equal(record.config_sha256, runtime.legacyConfig);
        assert.equal(record.input_sha256, input.input_sha256);
        assert.equal(record.public_input_sha256, input.public_input_sha256);
        const sourceAttempt = read(join(replayPilot, 'attempts', input.user, String(input.round), method + '.json'));
        assert.equal(sourceAttempt.run_id, record.run_id);
        assert.equal(sourceAttempt.config_sha256, runtime.legacyConfig);
        const affected = method === 'fixed-retrieval' && record.methods[0].status === 'failed' && /^TypeError: TextEncodeInput/.test(record.methods[0].error || '');
        if (affected) {
          record = await repairBgeRecord(oldRecord, payload => hybrid.request(payload, signal));
          recoveredUnicodeRuns++;
        }
        const provenance = { prior_config_sha256: runtime.legacyConfig, prior_artifact_sha256: sha(bytes), unicode_replay: affected };
        write(attemptPath(input, method), { ...sourceAttempt, config_sha256, reused_pilot: provenance }, true);
        write(resultPath(input, method), gzipSync(JSON.stringify(hashedRecord({
          ...record, config_sha256, slate_sha256: sha(record.methods[0].slate), reused_pilot: provenance,
        }))), true);
      }
      assert(recoveredUnicodeRuns > 0, 'no pilot run needed the approved Unicode replay');
    }
    const native = pythonBridge(python, authors, 900000);
    const recagent = pool ? pythonBridge(recPython, authors, 900000) : null;
    let cacheCatalog = runtime.documentCache && hybrid?.device === runtime.documentCache.device
      ? cleanBgePayload({ query: '', catalog: pool.cards.map(item => ({ id: item.id, text: item.title + '\n' + (item.summary || '') })) }).catalog
      : null;
    const pythonCall = (operation, payload, model) => {
      if (operation === 'fixed') {
        const request = cleanBgePayload(payload);
        if (cacheCatalog) {
          request.pool_catalog = cacheCatalog;
          cacheCatalog = null;
        }
        return hybrid.request(request, signal);
      }
      if (operation === 'recagent') return recagent(operation, payload, model);
      return native(operation, payload, model);
    };
    const sourceQueues = new Map(catalog.map(source => [source.id, limiter(4)]));
    const limitedAcquire = (action, config, options) => sourceQueues.get(action.source)(() => {
      signal?.throwIfAborted();
      return acquireSource(action, config, options);
    });
    const labelQueue = limiter(pool ? 30 : 12);
    const progress = {
      done: 0, total: checkpoints.length * methodIds.length, labels_done: 0, labels_total: 0,
      contexts_done: 0, contexts_total: checkpoints.length,
    };
    const emit = () => onProgress({ ...progress });
    const rowsByContext = new Map(checkpoints.map(input => [input, new Map()]));
    const studies = new Map(), grades = [], failures = [];
    let reusedRuns = 0, reusedLabels = 0, labelFailures = 0, labelAnswers = 0, labelProtocolUnavailable = 0;

    async function grade(input, rows) {
      const dir = join(root, 'studies', input.user, String(input.round));
      const { questions, mapping } = makeQuestions(input, [...rows.values()], salt, methodIds);
      const lineage = { config_sha256, input_sha256: input.input_sha256, phase_sha256: input.phase_sha256, public_input_sha256: input.public_input_sha256 };
      const questionFile = { ...lineage, ...questions };
      const mappingFile = { ...lineage, questions_sha256: sha(questionFile), ...mapping };
      for (const [filename, expected] of [['questions.json', questionFile], ['mapping.json', mappingFile]]) {
        const path = join(dir, filename);
        if (existsSync(path)) assert.deepEqual(read(path), expected, 'comparison question lineage changed');
        else write(path, expected, true);
      }
      const labels = new Map();
      studies.set(input, { questions, mapping, labels });
      const expectedLabels = questions.ratings.length + questions.blind.length;
      progress.labels_total += expectedLabels;
      emit();
      const labelQuestion = (question, mode) => labelQueue(async () => {
        const path = join(dir, 'labels', question.id + '.json');
        const dispatched = join(dir, 'label-attempts', question.id + '.json');
        const base = { ...lineage, question_id: question.id, mode, material_sha256: question.material_sha256 };
        let label;
        const oldPath = replayPilot && join(replayPilot, 'studies', input.user, String(input.round), 'labels', question.id + '.json');
        const priorBytes = oldPath && existsSync(oldPath) ? readFileSync(oldPath) : null;
        const priorLabel = priorBytes && checkedRecord(JSON.parse(priorBytes));
        if (existsSync(path)) {
          label = checkedRecord(read(path));
          for (const [key, expected] of Object.entries(base)) assert.equal(label[key], expected, 'cached label lineage changed');
          assert(label.decision === null || validDecision(label.decision, mode, question));
          reusedLabels++;
        } else if (priorLabel && priorLabel.material_sha256 === base.material_sha256) {
          for (const [key, expected] of Object.entries({ ...base, config_sha256: runtime.legacyConfig })) assert.equal(priorLabel[key], expected, 'prior label lineage changed');
          assert(priorLabel.decision === null || validDecision(priorLabel.decision, mode, question));
          label = { ...priorLabel, config_sha256, reused_pilot_label_sha256: sha(priorBytes) };
          write(path, hashedRecord(label), true);
          reusedLabels++;
        } else {
          label = { ...base, status: 'answered', decision: null, origin: 'model', evaluated_at: now() };
          if (question.unavailable) {
            label = { ...label, status: 'unavailable', decision: { choice: 'insufficient' }, origin: 'protocol' };
          } else if (existsSync(dispatched)) {
            label = { ...label, status: 'interrupted', origin: 'interrupted', error: 'prior_attempt_without_terminal_label' };
          } else {
            signal?.throwIfAborted();
            const messages = judgeMessages(input, question, mode);
            label.request_sha256 = sha(messages);
            write(dispatched, { ...base, request_sha256: label.request_sha256, dispatched_at: now() }, true);
            try {
              const response = await api.generate(messages, { max_tokens: 512, temperature: 0, stage: 'label_' + mode,
                user: input.user, round: input.round, question_id: question.id, signal });
              label.raw_output = response.choices?.[0]?.message?.content ?? null;
              label.provider_model = response.model ?? null;
              label.usage = response.usage ?? null;
              const raw = JSON.parse(label.raw_output);
              const decision = mode === 'rating' ? { status: raw?.status, rating: raw?.rating } : { choice: raw?.choice };
              assert(validDecision(decision, mode, question), 'invalid ' + mode + ' answer');
              label.decision = decision;
              if (decision.status === 'unable') label.status = 'unable';
            } catch (error) {
              label.status = 'failed';
              label.error = errorText(error);
              label.raw_output ??= error.partialResponse?.choices?.[0]?.message?.content ?? null;
            }
          }
          write(path, hashedRecord(label), true);
        }
        labels.set(question.id, label);
        if (['failed', 'interrupted'].includes(label.status)) labelFailures++;
        if (['answered', 'unable'].includes(label.status)) labelAnswers++;
        if (label.status === 'unavailable') labelProtocolUnavailable++;
        progress.labels_done++;
        emit();
      });
      async function chooseInOrder() {
        const results = [];
        for (const question of questions.blind) results.push(...await Promise.allSettled([labelQuestion(question, 'blind')]));
        return results;
      }
      const settled = await Promise.all([Promise.allSettled(questions.ratings.map(question => labelQuestion(question, 'rating'))), chooseInOrder()]);
      for (const result of settled.flat()) {
        if (result.status === 'rejected') failures.push({ stage: 'label', user: input.user, round: input.round, error: errorText(result.reason) });
      }
      if (labels.size === expectedLabels) {
        progress.contexts_done++;
        emit();
      }
    }

    async function track(user, participant, method) {
      const stateDir = join(root, 'state', user, method);
      const stateStore = createResearchStateStore(stateDir);
      let current, runner, committed, stateBefore = sha(null);
      for (const input of participant) {
        current = input;
        const poolContext = poolMethods.includes(method) ? poolContexts.get(input) : undefined;
        const path = resultPath(input, method), attempted = attemptPath(input, method);
        let bytes, record, row;
        const lineage = {
          config_sha256, user, round: input.round, subset: input.subset, input_sha256: input.input_sha256,
          public_input_sha256: input.public_input_sha256, state_before_sha256: stateBefore, duration_adapter: method === 'waterfall' ? durationAdapter : null,
        };
        if (existsSync(path)) {
          bytes = readFileSync(path);
          record = checkedRecord(JSON.parse(gunzipSync(bytes)));
          for (const [key, expected] of Object.entries(lineage)) assert.equal(record[key], expected, 'cached method lineage changed');
          assert.equal(read(attempted).run_id, record.run_id, 'cached run dispatch mismatch');
          row = checkRun(record, input, method, stateBefore, catalog, methodIds, poolContext);
          reusedRuns++;
        } else {
          assert(!existsSync(attempted), 'prior method attempt lacks a terminal result and requires reconciliation');
          signal?.throwIfAborted();
          if (!runner) {
            assert.equal(sha(stateStore.get(input.userId, method)), stateBefore, 'persisted method state differs from prior checkpoint');
            runner = createResearchRunner({
              researchRoot: authors, config: { model: api.flashModel, pythonPath: python }, sourceConfig, catalog,
              methodIds, workerMethodId: method, stateStore, pythonCall, acquireSource: limitedAcquire,
              archive: entry => {
                appendFileSync(join(stateDir, 'archives', entry.run_id + '.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
                if (entry.event === 'method_complete') committed = entry;
              },
              modelCall: async request => {
                signal?.throwIfAborted();
                const started_at = now();
                const thinking = { type: 'enabled' };
                const body = { ...request, enable_thinking: true, thinking,
                  extra_body: { ...request.extra_body, thinking }, temperature: 0.3, max_tokens: limits.max_output_tokens };
                const response = await api.complete(body, { stage: 'method_' + method, user, round: current.round, signal });
                const answer = response.choices[0];
                return {
                  attempt_id: response.id ?? randomUUID(), status: 'success', requested_model: api.flashModel, provider_response_model: response.model,
                  content: answer.message.content, reasoning_content: answer.message.reasoning_content, usage: response.usage, finish_reason: answer.finish_reason,
                  request_settings: { enable_thinking: true, thinking, temperature: 0.3, max_tokens: limits.max_output_tokens },
                  started_at, completed_at: now(),
                };
              },
            });
          }
          const run_id = randomUUID(), started = Date.now();
          committed = undefined;
          write(attempted, { ...lineage, run_id, started_at: now() }, true);
          const result = await runner({
            snapshot: input.snapshot, history: input.history, userId: input.userId, job_id: run_id, data_origin: 'synthetic',
            session: { session_id: input.sessionId, user_id: input.userId, record_kind: 'synthetic', data_origin: 'synthetic' },
            ...(poolContext ? { frozen_pool: poolContext } : {}),
          });
          assert.equal(result.run_id, run_id);
          row = checkRun(result, input, method, stateBefore, catalog, methodIds, poolContext);
          assert.equal(committed?.run_id, run_id, 'method state archive missing');
          record = { ...result, ...lineage, elapsed_ms: Date.now() - started, state_after_sha256: committed.state_sha256, slate_sha256: sha(row.slate) };
          bytes = gzipSync(JSON.stringify(hashedRecord(record)));
          write(path, bytes, true);
        }
        assert.equal(sha(row.slate), record.slate_sha256, 'slate hash mismatch');
        stateBefore = record.state_after_sha256;
        const rows = rowsByContext.get(input);
        rows.set(method, { ...row, run_id: record.run_id, run_file_sha256: sha(bytes), elapsed_ms: record.elapsed_ms });
        progress.done++;
        emit();
        if (rows.size === methodIds.length) {
          const ordered = new Map(methodIds.map(id => [id, rows.get(id)]));
          grades.push(grade(input, ordered).catch(error => {
            failures.push({ stage: 'study', user, round: input.round, error: errorText(error) });
          }));
        }
      }
      assert.equal(sha(stateStore.get(current.userId, method)), stateBefore, 'persisted final method state differs from run');
    }

    emit();
    const jobs = [...tracks].flatMap(([user, participant]) => methodIds.map(method => ({ user, participant, method })));
    const settled = await Promise.allSettled(jobs.map(job => track(job.user, job.participant, job.method)));
    for (const [index, result] of settled.entries()) {
      if (result.status === 'rejected') {
        const { user, method } = jobs[index];
        failures.push({ stage: 'method_track', user, method, error: errorText(result.reason) });
      }
    }
    await Promise.all(grades);
    const summaries = checkpoints.map(input => checkpointSummary(input, rowsByContext.get(input), studies.get(input), methodIds));
    const complete = progress.done === progress.total && progress.contexts_done === progress.contexts_total && !failures.length;
    const summary = {
      status: !signal?.aborted && complete ? 'completed' : 'incomplete',
      data_origin: 'synthetic', method_ids: methodIds, config_sha256, ...(pool ? { fixed_pool: pool.lineage } : {}),
      ...(runtime.documentCache ? { bge_document_cache: runtime.documentCache } : {}),
      coverage: { ...progress, reused_runs: reusedRuns, reused_labels: reusedLabels, recovered_unicode_runs: recoveredUnicodeRuns, label_failures: labelFailures,
        label_answers: labelAnswers, label_protocol_unavailable: labelProtocolUnavailable },
      integrity: {
        passed: complete, validated_method_runs: progress.done, shared_public_projection: true, method_state_scope: 'per user per method',
        duration_adapter: durationAdapter, history_order: historyOrder, blind_protocol: blindProtocol,
        dcg: 'sum(interest / log2(rank + 1)) when all five cards are rated',
      },
      failures, api: api.stats(), ...summarizeComparison(summaries, methodIds),
    };
    write(join(root, 'analysis.json'), summary, true);
    return summary;
  } finally {
    await hybrid?.close();
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
