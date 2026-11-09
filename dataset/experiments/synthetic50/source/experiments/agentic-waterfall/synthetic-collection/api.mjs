import {createHash, randomUUID} from 'node:crypto';
import {appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {readModelResponse} from '../shared/model-response.mjs';
import {createRequestGate} from '../shared/request-gate.mjs';

// Routing and SSE accounting follow the synthetic 10x20 v4 pilot adapter.
const flashModel = 'DeepSeek-V4.1-Flash-1017';
const proModel = 'DeepSeek-V4-Pro';
const models = {flash: flashModel, pro: proModel};
const host = 'api.jiuwenappless.com';
const endpoint = `https://${host}/v1/chat/completions`;
const maxConcurrent = 10;
const configuredRpm = 50;
const gateWaitLimitMs = 300000;
const usageTotals = () => ({attempts: 0, successes: 0, failures: 0, prompt_tokens: 0, completion_tokens: 0, usage_missing: 0, reported_usd: 0, reported_cost_calls: 0});
const noThinking = {enable_thinking: false, thinking: {type: 'disabled'}, extra_body: {thinking: {type: 'disabled'}}, response_format: {type: 'json_object'}};
const probeMessages = [{role: 'user', content: 'Return only a JSON object: {"ok":true}.'}];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const iso = time => new Date(time).toISOString();
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const sameModel = (actual, expected) => typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase();
const failed = (code, details = {}) => Object.assign(Error(code), {code, retryable: false, ...details});
const drainError = () => failed('api_draining', {draining: true});
const skipped = Symbol('route_unavailable_before_dispatch');
const permanentPattern = /budget|credit|balance|billing|payment|arrearage|overdue|unpaid|access[_. -]?denied|unauthori[sz]ed|permission|forbidden|unpurchase|invalid[_. -]?(?:api[_. -]?)?key|not[_. -]?allowed|余额|额度不足|欠费|无权限/i;
const quotaPattern = /insufficient[_. -]?quota|quota[_. -]?exceeded/i;
const throttledPattern = /rate[_. -]?limit|throttl|too many requests|concurren|requests? per|\b[RT]PM\b/i;

function isPermanent(detail) {
  const description = JSON.stringify(detail);
  return detail?.retryable === false || permanentPattern.test(description) || (quotaPattern.test(description) && !throttledPattern.test(description));
}

function readConfig(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw failed('api_private_config_unreadable'); }
}

export async function installMeteredFetch({configPath, outputDir}) {
  const raw = readConfig(configPath);
  const candidates = [{apiKey: raw.apiKey, apiBase: raw.apiBase, model: raw.recommendationModelName || raw.modelName}, ...(raw.extraEndpoints || [])];
  if (raw.waterfallApprovedCredentialsFile) {
    const approved = readConfig(resolve(dirname(configPath), raw.waterfallApprovedCredentialsFile));
    if (approved.enabled === true) candidates.push(...(approved.credentials || []));
  }
  const credentials = new Map();
  for (const {apiKey, apiBase, model} of candidates) {
    if (!apiKey || !apiBase) continue;
    if (typeof apiKey !== 'string' || /\s/.test(apiKey)) throw failed('api_credential_invalid');
    let url;
    try { url = new URL(apiBase); } catch { throw failed('api_endpoint_invalid'); }
    const path = url.pathname.replace(/\/+$/, '');
    if (url.origin !== `https://${host}` || url.username || url.password || url.search || url.hash || !['/v1', '/v1/chat/completions'].includes(path)) throw failed('api_endpoint_unauthorized');
    if (model && !sameModel(model, flashModel)) throw failed('api_configured_flash_model_mismatch');
    if (!credentials.has(apiKey)) credentials.set(apiKey, model || flashModel);
  }
  if (!credentials.size || credentials.size > 3) throw failed('api_credential_count_out_of_scope');
  const safeJSON = value => {
    let encoded = JSON.stringify(value);
    for (const key of credentials.keys()) encoded = encoded.replaceAll(JSON.stringify(key).slice(1, -1), '[REDACTED]');
    return encoded.replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED]');
  };
  const clean = value => JSON.parse(safeJSON(value));

  const directory = join(outputDir, 'api');
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const statsFile = join(directory, 'stats.json');
  const receiptsFile = join(directory, 'receipts.jsonl');
  const credentialSet = sha256(JSON.stringify([...credentials]));
  const prior = existsSync(statsFile) ? JSON.parse(readFileSync(statsFile, 'utf8')) : null;
  if (prior && (!prior.closed_at || prior.in_flight || prior.waiting || prior.pending?.length || prior.credential_set_sha256 !== credentialSet)) {
    throw failed('api_prior_requests_require_reconciliation');
  }
  const gateStop = new AbortController();
  const slots = [...credentials].map(([key, flash], index) => {
    const id = `key-${index + 1}`;
    const previous = prior?.slots.find(row => row.id === id);
    const totals = usageTotals();
    for (const field of Object.keys(totals)) totals[field] = previous?.[field] ?? 0;
    return {
      id, key, flash, pro: proModel, totals, reserved: 0, queue: [], http: 0, peak: previous?.peak_http_in_flight ?? 0,
      enabled: {flash: false, pro: false}, permanent: previous?.permanent_disabled ?? {}, probes: {}, starts: [], completions: [], cooldownUntil: 0, cooldownWaiters: 0,
      gate: createRequestGate({endpoint, key}, {wait: ms => sleep(ms, undefined, {signal: gateStop.signal})}),
    };
  });
  if (prior && existsSync(receiptsFile)) {
    for (const line of readFileSync(receiptsFile, 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      const slot = slots.find(item => item.id === row.slot);
      if (!slot || !row.http_started_at) continue;
      const started = Date.parse(row.http_started_at), finished = Date.parse(row.finished_at);
      if (started > Date.now() - 60000) slot.starts.push(started);
      if (finished > Date.now() - 60000) slot.completions.push({at: finished, tokens: (row.prompt_tokens ?? 0) + (row.completion_tokens ?? 0)});
    }
  }
  await Promise.all(slots.map(slot => slot.gate.setRateLimit(configuredRpm)));

  const original = globalThis.fetch;
  const pending = new Map();
  const startedAt = prior?.started_at ?? iso(Date.now());
  let closedAt = null, draining = false, storageFailed = false, cursor = 0;
  let peakHttp = prior?.peak_http_in_flight ?? 0;
  let peakReserved = prior?.peak_in_flight ?? 0;

  function snapshot() {
    const now = Date.now();
    const totals = usageTotals();
    let active = 0, http = 0, waiting = 0;
    const rows = slots.map(slot => {
      for (const field of Object.keys(totals)) totals[field] += slot.totals[field];
      active += slot.reserved;
      http += slot.http;
      const slotWaiting = slot.queue.length + slot.reserved - slot.http + slot.cooldownWaiters;
      waiting += slotWaiting;
      slot.starts = slot.starts.filter(time => time > now - 60000);
      slot.completions = slot.completions.filter(({at}) => at > now - 60000);
      return {
        id: slot.id, host, flash: slot.flash, pro: slot.pro, ...slot.totals,
        http_in_flight: slot.http, peak_http_in_flight: slot.peak, in_flight: slot.reserved, max_concurrent: maxConcurrent,
        waiting: slotWaiting, enabled: {...slot.enabled}, permanent_disabled: {...slot.permanent}, configured_rpm: configuredRpm,
        rpm_60s: slot.starts.length, tpm_60s: slot.completions.reduce((sum, row) => sum + row.tokens, 0),
      };
    });
    peakReserved = Math.max(peakReserved, active);
    peakHttp = Math.max(peakHttp, http);
    return {
      pid: process.pid, started_at: startedAt, updated_at: iso(now), closed_at: closedAt, draining, ...totals,
      in_flight: active, peak_in_flight: peakReserved, http_in_flight: http, peak_http_in_flight: peakHttp, waiting,
      slots: rows, pending: [...pending.values()], credential_set_sha256: credentialSet,
    };
  }

  function stopQueue() {
    draining = true;
    gateStop.abort(drainError());
    for (const slot of slots) for (const waiter of slot.queue.splice(0)) waiter.reject(drainError());
  }

  function persist(write) {
    if (storageFailed) throw failed('api_ledger_unavailable');
    try { write(); }
    catch {
      storageFailed = true;
      stopQueue();
      throw failed('api_ledger_unavailable');
    }
  }

  function saveJSON(path, value) {
    persist(() => {
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, safeJSON(value) + '\n', {mode: 0o600});
      renameSync(temp, path);
    });
  }
  const publish = () => saveJSON(statsFile, snapshot());
  const drain = () => { stopQueue(); publish(); return snapshot(); };

  function checkReady(signal) {
    if (draining) throw drainError();
    if (signal?.aborted) throw failed('api_request_aborted');
  }

  function choose(family) {
    const ordered = slots.slice(cursor).concat(slots.slice(0, cursor));
    const now = Date.now();
    const chosen = ordered.filter(slot => slot.enabled[family]).sort((a, b) =>
      Math.max(now, a.cooldownUntil) - Math.max(now, b.cooldownUntil)
      || a.reserved + a.queue.length - b.reserved - b.queue.length)[0];
    if (!chosen) throw failed(`No verified ${family} API slot`);
    if (chosen.cooldownUntil <= now) cursor = (slots.indexOf(chosen) + 1) % slots.length;
    return chosen;
  }

  async function reserve(slot, signal) {
    if (slot.reserved < maxConcurrent) { slot.reserved++; return; }
    await new Promise((resolveWaiter, rejectWaiter) => {
      const removeListener = () => signal?.removeEventListener('abort', abort);
      const waiter = {
        resolve: () => { removeListener(); resolveWaiter(); },
        reject: error => { removeListener(); rejectWaiter(error); },
      };
      const abort = () => {
        slot.queue.splice(slot.queue.indexOf(waiter), 1);
        waiter.reject(failed('api_request_aborted'));
        publish();
      };
      signal?.addEventListener('abort', abort, {once: true});
      slot.queue.push(waiter);
      publish();
    });
  }

  function disable(slot, family, reason) {
    slot.enabled[family] = false;
    slot.permanent[family] = reason;
  }

  function usage(result, response) {
    const usage = result?.usage;
    const prompt = tokenCount(usage?.prompt_tokens ?? usage?.input_tokens);
    const completion = tokenCount(usage?.completion_tokens ?? usage?.output_tokens);
    const costHeader = response?.headers.get('x-litellm-response-cost');
    const cost = costHeader ? Number(costHeader) : NaN;
    return {
      prompt_tokens: prompt, completion_tokens: completion,
      usage_status: prompt !== null && completion !== null ? 'recorded' : usage ? 'incomplete' : 'unknown',
      reported_usd: Number.isFinite(cost) && cost >= 0 ? cost : null,
    };
  }

  function addReceipt(slot, row) {
    const totals = slot.totals;
    totals.attempts++;
    totals[row.success ? 'successes' : 'failures']++;
    totals.prompt_tokens += row.prompt_tokens ?? 0;
    totals.completion_tokens += row.completion_tokens ?? 0;
    if (row.usage_status !== 'recorded') totals.usage_missing++;
    if (row.reported_usd !== null) { totals.reported_usd += row.reported_usd; totals.reported_cost_calls++; }
    slot.completions.push({at: Date.parse(row.finished_at), tokens: (row.prompt_tokens ?? 0) + (row.completion_tokens ?? 0)});
    persist(() => appendFileSync(receiptsFile, safeJSON(row) + '\n', {mode: 0o600}));
  }

  async function send(slot, payload, {family, stage, signal, meta, probe, logicalId, attempt}) {
    const unavailable = () => slot.permanent[family] || (!probe && (!slot.enabled[family] || slot.cooldownUntil > Date.now()));
    if (unavailable()) return skipped;
    checkReady(signal);
    const context = clean(meta);
    publish();
    let admission;
    try { admission = await slot.gate.admit({deadline: Date.now() + gateWaitLimitMs, deferCooldown: !probe}); }
    catch (error) { checkReady(signal); throw error; }
    checkReady(signal);
    if (typeof admission !== 'number') {
      slot.cooldownUntil = Math.max(slot.cooldownUntil, admission.cooldownUntil);
      return skipped;
    }
    if (unavailable()) return skipped;

    const body = JSON.stringify({...payload, model: slot[family], stream: true, stream_options: {include_usage: true}});
    const start = Date.now();
    const entry = {
      attempt_id: randomUUID(), logical_request_id: logicalId, transport_attempt: attempt,
      stage, family, slot: slot.id, endpoint_host: host, requested_model: slot[family],
      request_sha256: sha256(body), http_started_at: iso(start),
    };
    const timeout = AbortSignal.timeout(family === 'pro' ? 240000 : 180000);
    const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let result, response, error;
    // Publish unresolved dispatches first so a crash requires explicit reconciliation.
    pending.set(entry.attempt_id, entry);
    slot.http++;
    slot.peak = Math.max(slot.peak, slot.http);
    slot.starts.push(start);
    publish();
    try {
      response = await original(endpoint, {method: 'POST', redirect: 'error', headers: {'content-type': 'application/json', Authorization: `Bearer ${slot.key}`}, body, signal: requestSignal});
      if (!response.ok) {
        const text = (await response.text()).slice(0, 4096);
        let detail;
        try { const parsed = JSON.parse(text); detail = parsed.error ?? parsed; }
        catch { detail = {message: text}; }
        const status = response.status;
        const description = JSON.stringify(detail);
        const permanent = [401, 403, 404].includes(status) || isPermanent(detail);
        const retryAfter = response.headers.get('retry-after');
        const throttled = status === 429 && !permanent && (detail?.retryable === true || !!retryAfter || throttledPattern.test(description));
        const code = `model_http_${status}`;
        if (permanent) disable(slot, family, code);
        if (status === 401) disable(slot, family === 'flash' ? 'pro' : 'flash', code);
        throw failed(code, {status, detail: clean(detail), retryable: throttled, retry_after_seconds: Number(retryAfter) || 60});
      }
      result = await readModelResponse(response);
      if (!sameModel(result?.model, slot[family])) {
        disable(slot, family, 'model_response_mismatch');
        throw failed('model_response_mismatch', {provider_model: clean(result?.model ?? null)});
      }
      const choice = result?.choices?.[0];
      if (typeof choice?.message?.content !== 'string') throw failed('model_missing_content');
      if (choice.finish_reason !== 'stop') throw failed('model_incomplete_response', {detail: clean({finish_reason: choice.finish_reason})});
      return clean(result);
    } catch (cause) {
      if (cause.partialResponse) result = cause.partialResponse;
      if (cause.streamError && isPermanent(cause.streamError)) disable(slot, family, 'model_transport_error');
      error = cause.retryable !== undefined ? cause : failed(requestSignal.aborted ? signal?.aborted ? 'api_request_aborted' : 'model_timeout' : 'model_transport_error', {
        detail: clean(cause.streamError ?? {message: String(cause?.message ?? 'unknown transport error')}),
        partialResponse: cause.partialResponse ? clean(cause.partialResponse) : undefined,
        streamDiagnostic: cause.streamDiagnostic ? clean(cause.streamDiagnostic) : undefined,
      });
      throw error;
    } finally {
      addReceipt(slot, {
        ...entry, meta: context, finished_at: iso(Date.now()), success: !error, status: error ? 'failed' : 'success',
        http_status: response?.status ?? null, provider_model: result?.model ?? null, ...usage(result, response),
        error: error ? {code: error.code, detail: error.detail, retryable: error.retryable, stream_diagnostic: error.streamDiagnostic} : undefined,
        partial_response: error?.partialResponse,
      });
      slot.http--;
      pending.delete(entry.attempt_id);
    }
  }

  async function routed(body, {family, stage, signal, meta = {}, slot: probeSlot}) {
    if (!body || typeof body !== 'object' || (body.model !== undefined && !sameModel(body.model, models[family]))) throw failed('api_wrong_requested_model');
    const logicalId = randomUUID();
    let cooldownWaitDeadline;
    for (let attempt = 1;;) {
      checkReady(signal);
      const slot = probeSlot ?? choose(family);
      const now = Date.now();
      if (!probeSlot && slot.cooldownUntil > now) {
        cooldownWaitDeadline ??= now + gateWaitLimitMs;
        if (slot.cooldownUntil > cooldownWaitDeadline) throw failed('request_gate_call_deadline_exceeded');
        const waitSignal = signal ? AbortSignal.any([gateStop.signal, signal]) : gateStop.signal;
        slot.cooldownWaiters++;
        try { await sleep(Math.min(slot.cooldownUntil - now, 1000), undefined, {signal: waitSignal}); }
        catch (error) { checkReady(signal); throw error; }
        finally {
          slot.cooldownWaiters--;
          if (draining && !storageFailed) publish();
        }
        continue;
      }
      await reserve(slot, signal);
      try {
        const result = await send(slot, body, {family, stage, signal, meta, probe: !!probeSlot, logicalId, attempt});
        if (result !== skipped) return result;
        if (probeSlot) throw failed(slot.permanent[family]);
      } catch (error) {
        // A throttle explicitly rejects the call. A broken response can already be billed.
        if (!error.retryable || error.status !== 429) throw error;
        const anticipated = Date.now() + Math.ceil(Math.max(60, error.retry_after_seconds) * 1000);
        if (Number.isSafeInteger(anticipated)) slot.cooldownUntil = Math.max(slot.cooldownUntil, anticipated);
        const until = await slot.gate.cooldown(error.retry_after_seconds);
        slot.cooldownUntil = Math.max(slot.cooldownUntil, until);
        if (attempt >= 3) throw error;
        attempt++;
        cooldownWaitDeadline = undefined;
      } finally {
        const next = slot.queue.shift();
        if (next) next.resolve();
        else slot.reserved--;
        publish();
      }
    }
  }

  async function preflight({includePro = true, onResult} = {}) {
    checkReady();
    const families = includePro ? ['flash', 'pro'] : ['flash'];
    const checks = await Promise.all(slots.flatMap(slot => families.map(family => {
      slot.probes[family] ??= (async () => {
        try {
          const result = await routed({messages: probeMessages, max_tokens: 512, ...noThinking}, {family, stage: 'preflight', slot});
          if (JSON.parse(result.choices[0].message.content)?.ok !== true) throw failed('api_probe_invalid');
          if (slot.permanent[family]) throw failed(slot.permanent[family]);
          slot.enabled[family] = true;
          return {slot: slot.id, family, ok: true, provider_model: result.model};
        } catch (error) {
          return {slot: slot.id, family, ok: false, error: error.message, provider_model: error.provider_model, http_status: error.status};
        }
      })();
      return slot.probes[family].then(result => { onResult?.(result); return result; });
    })));
    saveJSON(join(directory, 'preflight.json'), checks);
    publish();
    return checks;
  }

  async function generate(messages, {model = 'flash', max_tokens = 4096, temperature = .4, stage = 'generator', signal, ...meta} = {}) {
    if (model !== 'flash' && model !== 'pro') throw failed('api_wrong_requested_model');
    return routed({messages, max_tokens, temperature, ...noThinking}, {family: model, stage, signal, meta});
  }
  const complete = (body, {stage = 'method', signal, ...meta} = {}) => routed(body, {family: 'flash', stage, signal, meta});

  const meteredFetch = async (input, options) => {
    if (String(input?.url || input) !== endpoint) return original(input, options);
    try {
      const request = new Request(input, options);
      if (request.method !== 'POST') throw failed('api_expected_post');
      return Response.json(await complete(await request.json(), {signal: request.signal}));
    } catch (error) {
      if (error.draining) throw error;
      return Response.json({error: {type: error.code ?? 'model_error', message: error.code ?? 'model_error', retryable: error.retryable === true}}, {status: error.status ?? 502});
    }
  };

  publish();
  globalThis.fetch = meteredFetch;
  const heartbeat = setInterval(() => { if (!storageFailed) publish(); }, 1000).unref();
  function restore() {
    clearInterval(heartbeat);
    if (globalThis.fetch === meteredFetch) globalThis.fetch = original;
    if (closedAt) return;
    stopQueue();
    closedAt = iso(Date.now());
    if (!storageFailed) publish();
  }
  return {raw, flashModel, proModel, generate, complete, preflight, drain, stats: snapshot, restore};
}
