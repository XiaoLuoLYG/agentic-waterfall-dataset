# 🌊 Waterfall Dataset

Waterfall Dataset records 50 simulated users browsing a feed. Each trajectory follows one user as they see cards, open items, and revise requests. We evaluate recommendations at 300 points along those trajectories.

[📄 Paper (arXiv)](https://arxiv.org/abs/2611.34407) · [💻 Code & demo](https://github.com/XiaoLuoLYG/Agentic-Waterfall) · [🏆 Leaderboard](https://xiaoluolyg.github.io/agentic-waterfall-dataset/) · [🗂️ Data card](dataset/docs/dataset-card.md) · [📚 Citation](#citation) · [⚖️ License](LICENSE)

![How the Waterfall Dataset freezes a browsing history and scores the cards returned at each checkpoint.](dataset/docs/images/waterfall-dataset.png)

## 📦 Get the data

- **[Waterfall Dataset v1 · 99.9 MB ZIP](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/download/waterfall-dataset-v1/waterfall-dataset-v1-full.zip)** contains the full trajectories, frozen catalogs, saved rankings, and model judgments. [Files & checksums](dataset/releases/waterfall-dataset-v1/README.md).
- **[Public benchmark downloads](dataset/docs/public-benchmarks.md)** provides the exact versions and download commands for AgentRecBench, KuaiRand-1K, KuaiRec, ClawRec-SimBench, and MIND-small. Download these separately from their source providers.

| Trajectories | Evaluation checkpoints | Content cards | Card exposures | User instructions |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 300 | 60,674 | 9,383 | 80 |

The trajectories are simulated on real content metadata. Cards contain titles, summaries, and source URLs; source videos and full article bodies are outside the dataset. **Cloning this repository gives you the tools. Download the ZIP above for the complete paper dataset.**

## Read your first trajectory

Download the ZIP, then use Python 3. No packages are needed.

```sh
unzip waterfall-dataset-v1-full.zip
cd waterfall-dataset-v1-full
```

```python
import json

with open("user-index.jsonl", encoding="utf-8") as source:
    user = json.loads(next(source))
print(user["user_id"], user["group"], user["checkpoint_count"])

with open(user["trajectory_file"], encoding="utf-8") as source:
    first_card = json.loads(next(source))
print(first_card["title"], first_card["visible_ms"])
```

Paths below are relative to the extracted ZIP:

| Path | What to use it for |
| --- | --- |
| `user-index.jsonl`, `full/users/` | Find a user and read their trajectory, events, and checkpoints. |
| `dataset/main/` | Join the normalized event, content, context, and rating tables. |
| `dataset/subsets/` | Select the general, behavior ambiguity, or interactive revision group. |
| `content-pools/` | Load the base catalog (10,446 cards) and expansion catalog (50,228 cards). |
| `evaluation/` | Inspect saved rankings, model judgments, and the evaluation protocol. |

[🗂️ Data card & limitations](dataset/docs/dataset-card.md) · [📖 Field definitions](dataset/docs/format.md) · [🛠️ Import and validation tools](dataset/README.md)

## 🏆 Add a result

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

Large data files live in [Releases](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases). The companion [code repository](https://github.com/XiaoLuoLYG/Agentic-Waterfall) contains the runnable demo, Waterfall core, and benchmark runners.

## Citation

```bibtex
@misc{luo2026agenticwaterfallintentdriveninformation,
  title={Agentic Waterfall: An Intent-Driven Information Discovery Framework
         for Reclaiming User Control in the Attention Economy},
  author={Yige Luo and Shining Zhang and Jikun Liu and Hongjiao Qiang and Ran Guan},
  year={2026},
  eprint={2611.34407},
  archivePrefix={arXiv},
  primaryClass={cs.AI},
  url={https://arxiv.org/abs/2611.34407},
}
```

When citing the dataset, include the release tag you used. [Dataset citation metadata](CITATION.cff)
