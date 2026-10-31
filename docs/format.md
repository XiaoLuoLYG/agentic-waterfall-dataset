# Format contract: awf-dataset/1.0

`src/format.mjs` is the only shared normalization/projection implementation. Exports:

```js
normalizeContent(item)
buildDataset(episode, {captureRecords = []} = {})
```

The formatter is synchronous pure ESM, uses the server platform node:crypto SHA-256 API and makes no network/model calls. A site pins an exact byte copy and records its SHA-256. No recommendation-policy code is copied here. Build input is the existing demo `buildEpisode` object, including v13 episodes; unknown/missing legacy fields stay explicit.

## Corpus identity

`normalizeContent` accepts source metadata/public items or its own normalized output. It recomputes IDs on normalized rows, preserves truncation provenance, strips credential keys, and only retains the documented lightweight material allowlist. `original_item_id` can accompany a stored normalized row to preserve the feed's local alias.

`content_id` is `content:` + SHA-256 of UTF-8 `source + NUL + stable_source_item_id`. If a stable source item ID is unavailable, use a canonical HTTP(S) URL. URL user/password, fragment, common tracking parameters, and credential query parameters are removed; other query parameters are sorted. Items lacking both identities fail validation rather than receiving a fabricated source identity. Provider identity uses `source` or canonical-core `source_id`; `source_id` is never a native document ID. Native identity uses `source_item_id`, otherwise a recorded item `id` or canonical URL. When building a dataset, explicit native IDs establish provider-scoped item-alias/URL hints; only an unambiguous hint reconciles canonical-core and feed/capture identities. Different explicit native IDs remain distinct even for the same URL. Canonical-core `abstract` is stored as summary material.

`content_version_id` is `version:` + SHA-256 of the recursively key-sorted JSON of stored source/id/canonical URL, title, capped summary/text, source metadata, capture scope/status and original lengths. Observation times, retrieval rank, view counters, feed-local content hashes and query-derived topic are excluded. The source metadata allowlist is author/authors, modality/content_type, language, published_at, duration, tags, license. JavaScript strings and JSON number serialization are used; this repository's pinned formatter is authoritative.

## Tables

| Table | Primary key | Purpose |
| --- | --- | --- |
| contents | content_version_id | Versioned lightweight public source material; stable content_id can repeat |
| participants | participant_id | Explicit human/synthetic/test_only/unknown origin |
| profiles | profile_id | Provided profile and separately recorded inferred per-owner state |
| sessions | session_id | Private episode session and participant |
| events | event_id | Original natural and evaluator event provenance, availability time, material refs |
| contexts | context_id | Exact source_input_snapshot, cutoff_at, provided/inferred profile references |
| runs | run_id | Recorded feed/method runs, failure/interruption/missing-record status |
| slates | slate_id | Ordered items/ranks with exact content refs where material is available |
| studies | study_id | Evaluation protocol/context and source study metadata |
| questions | question_id | Requested content-rating or blind-choice questions, including unanswered ones |
| presentations | presentation_id | Recorded evaluator presentation evidence |
| ratings | rating_id | Sparse observed content grades, origin, available_at |
| blind_choices | blind_choice_id | Separate sparse list preference choices |
| model_calls | model_call_id | Actual request settings/messages, response, validation and failure metadata |
| tool_calls | tool_call_id | Retrieval request, all returned results, ranks/observations, status and errors |

Normalized references include `content_id`, nullable `content_version_id`, `original_item_id` and `material_status` (`stored`, `version_ambiguous` or `unavailable`). Slate content snapshots and recorded `content_hash` bind a specific version. Legacy evaluator public-item projections can bind an existing full corpus version only when their recorded item ID/content hash and present visible text fields match. Ratings/presentations inherit the authoritative question material; a different method material version has no question/grade link. Without a content hash, an event can use its recorded slate snapshot. Unresolvable legacy references retain original IDs and an explicit missing/ambiguous state. The common input uses a context's exact supplied source snapshot rather than reconstructing a fictitious complete history from every event in the export.

Question IDs are namespaced as `study_id:original_question_id`. Method runs/slates are `study_id:method_id`; feed slates use the recorded run ID. Context IDs hash participant/session, the supplied snapshot, its owner and any recorded execution environment. Every method in a study references the same study context; method-private inferred state stays on its run/profile, and provided profile IDs are participant/session scoped. Model calls keep recorded decision IDs; missing retry/dependency links are null with `not_recorded` provenance. Error responses and invalid outputs remain traces, not successful decisions.

For live studies, optional `contexts.environment` retains the recorded result environment, source hashes, budgets and exact `public_input` (the study's confirmed input takes precedence). `source_input_snapshot` remains the supplied snapshot; the input builder prefers recorded public evidence when available and still excludes evaluator, wrong-user and post-cutoff events. Provided-profile references use that confirmed provided profile. The formatter does not generate missing history or labels. Recorded result run identity and other result-level provenance live in `studies.source_metadata`.

Optional `runs.metadata` retains available method version/implementation, protocol and adapter limits, resource counts, source hashes and the full ordered item IDs, including ranks beyond the displayed slate. Recorded unified/failed runtime and `core_trace`/`core_action` entries are retained as `metadata.runtime_traces`; they do not create duplicate model calls. These source-native provenance objects are opaque to normalized-reference validation, while recursive credential checks still apply.

The live runner's `{request,receipt,status,started_at,completed_at}` entries become typed `model_calls` with the actual request, raw response text, provider receipt, recorded status/error and `source_call_id`. Source/Python tool steps are never counted as model calls. Source steps become `tool_calls` with `kind=source_call`, normalized result references and response metadata. The separate `kind=source_capture` row retains all provider-returned items, including items filtered out before the method receives its pool; it is capture evidence for the request, not an additional network request. Python entries use `kind=tool_call`, retain their operation/payload as request and their output as `raw_result`. Live table IDs are namespaced by method run and trace position; recorded call IDs remain in `source_call_id`.

For rating and blind-pair public projections, recorded content-hash candidates are filtered by present visible title/summary/text before resolving a version. One match binds the question, presentations and ratings to that exact version. Multiple indistinguishable versions retain `material_status=version_ambiguous` and a null version; hidden metadata never breaks the tie. Blind questions also retain the displayed A/B material. A different method version remains unlinked.

## Explicit capture contract

```js
{capture_id, run_id, source, request, results: [rawPublicItemOrNormalizedRow],
 started_at, completed_at, status, source_record_id, error?, retry_of?}
```

Every result enters `contents`. `tool_calls.results` stores rank, version reference and returned observation counters/times; request query/mode/limits remain in `tool_calls.request`. A capture pointing to a missing run creates a run with `missing_run_record`, never a claim of successful recommendation. An unavailable external capture stays an artifact reference/status managed by the archive/export integration; absence of an external artifact is not proof it was materialized here.

## Transport and disk layout

Top-level fields are `schema_version`, `manifest`, `tables`, `artifact_refs`. Disk import stores `<table>.jsonl.gz` for all 15 names, plus `manifest.json` and `artifact_refs.json`; empty tables produce valid empty gzip streams. Manifest records source protocol version, origin, eligibility, counts, filenames, incomplete legacy context, and source-record counts without a duplicate raw episode. External method artifact refs preserve availability (default `external_unverified`); offline tools do not fetch or flatten them.

Private source records/input/model traces can contain personal text. Credential-key removal is an export guard, not an anonymization guarantee. JSON Schema describes transport shapes; `tools/validate.py` additionally checks primary keys, known references, origin, sparse grades and secret-field boundaries using the standard library.
