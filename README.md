# Waterfall Dataset

Waterfall Dataset records 50 simulated users browsing a feed. Each trajectory follows one user as they see cards, open items, and revise requests. We evaluate recommendations at 300 points along those trajectories.

[Waterfall code and demo](https://github.com/XiaoLuoLYG/waterfall-anything) · [Leaderboard](https://xiaoluolyg.github.io/agentic-waterfall-dataset/) · [Public benchmarks](dataset/docs/public-benchmarks.md)

![How the Waterfall Dataset freezes a browsing history and scores the cards returned at each checkpoint.](dataset/docs/images/waterfall-dataset.png)

## Get the data

- The paper release is being prepared. `waterfall-dataset-v1` is not published yet. See [the file list](dataset/releases/waterfall-dataset-v1/README.md) for the full dataset and replay packages.
- [Public benchmark downloads](dataset/docs/public-benchmarks.md) links to the original sources for AgentRecBench, KuaiRand-1K, KuaiRec, ClawRec-SimBench, and MIND-small.
- [Results and replay](dataset/releases/waterfall-dataset-v1/README.md) shows how to recalculate scores from the saved outputs.

The full Waterfall Dataset package contains the 50 trajectories, 300 checkpoints, both frozen catalogs (60,674 cards), saved rankings, and model judgments. Cards include archived titles, summaries, and source URLs. Source videos and full article bodies are outside the dataset. Cloning this repository downloads the tools and an older snapshot; get the paper dataset from its release package once published.

### Recalculate the Waterfall Dataset scores

Download `waterfall-dataset-v1-score-replay.zip` from the release and extract it.

```sh
unzip waterfall-dataset-v1-score-replay.zip
cd waterfall-dataset-v1
python3 replay.py
python3 replay.py --protocol independent-recall
```

The first command scores the shared-shortlist run in the paper. The second scores the independent-recall run. Both use saved rankings and model judgments.

[Data card](dataset/docs/dataset-card.md) · [File format](dataset/docs/format.md) · [Tools](dataset/README.md) · [Cite this work](CITATION.cff)

## Add a result

The leaderboard has separate tracks for the two Waterfall Dataset protocols and the five public benchmarks. Search methods, sort the table, or export the current view as CSV. Ablations have their own view.

[Submit a result](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/issues/new?template=leaderboard.yml) with your code revision, configuration, per-case outputs, and scoring command. Maintainers review the evidence before merging an entry. The [contribution guide](CONTRIBUTING.md) explains the format and the local check.

## Repository layout

```text
docs/                 Leaderboard page and results.json
dataset/
  src/                Shared export format
  schemas/            Data schema
  tools/              Import, validation, input building, scoring
  releases/           Version notes and the older frozen snapshot
  experiments/        Frozen collection code and provenance
  fixtures/, tests/   Small examples and checks
.github/              Result submission form and automatic checks
```

Large dataset and replay files are release attachments. The companion [code repository](https://github.com/XiaoLuoLYG/waterfall-anything) contains the runnable demo, Waterfall core, and benchmark runners.
