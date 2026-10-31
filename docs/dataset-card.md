# Data card

## Status and intended use

The repository provides the `awf-dataset/1.0` interchange contract, offline tools, and a tiny fictional fixture. There is no public human data release, established benchmark result, formal recruitment, training run, or effectiveness claim. Continuous online collection and release review are separate gates. The collector's original protocol version remains in each manifest/study.

The unit is a private participant session with referenced past contexts, content versions, recommendation runs/slates, sparse observed events, evaluator questions/answers, and model/tool traces. Adjacent sessions may be only partially represented. `history_completeness: referenced_snapshots_only` explicitly limits reconstruction claims.

## Content scope

Corpus rows contain public source IDs/canonical URLs, titles, returned summaries/text, and a small metadata allowlist. Every returned captured result can enter the corpus, including unshown and unrated results. No original video/audio, large PDF, webpage bundle, model weight or binary is included. Missing text means it was not returned/stored; it is not proof that the source has no text. Source metadata is not a new source-license grant.

A source item can have multiple stored material versions. Tool calls retain observation time and retrieval rank; those do not produce a new content version. Stored text/summary are capped independently at 100,000 JavaScript UTF-16 code units with original length and truncation status. This is a storage limit, not a word or token count.

## Participant and label origin

`data_origin` is `human`, `synthetic`, `test_only` or `unknown`, never silently upgraded to human. Participant IDs are private-export identifiers, not a guarantee of anonymization. All formatter outputs start ineligible for analysis; human exports still need protocol/consent review. The tiny fixture is `test_only` and remains ineligible.

Content grades use integer 0–3 only for `grade_status: rated`. Zero is an observed grade. `unable`/unknown retains `null`; an unanswered question has no rating row. Blind list preference is a separate question/choice table, not a content grade. Evaluation labels remain evaluator-only.

## Known limitations

Legacy episodes may lack full provider captures, exact content versions, model timing/usage, explicit retry edges, dependency edges, or external full artifacts. Missing fields remain null/status flags, and original available source-record counts and explicit omitted-field provenance are retained. A legacy ambiguous content reference does not choose the latest version. Snapshot provenance cannot establish that all lifetime history was supplied or that a displayed card was fully read. External media consumption is not inferred from open/return events.

No demographic representativeness, cross-source availability, causal attribution or effectiveness is established by this fixture or the transport. Online source availability changes over time. Frozen historical experiment outputs are outside this repository and remain unchanged.
