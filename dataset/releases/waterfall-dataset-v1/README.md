# Waterfall Dataset release

Download the files from [Waterfall Dataset v1](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/tag/waterfall-dataset-v1).

| File | Contents |
| --- | --- |
| [waterfall-dataset-v1-full.zip](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/download/waterfall-dataset-v1/waterfall-dataset-v1-full.zip) | The frozen trajectories, checkpoints, catalogs, submissions, and evaluation records for the paper's shared-shortlist run |
| [waterfall-dataset-v1-score-replay.zip](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/download/waterfall-dataset-v1/waterfall-dataset-v1-score-replay.zip) | Ranking and judgment projections for recalculating the shared-shortlist and independent-recall scores |
| [public-benchmark-replay-v1.zip](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/download/waterfall-dataset-v1/public-benchmark-replay-v1.zip) | Score inputs for 26 method and benchmark pairs |
| [tfidf-benchmarks-20261110-v1.zip](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/download/waterfall-dataset-v1/tfidf-benchmarks-20261110-v1.zip) | Frozen TF-IDF inputs and SimBench judgments |
| [SHA256SUMS](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/download/waterfall-dataset-v1/SHA256SUMS) | Archive checksums |

[Repository releases](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases)

Put the downloads and `SHA256SUMS` in the same directory. This checks the score replay file before you extract it.

```sh
grep "  waterfall-dataset-v1-score-replay.zip$" SHA256SUMS | shasum -a 256 -c -
unzip waterfall-dataset-v1-score-replay.zip
cd waterfall-dataset-v1
python3 replay.py
python3 replay.py --protocol independent-recall
```

The full archive keeps the historical record IDs. Six share-link parameter values were removed from stored content. The saved rankings, checkpoints, and accepted judgments retain their original bytes. `content-pools/expansion.manifest.json` maps the three affected content version IDs to their published hashes. To run new inference from the full package, follow the [code setup guide](https://github.com/XiaoLuoLYG/waterfall-anything/blob/research/docs/reproduce.md#run-a-new-waterfall-dataset-comparison).

The paper's shared-shortlist run starts each method with 20 candidates at each of 300 checkpoints. Waterfall and ClawRec may search the expansion catalog. In the independent-recall run, those two methods start with an empty pool, BM25+BGE searches the full eligible base catalog, and RecAgent and i²Agent rank the prepared shortlist.

The leaderboard has the public benchmark and ablation tables. Use the benchmark guide and the README in `public-benchmark-replay-v1.zip` to recalculate archived scores. The five ablation variants and the remaining MIND scores come from the paper. [Leaderboard](https://xiaoluolyg.github.io/agentic-waterfall-dataset/) · [Benchmark guide](../../docs/public-benchmarks.md)
