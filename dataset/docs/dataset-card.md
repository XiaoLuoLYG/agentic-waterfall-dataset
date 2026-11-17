# Waterfall Dataset card

## Status and intended use

Waterfall Dataset v1 contains 50 simulated feed trajectories on real content metadata and 300 evaluation checkpoints. It supports offline evaluation of recommendation methods that use browsing history and changing requests. [Download and file list](../releases/waterfall-dataset-v1/README.md)

The release includes 327 feed visits, 9,383 card exposures, 991 opens, and 80 user instructions. Its two frozen catalogs contain 10,446 base cards and 50,228 expansion cards. Trajectories, timing, and user instructions are synthetic; the scores are model judgments.

## Groups and evaluation

| Group | Users | Checkpoints | What changes |
| --- | ---: | ---: | --- |
| General | 10 | 46 | Everyday browsing interests. |
| Behavior ambiguity | 20 | 102 | Ten pairs share an opening history, then diverge through browsing behavior. |
| Interactive revision | 20 | 152 | Each user gives four instructions, changing the task and preferred content format. |

These are evaluation groups, not train, validation, and test splits. `dataset/subsets/` indexes the same records as `dataset/main/`.

The main evaluation gives all five methods the same 20-card shortlist from the base catalog. Waterfall and ClawRec may also search the expansion catalog. Each method returns five cards. The leaderboard keeps this **shared-shortlist** protocol separate from the **independent-recall** experiment; compare methods within a track.

Use only the history and public context available at each checkpoint as recommender input. Hidden scenario goals, evaluation labels, and judgments are for scoring. The release's `evaluation/protocol.json` records the scoring rules; `comparison-cutoffs.json` records the checkpoints.

## Files and annotations

Start with `user-index.jsonl`: each row links a user's trajectory, events, and persona. `dataset/main/` contains the normalized tables, `content-pools/` contains both full catalogs, and `evaluation/` holds saved results and judgments. File paths and counts are recorded in the root `manifest.json`.

The main evaluation has 1,473 submitted Top 5 lists across 1,500 planned method slots. It contains 4,944 single-card rating questions and 1,500 blind preference questions; 135 annotations are unavailable. Missing output or judgment is recorded explicitly.

Content grades use integer 0–3 only for `grade_status: rated`. Zero is an observed grade. `unable`/unknown retains `null`; an unanswered question has no rating row. Blind list preference is a separate question/choice table, not a content grade. Evaluation labels remain evaluator-only.

## Export format

The repository also provides the [`awf-dataset/1.0` format](format.md) and a small test fixture. The following details describe that format, which can hold both synthetic and human session exports.

The unit is a private participant session with referenced past contexts, content versions, recommendation runs/slates, sparse observed events, evaluator questions/answers, and model/tool traces. Adjacent sessions may be only partially represented. `history_completeness: referenced_snapshots_only` explicitly limits reconstruction claims.

## Content scope

Corpus rows contain public source IDs/canonical URLs, titles, returned summaries/text, and a small metadata allowlist. Every returned captured result can enter the corpus, including unshown and unrated results. No original video/audio, large PDF, webpage bundle, model weight or binary is included. Missing text means it was not returned/stored; it is not proof that the source has no text. Source metadata is not a new source-license grant.

A source item can have multiple stored material versions. Tool calls retain observation time and retrieval rank; those do not produce a new content version. Stored text/summary are capped independently at 100,000 JavaScript UTF-16 code units with original length and truncation status. This is a storage limit, not a word or token count.

## Participant and label origin

`data_origin` is `human`, `synthetic`, `test_only` or `unknown`, never silently upgraded to human. Participant IDs are private-export identifiers, not a guarantee of anonymization. All formatter outputs start ineligible for analysis; human exports still need protocol/consent review. The tiny fixture is `test_only` and remains ineligible.

## Known limitations

The released trajectories and model judgments have not been calibrated against human behavior or ratings. Results describe the released scenarios and evaluation setup; they do not establish demographic representativeness or live user satisfaction. An open event does not prove that a user read an article or watched a video. Source pages can change or disappear after collection.

Legacy episodes may lack full provider captures, exact content versions, model timing/usage, explicit retry edges, dependency edges, or external full artifacts. Missing fields remain null/status flags, and original available source-record counts and explicit omitted-field provenance are retained. A legacy ambiguous content reference does not choose the latest version. Snapshot provenance cannot establish that all lifetime history was supplied or that a displayed card was fully read. External media consumption is not inferred from open/return events.

The small test fixture checks the export format; it is not an effectiveness evaluation. Large frozen data and experiment outputs are available as release attachments rather than Git files.
