import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import test from 'node:test';
import {createRequestGate} from '../shared/request-gate.mjs';
import {installMeteredFetch} from './api.mjs';

const base = 'https://api.jiuwenappless.com/v1';
const flash = 'DeepSeek-V4.1-Flash-1017';
const pro = 'DeepSeek-V4-Pro';
const credentials = ['sk-fixture-one', 'sk-fixture-two', 'sk-fixture-three'];
const messages = [{role: 'user', content: 'test'}];
const completion = (model, content = '{"ok":true}') => Response.json({
  model: model === pro ? 'DeepSeek-V4-Pro' : model.toLowerCase(),
  usage: {prompt_tokens: 12, completion_tokens: 3},
  choices: [{finish_reason: 'stop', message: {content}}],
}, {headers: {'x-litellm-response-cost': '0.001'}});

async function fixture(fetch, run) {
  const outputDir = mkdtempSync(join(tmpdir(), 'waterfall-meter-test-'));
  const configPath = join(outputDir, 'config.json');
  const approved = join(outputDir, 'approved.json');
  writeFileSync(approved, JSON.stringify({enabled: true, credentials: [{apiKey: credentials[2], apiBase: base, model: flash}]}));
  writeFileSync(configPath, JSON.stringify({
    apiKey: credentials[0], apiBase: `${base}/chat/completions`, recommendationModelName: flash,
    extraEndpoints: credentials.slice(0, 2).map(apiKey => ({apiKey, apiBase: base, model: flash})),
    waterfallApprovedCredentialsFile: approved,
  }));
  const originalFetch = globalThis.fetch;
  const originalGateDir = process.env.WATERFALL_REQUEST_GATE_DIR;
  process.env.WATERFALL_REQUEST_GATE_DIR = join(outputDir, 'gates');
  let api;
  try {
    globalThis.fetch = async (url, request) => {
      assert.equal(url, `${base}/chat/completions`);
      assert.equal(request.redirect, 'error');
      assert.equal(request.method, 'POST');
      const key = request.headers.Authorization.slice('Bearer '.length);
      assert.ok(credentials.includes(key));
      return fetch(key, JSON.parse(request.body), request.signal);
    };
    api = await installMeteredFetch({configPath, outputDir});
    const read = file => readFileSync(join(outputDir, 'api', file), 'utf8');
    await run(api, {
      read, stats: () => JSON.parse(read('stats.json')),
      receipts: () => read('receipts.jsonl').trim().split('\n').map(JSON.parse),
    });
  } finally {
    api?.restore();
    globalThis.fetch = originalFetch;
    if (originalGateDir === undefined) delete process.env.WATERFALL_REQUEST_GATE_DIR;
    else process.env.WATERFALL_REQUEST_GATE_DIR = originalGateDir;
    rmSync(outputDir, {recursive: true, force: true});
  }
}

test('preflight verifies the exact Flash and Pro routes independently and records safe usage', async () => {
  await fixture((key, body) => key === credentials[0] && body.model === pro
    ? Response.json({error: {type: 'permission_denied', message: `rejected ${key}`}}, {status: 403})
    : completion(body.model), async (api, files) => {
    await assert.rejects(api.generate(messages), /No verified flash API slot/);
    const checks = await api.preflight({includePro: true});
    assert.equal(checks.length, 6);
    assert.deepEqual(checks.filter(check => !check.ok).map(check => [check.slot, check.family]), [['key-1', 'pro']]);
    assert.deepEqual(await api.preflight({includePro: true}), checks);
    assert.equal((await api.generate(messages, {model: 'pro', stage: 'audit'})).model, 'DeepSeek-V4-Pro');
    await assert.rejects(api.complete({messages, model: 'another-flash-model'}), /api_wrong_requested_model/);
    const stats = files.stats();
    assert.deepEqual(stats.slots.map(slot => slot.id), ['key-1', 'key-2', 'key-3']);
    assert.deepEqual(stats.slots.map(slot => slot.enabled), [{flash: true, pro: false}, {flash: true, pro: true}, {flash: true, pro: true}]);
    assert.equal(stats.successes, 6);
    assert.equal(stats.failures, 1);
    assert.equal(stats.prompt_tokens, 72);
    assert.equal(stats.completion_tokens, 18);
    assert.equal(stats.reported_cost_calls, 6);
    assert.ok(Math.abs(stats.reported_usd - 0.006) < 1e-9);
    assert.equal(stats.slots.reduce((count, slot) => count + slot.rpm_60s, 0), 7);
    assert.equal(stats.slots.reduce((count, slot) => count + slot.tpm_60s, 0), 90);
    assert.equal(stats.pid, process.pid);
    assert.ok(Number.isFinite(Date.parse(stats.updated_at)));
    assert.equal(files.receipts().filter(row => row.stage === 'audit').length, 1);
    assert.ok(files.receipts().every(row => row.http_started_at && row.finished_at));
    for (const key of credentials) {
      for (const file of ['receipts.jsonl', 'stats.json', 'preflight.json']) assert.ok(!files.read(file).includes(key));
    }
  });
});

test('preflight can release generation on the first verified Flash route', async () => {
  let unblock;
  const waiting = new Promise(resolve => { unblock = resolve; });
  await fixture(async (key, body) => {
    if (key === credentials[2]) await waiting;
    return completion(body.model);
  }, async api => {
    let ready;
    const flashReady = new Promise(resolve => { ready = resolve; });
    const checks = api.preflight({onResult(result) { if (result.ok && result.family === 'flash') ready(result); }});
    try {
      const first = await Promise.race([flashReady, sleep(800).then(() => null)]);
      assert.equal(first?.ok, true);
      assert.equal(api.stats().slots[2].enabled.flash, false);
    } finally {
      unblock();
      assert.equal((await checks).length, 6);
    }
  });
});

test('wrong model and exhausted budget stop their routes without replaying a dispatch', async () => {
  let probes = true;
  const seen = [];
  await fixture((key, body) => {
    if (probes) return completion(body.model);
    seen.push(key);
    if (key === credentials[0]) return completion('DeepSeek-V3-Flash');
    if (key === credentials[1]) return Response.json({error: {type: 'budget_exceeded', retryable: false}}, {status: 429});
    return completion(body.model);
  }, async (api, files) => {
    await api.preflight({includePro: false});
    probes = false;
    await assert.rejects(api.complete({messages}), error => error.message === 'model_response_mismatch' && error.retryable === false);
    await assert.rejects(api.complete({messages}), error => error.message === 'model_http_429' && error.retryable === false);
    const wrapped = await globalThis.fetch(`${base}/chat/completions`, {method: 'POST', body: JSON.stringify({messages, model: flash})});
    assert.equal((await wrapped.json()).model, flash.toLowerCase());
    assert.deepEqual(seen, credentials);
    const failures = files.receipts().filter(row => !row.success);
    assert.deepEqual(failures.map(row => [row.slot, row.prompt_tokens]), [['key-1', 12], ['key-2', null]]);
    assert.deepEqual(api.stats().slots.map(slot => slot.enabled.flash), [false, false, true]);
  });
});

test('retains billed partial-stream usage and holds the ambiguous request', async () => {
  let probes = true;
  let dispatched = 0;
  await fixture((key, body) => {
    if (probes) return completion(body.model);
    dispatched++;
    const partial = [
      {model: body.model, choices: [{index: 0, delta: {content: `partial ${key}`}}]},
      {usage: {prompt_tokens: 100, completion_tokens: 4}},
      {error: {type: 'upstream_error', message: 'connection reset'}},
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('');
    return new Response(partial, {headers: {'content-type': 'text/event-stream'}});
  }, async (api, files) => {
    await api.preflight({includePro: false});
    probes = false;
    await assert.rejects(api.complete({messages}), error => error.code === 'model_transport_error' && !error.retryable);
    const receipt = files.receipts().find(row => !row.success);
    assert.equal(dispatched, 1);
    assert.equal(receipt.partial_response.choices[0].message.content, 'partial [REDACTED]');
    assert.equal(receipt.prompt_tokens, 100);
    assert.equal(receipt.completion_tokens, 4);
    assert.equal(receipt.reported_usd, null);
    assert.equal(api.stats().slots[0].tpm_60s, 119);
    assert.equal(api.stats().usage_missing, 0);
  });
});

test('tracks 10 actual HTTP requests per key and drains queued work', {timeout: 22000}, async () => {
  let probes = true;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const dispatched = [];
  await fixture(async (key, body, signal) => {
    if (!probes) {
      dispatched.push({key, signal});
      await blocked;
    }
    return completion(body.model);
  }, async (api, files) => {
    await api.preflight({includePro: false});
    probes = false;
    const requests = Array.from({length: 45}, () => api.complete({messages}).then(value => ({value}), error => ({error})));
    try {
      const deadline = Date.now() + 17000;
      while (dispatched.length < 30 && Date.now() < deadline) await sleep(25);
      assert.equal(dispatched.length, 30);
      assert.equal(files.stats().http_in_flight, 30);
      assert.ok(files.stats().slots.every(slot => slot.http_in_flight === 10 && slot.peak_http_in_flight === 10 && slot.waiting === 5 && slot.configured_rpm === 50));
      api.drain();
      assert.ok(dispatched.every(({signal}) => !signal.aborted));
      await assert.rejects(api.complete({messages}), error => error.code === 'api_draining');
    } finally {
      release();
    }
    const results = await Promise.all(requests);
    assert.equal(results.filter(row => row.value).length, 30);
    assert.equal(results.filter(row => row.error?.code === 'api_draining').length, 15);
    assert.equal(dispatched.length, 30);
    assert.ok(files.stats().slots.every(slot => slot.http_in_flight === 0 && slot.waiting === 0));
  });
});

test('throttled retries and already-waiting calls reselect key-2 before another POST', async () => {
  let probes = true;
  const posts = [];
  await fixture((key, body) => {
    if (probes) return completion(body.model);
    posts.push({key, id: body.messages[0].content});
    if (key === credentials[1]) return completion(body.model);
    return Response.json({error: {type: 'throttling_error', message: 'Limit type: max_parallel_requests. Current limit: 10'}}, {status: 429});
  }, async (api, files) => {
    await api.preflight({includePro: false});
    probes = false;
    const requests = Array.from({length: 6}, (_, id) => api.complete({
      messages: [{role: 'user', content: String(id)}],
    }, {stage: 'cooldown-test', id}));
    const settled = Promise.allSettled(requests);
    try {
      assert.deepEqual(api.stats().slots.map(slot => slot.waiting), [2, 2, 2]);
      const results = await Promise.race([settled, sleep(10500, null, {ref: false})]);
      assert.ok(results?.every(row => row.status === 'fulfilled'), 'healthy key did not finish before the 60-second cooldown');
      assert.deepEqual(posts.filter(post => post.key === credentials[1]).map(post => post.id).sort(), ['0', '1', '2', '3', '4', '5']);
      assert.equal(posts.filter(post => post.key === credentials[0]).length, 1);
      assert.equal(posts.filter(post => post.key === credentials[2]).length, 1);
      const receipts = files.receipts().filter(row => row.stage === 'cooldown-test');
      assert.equal(receipts.length, 8);
      for (let id = 0; id < 6; id++) {
        const attempts = receipts.filter(row => row.meta.id === id);
        assert.equal(new Set(attempts.map(row => row.logical_request_id)).size, 1);
        assert.equal(new Set(attempts.map(row => row.request_sha256)).size, 1);
        assert.deepEqual(attempts.map(row => row.transport_attempt), attempts.length === 1 ? [1] : [1, 2]);
        assert.equal(attempts.filter(row => row.success).length, 1);
      }
    } finally {
      api.drain();
      await settled;
    }
  });
});


test('drain releases and counts a caller waiting for all routes to cool down', async () => {
  let probes = true;
  let posts = 0;
  await fixture((key, body) => {
    if (!probes) posts++;
    return completion(body.model);
  }, async (api, files) => {
    await api.preflight({includePro: false});
    probes = false;
    await Promise.all(credentials.map(key => createRequestGate({endpoint: base, key}).cooldown(60)));
    const result = api.complete({messages}).catch(error => error);
    try {
      const deadline = Date.now() + 1000;
      while (api.stats().in_flight && Date.now() < deadline) await sleep(5);
      assert.equal(api.stats().in_flight, 0);
      assert.equal(api.stats().waiting, 1);
      assert.equal(posts, 0);
    } finally {
      api.drain();
      assert.equal((await result).code, 'api_draining');
    }
    assert.equal(api.stats().waiting, 0);
    assert.equal(files.receipts().length, 3);
  });
});
