import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { cleanBgePayload, repairBgeRecord } from './bge-recovery.mjs';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = 'TypeError: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]';
const source = 'fixed-retrieval/retrieval.py';

function failedRecord() {
  const items = ['z', 'a', 'm', 'd', 'y', 'b'].map((id, i) => ({
    id, title: i === 0 ? 'captured 🎥\ud83c' : 'captured ' + id, summary: 'original 🌞', origin: 'live',
  }));
  const catalog = items.map(item => ({ id: item.id, text: item.title + '\n' + item.summary }));
  return {
    run_id: 'run', record_sha256: 'old-record', slate_sha256: sha([]),
    state_before_sha256: sha(null), state_after_sha256: sha({ state: null }),
    environment: { source_sha256: { [source]: sha(source) } },
    methods: [{
      method_id: 'fixed-retrieval', status: 'failed', error, protocol: { top_k: 5 }, slate: [],
      acquired_ids: items.map(item => item.id), content_snapshot: { items, hash: sha(items) },
      state_after: null, resources: { model_calls: 0, source_requests: 20, acquired_items: items.length },
      trace: [
        { phase: 'method_context', runtime: { prior_state: null } },
        { phase: 'source_capture', capture: { items } },
        { phase: 'tool_call', operation: 'fixed', status: 'failed', call_id: 'original-call', payload: { query: 'public 🎞️', catalog }, error },
      ],
    }],
  };
}

function ranked(payload) {
  const ids = payload.catalog.map(item => item.id);
  return {
    query: payload.query, catalog_count: ids.length, acquired_ids: ids,
    ordered_item_ids: [...ids].reverse(), worker_resources: { model_loads_total: 2 },
  };
}

test('cleaning preserves intact Unicode, IDs, catalog order, and original payload', () => {
  const payload = { query: '中文\udc00🎥', catalog: [{ id: 'first', text: '✍️' }, { id: 'last', text: '\ud83e🎥' }] };
  const before = structuredClone(payload);
  assert.deepEqual(cleanBgePayload(payload), { query: '中文�🎥', catalog: [{ id: 'first', text: '✍️' }, { id: 'last', text: '�🎥' }] });
  assert.deepEqual(payload, before);
});

test('replay uses the cleaned archived payload and emits the actual top five from unchanged captured items', async () => {
  const original = failedRecord(), before = structuredClone(original);
  let calls = 0;
  const repaired = await repairBgeRecord(original, payload => {
    calls++;
    assert.deepEqual(payload.catalog.map(item => item.id), ['z', 'a', 'm', 'd', 'y', 'b']);
    assert.equal(payload.catalog[0].text, 'captured 🎥�\noriginal 🌞');
    return ranked(payload);
  });
  assert.equal(calls, 1);
  assert.deepEqual(original, before);
  assert.equal(repaired.record_sha256, undefined);
  assert.equal(repaired.slate_sha256, undefined);
  assert.equal(repaired.state_before_sha256, original.state_before_sha256);
  assert.equal(repaired.state_after_sha256, original.state_after_sha256);
  const method = repaired.methods[0];
  assert.equal(method.status, 'submitted');
  assert.equal(method.error, undefined);
  assert.deepEqual(method.original_ordered_item_ids, ['b', 'y', 'd', 'm', 'a', 'z']);
  assert.deepEqual(method.slate, original.methods[0].content_snapshot.items.slice().reverse().slice(0, 5));
  assert.deepEqual(method.content_snapshot, original.methods[0].content_snapshot);
  assert.deepEqual(method.resources, original.methods[0].resources);
  assert.deepEqual(method.trace.slice(0, -1), original.methods[0].trace);
  assert.equal(method.trace.at(-1).recovery.original_call_id, 'original-call');
  assert.deepEqual(method.trace.at(-1).recovery.repaired_catalog_ids, ['z']);
});

test('replay refuses other errors, well-formed inputs, or an invalid ranking', async () => {
  const original = failedRecord();
  const unrelated = structuredClone(original);
  unrelated.methods[0].error = 'network error';
  await assert.rejects(() => repairBgeRecord(unrelated, () => assert.fail('ran unrelated failure')), /TextEncodeInput/);
  const wellFormed = structuredClone(original);
  const method = wellFormed.methods[0];
  method.content_snapshot.items[0].title = method.content_snapshot.items[0].title.toWellFormed();
  method.content_snapshot.hash = sha(method.content_snapshot.items);
  method.trace.at(-1).payload = cleanBgePayload(method.trace.at(-1).payload);
  await assert.rejects(() => repairBgeRecord(wellFormed, () => assert.fail('ran well-formed input')), /lone surrogates/);
  await assert.rejects(() => repairBgeRecord(original, payload => ({
    ...ranked(payload), ordered_item_ids: payload.catalog.map(() => 'z'),
  })), /invalid BGE ranking/);
});
