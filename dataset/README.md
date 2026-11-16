# Agentic Waterfall Dataset

The formatter, schema, and Python tools exchange feed records between the browser demo and the evaluation scripts. The tiny fixture gives you one fictional export to try. See the [main README](../README.md) for the Waterfall Dataset release and benchmark downloads.

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
