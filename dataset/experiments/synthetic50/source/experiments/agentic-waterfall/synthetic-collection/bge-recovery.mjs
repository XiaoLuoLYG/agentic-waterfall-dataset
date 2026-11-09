import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const tokenizerError = 'TypeError: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function cleanBgePayload(payload) {
  return {
    ...payload,
    query: payload.query.toWellFormed(),
    catalog: payload.catalog.map(item => ({ ...item, text: item.text.toWellFormed() })),
  };
}

// Replay only the local rank call. Source captures, method state, and the failed call remain evidence.
export async function repairBgeRecord(record, rank) {
  const { record_sha256, slate_sha256, ...body } = record;
  assert.equal(body.methods.length, 1, 'expected one archived method');
  const [method] = body.methods;
  assert(method.method_id === 'fixed-retrieval' && method.status === 'failed' && method.error === tokenizerError,
    'expected fixed-retrieval TextEncodeInput failure');
  assert(method.slate.length === 0 && method.resources.model_calls === 0 && method.protocol.top_k === 5, 'unexpected failed method result');
  const calls = method.trace.filter(entry => entry.phase === 'tool_call' && entry.operation === 'fixed');
  assert.equal(calls.length, 1, 'expected one archived fixed rank call');
  const [failed] = calls;
  assert(failed.status === 'failed' && failed.error === tokenizerError && failed.call_id, 'archived TextEncodeInput failure missing');

  const { items, hash } = method.content_snapshot;
  assert.equal(sha(items), hash, 'captured content hash mismatch');
  const captured = new Map(items.map(item => [item.id, item]));
  assert(items.length && captured.size === items.length && items.length === method.resources.acquired_items, 'invalid captured item count');
  assert(items.every(item => item.origin === 'live'), 'archived rank candidates must be live captures');
  assert.deepEqual([...captured.keys()], method.acquired_ids, 'archived acquisition order mismatch');
  assert.deepEqual(failed.payload.catalog, items.map(item => ({ id: item.id, text: item.title + '\n' + (item.summary || '') })),
    'rank payload differs from archived acquisition');
  const runtime_source_sha256 = body.environment.source_sha256['fixed-retrieval/retrieval.py'];
  assert(/^[a-f0-9]{64}$/.test(runtime_source_sha256), 'archived fixed rank source hash missing');

  const payload = cleanBgePayload(failed.payload);
  const repaired_query = payload.query !== failed.payload.query;
  const repaired_catalog_ids = payload.catalog.filter((item, index) => item.text !== failed.payload.catalog[index].text).map(item => item.id);
  assert(repaired_query || repaired_catalog_ids.length, 'archived rank payload has no lone surrogates');
  const started_at = new Date().toISOString();
  const response = await rank(payload);
  const { acquired_ids, ordered_item_ids } = response;
  const count = Math.min(items.length, 100);
  assert(response.query === payload.query && response.catalog_count === items.length && response.worker_resources?.model_loads_total === 2,
    'persistent BGE receipt mismatch');
  assert(Array.isArray(acquired_ids) && Array.isArray(ordered_item_ids) && acquired_ids.length === count && ordered_item_ids.length === count,
    'invalid BGE ranking size');
  const selected = new Set(acquired_ids);
  assert(selected.size === count && [...selected].every(id => captured.has(id))
    && new Set(ordered_item_ids).size === count && ordered_item_ids.every(id => selected.has(id)), 'invalid BGE ranking identities');

  const replay = {
    phase: 'tool_call', operation: 'fixed', status: 'success', call_id: randomUUID(), started_at,
    completed_at: new Date().toISOString(), payload, response,
    recovery: {
      policy: 'lone_utf16_surrogates_to_replacement_character', original_call_id: failed.call_id,
      original_payload_sha256: sha(failed.payload), replay_payload_sha256: sha(payload), repaired_query, repaired_catalog_ids,
    },
  };
  const { error, ...original } = method;
  return {
    ...body,
    methods: [{
      ...original, status: 'submitted', runtime_source_sha256, original_ordered_item_ids: ordered_item_ids,
      slate: ordered_item_ids.slice(0, method.protocol.top_k).map(id => captured.get(id)),
      trace: [...method.trace, replay],
    }],
  };
}
