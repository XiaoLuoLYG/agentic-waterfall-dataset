# Agentic Waterfall Dataset

Versioned lightweight retrieval content, natural interaction histories, exact supplied contexts, system traces, and separate evaluator labels for continual content feeds.

This private repository contains the interchange format, tools, test fixture, and a metadata-only snapshot of a 50-person synthetic study. The online demo continues to retrieve live content. [Synthetic snapshot and experiment archive](releases/synthetic50-20261107/README.md)

- Code: MIT, explicitly chosen for the tools and formatter in this repository.
- Data: license **pending**. Public availability of a source does not grant redistribution rights. Do not publish private exports without consent, privacy review and source-license review.
- Fixture: fictional `test_only` participant; ineligible for human-effectiveness analysis.

Requires Node.js 18+ and Python 3.9+; no third-party dependencies.

```sh
npm test
python3 tools/import_demo.py fixtures/tiny/transport.json.gz /tmp/awf-tiny
python3 tools/validate.py /tmp/awf-tiny
python3 tools/evaluate.py /tmp/awf-tiny
```

Choose a context ID from `contexts.jsonl.gz`, then build its common input:

```sh
python3 tools/build_input.py /tmp/awf-tiny --context CONTEXT_ID
```

For a private export, download the current-account authorized gzip transport into a private directory outside this checkout. `download.py URL OUTPUT [--sha256 HASH]` refuses overwrites, cross-origin redirects and non-HTTPS remote URLs. Authentication can use `AWF_SESSION_COOKIE` or `AWF_BEARER_TOKEN` in the environment. Keep those values out of command history, logs and Git. Hash verification is optional when no trusted digest is available; the download receipt always reports bytes and SHA-256.

The export is a single gzip JSON object `{schema_version, manifest, tables, artifact_refs}`. For multiple sessions or participants, use `import_demo.py EXPORT_A.gz EXPORT_B.gz OUTPUT_DIRECTORY`. Identical primary-key rows are deduplicated; conflicting rows are rejected. Output must be a new directory. Offline import validates first and writes an entirely new directory containing `manifest.json`, `artifact_refs.json` and one `<table>.jsonl.gz` file for every table. Import never fetches external artifact references.

Read [the data card](docs/dataset-card.md), [format contract](docs/format.md), [collection boundary](docs/collection.md), [input and evaluation rules](docs/evaluation.md), and [privacy and release policy](docs/privacy.md). Machine-readable transport schema: [schemas/dataset.schema.json](schemas/dataset.schema.json). Initial code/fixture manifest: [releases/0.1.0.json](releases/0.1.0.json).
