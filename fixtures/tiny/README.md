# Fictional test fixture

All records are authored examples, not real participant behavior or online retrieval. `metadata.record_kind: test_only` and `eligible_for_analysis: false` stay explicit. The fixture includes an observed grade 0, an unable/null answer, an unanswered question, a future event, an evaluator event, and a failed HTTP-429 model call. It contains no real provider response or credentials.

`episode.json` is an old-demo-compatible collection episode. `transport.json.gz` is its deterministic formatter output. Tests generate fresh transports from the episode and exercise download/import/validate/input/evaluation in temporary directories. To regenerate the committed transport:

```sh
node --input-type=module -e "import {readFileSync,writeFileSync} from 'node:fs';import {gzipSync} from 'node:zlib';import {buildDataset} from './src/format.mjs';writeFileSync('fixtures/tiny/transport.json.gz',gzipSync(JSON.stringify(buildDataset(JSON.parse(readFileSync('fixtures/tiny/episode.json'))))));"
```
