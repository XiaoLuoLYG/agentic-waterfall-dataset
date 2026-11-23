# Public benchmarks

These are the five public benchmarks used in the Agentic Waterfall report. Keep the source downloads outside the dataset repository and follow the original providers' terms. Download `public-benchmark-replay-v1.zip` from the [Waterfall Dataset release](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/tag/waterfall-dataset-v1). It recomputes reported scores for the methods listed in its manifest without calling models. A fresh inference run additionally needs the matching model, retrieval environment, and method configuration.

## Download files

The public source files are available from the links below. The [Waterfall release](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/tag/waterfall-dataset-v1) contains the saved benchmark predictions and score inputs. Sizes are compressed download sizes unless the file is a CSV.

| Dataset | Files used in this work |
| --- | --- |
| AgentRecBench | [Pinned dataset](https://huggingface.co/datasets/SGJQovo/AgentRecBench/tree/288f7f09ca0387e5169a61b219047aea397e4b06). Fetch short-term tasks and labels, plus `output_data_all/item.json` (1.36 GB), `output_data_all/user.json` (1.43 GB), and `output_data_short/review.json` (21.9 MB) for inference. Commands below. |
| KuaiRand-1K | [Logs and features](https://zenodo.org/records/10439422/files/KuaiRand-1K.tar.gz) (1.14 GB), [video captions](https://zenodo.org/records/18159199/files/kuairand_video_captions.csv) (3.22 GB) |
| KuaiRec 2.0 | [KuaiRec.zip](https://zenodo.org/records/18164998/files/KuaiRec.zip) (432 MB) |
| ClawRec-SimBench | [Pinned source archive](https://codeload.github.com/RUCAIBox/ClawRec/tar.gz/6eeb309c47430f91280e9845a98fb56a68dc0d90), containing `clawrec-simbench/cases/` |
| MIND-small | [Development](https://huggingface.co/datasets/Recommenders/MIND/resolve/2115068f457b577f93a268fffe22373e45727d89/MINDsmall_dev.zip) (30.9 MB), [training](https://huggingface.co/datasets/Recommenders/MIND/resolve/2115068f457b577f93a268fffe22373e45727d89/MINDsmall_train.zip) (53 MB) |

These downloads come from the providers or the pinned MIND mirror. They are not bundled inside the Waterfall Dataset ZIP. The paper's exact versions and evaluation subsets are listed below.

## Evaluation splits

| Benchmark | Source and version | Evaluation split |
| --- | --- | --- |
| AgentRecBench | [Official release at revision `288f7f0`](https://huggingface.co/datasets/SGJQovo/AgentRecBench/tree/288f7f09ca0387e5169a61b219047aea397e4b06/task/short_term) | `task/short_term`, tasks 0–99 each for Amazon, Goodreads, and Yelp. There are 20 fixed candidates per task. Report all 300 tasks and the 220 tasks with the history required by i²Agent. |
| KuaiRand | [KuaiRand-1K](https://zenodo.org/records/10439422) and [official captions](https://zenodo.org/records/18159199) | 617 eligible test tasks during April 29–May 8, 2022, across the standard and random exposure logs. Each task has 101 candidates. Matched methods receive up to 512 events; i²Agent uses its native positive history window. |
| KuaiRec | [Official KuaiRec 2.0](https://kuairec.com/#download-the-data), [Zenodo archive](https://zenodo.org/records/18164998) | Use the big matrix for history and the small matrix for evaluation. Permute the 1,411 sorted small-matrix user IDs with NumPy `RandomState(42)`; the first 282 are development, the last 1,129 test. The shared catalog has 3,327 items; observed items with `watch_ratio > 2` are relevant. |
| ClawRec-SimBench | [Official repository](https://github.com/RUCAIBox/ClawRec), [pinned archive at `6eeb309`](https://codeload.github.com/RUCAIBox/ClawRec/tar.gz/6eeb309c47430f91280e9845a98fb56a68dc0d90) | The 210 events from 42 trajectories under `clawrec-simbench/cases`. The replay uses the archived five-method rankings and one set of judge scores per event. |
| MIND | [Microsoft official download](https://msnews.github.io/#download), [pinned Recommenders mirror](https://huggingface.co/datasets/Recommenders/MIND/tree/2115068f457b577f93a268fffe22373e45727d89) | MIND-small development. RecAgent uses the 69,861 impressions with at least two historical clicks. It returned 68,639 valid rankings; the remaining 1,222 stay in the denominator as all-ranks-tied predictions. Other MIND results are from separate runs. |

Use the companion [research code](https://github.com/XiaoLuoLYG/Agentic-Waterfall/tree/research) for the benchmark adapters and scorers. In the shell examples, set `code` to the absolute path to that checkout and `cache` to a scratch directory. The replay README gives the commands for scoring the frozen predictions. Keep labels and judge scores separate from model input.

## AgentRecBench

Install the Hugging Face CLI and fetch the short-term task files. The `groundtruth` folders are for evaluation.

```sh
hf download SGJQovo/AgentRecBench --repo-type dataset \
  --revision 288f7f09ca0387e5169a61b219047aea397e4b06 \
  --include 'task/short_term/**' --local-dir "$cache/agentrecbench"

arb_source="$code/experiments/agentic-waterfall/agentrecbench/upstream"
mkdir -p "$arb_source"
curl -fL https://codeload.github.com/tsinghua-fib-lab/AgentSocietyChallenge/tar.gz/3f575247a5778d34c3ae6b0297139c7d4a3597fd \
  | tar -xz -C "$arb_source"
```

Each of `task/short_term/{amazon,goodreads,yelp}` should contain `tasks/task_0.json` through `task_99.json` and corresponding `groundtruth/groundtruth_*.json` files. For inference, also fetch the same revision's `output_data_all/item.json`, `output_data_all/user.json`, and `output_data_short/review.json`, and partition them by domain. Follow the [tool server and adapter instructions](https://github.com/XiaoLuoLYG/Agentic-Waterfall/tree/research/experiments/agentic-waterfall).

Fetch the corpus files into the same directory:

```sh
hf download SGJQovo/AgentRecBench --repo-type dataset \
  --revision 288f7f09ca0387e5169a61b219047aea397e4b06 \
  --include 'output_data_all/item.json' 'output_data_all/user.json' 'output_data_short/review.json' \
  --local-dir "$cache/agentrecbench"
```

The official AgentRecBench repository on Hugging Face lists MIT. The source corpora have separate terms: the [Yelp dataset agreement](https://s3-media0.fl.yelpcdn.com/assets/srv0/engineering_pages/f64cb2d3efcc/assets/vendor/Dataset_User_Agreement.pdf) restricts sharing and sets conditions on public results; the [Goodreads release](https://sites.google.com/eng.ucsd.edu/ucsdbookgraph/%20home) asks users not to redistribute it; the [Amazon Reviews 2023 maintainers](https://huggingface.co/datasets/McAuley-Lab/Amazon-Reviews-2023/discussions/1) do not grant a license for the underlying content. Fetch the task files and corpora from the providers.

## KuaiRand-1K

Get the [1K archive](https://zenodo.org/records/10439422/files/KuaiRand-1K.tar.gz), SHA-256 `dfaafbb5fd16e9e6d2f9a6adaa4ea25df20a14bc26a90961c136e26c00a7bb2c`. Extract it and use its `KuaiRand-1K/data/` directory for replay. The relevant files are `user_features_1k.csv`, `video_features_basic_1k.csv`, `log_standard_4_08_to_4_21_1k.csv`, `log_standard_4_22_to_5_08_1k.csv`, and `log_random_4_22_to_5_08_1k.csv`. The evaluation seed is 42; the training catalog uses only events with completion time earlier than `1650553294007` milliseconds. Unavailable or invalid full rankings score zero.

To regenerate model input, put those five CSVs in `$cache/kuairand/raw`. Download [kuairand_video_captions.csv](https://zenodo.org/records/18159199/files/kuairand_video_captions.csv) (~3.2 GB, SHA-256 `0032ff2062abbcf10d6a1dfb033a65b0cdcd448f4fc56e19c75f8ff4494e4455`) before running the [full history preparation and 512-event window projection](https://github.com/XiaoLuoLYG/Agentic-Waterfall/blob/research/docs/research/agentic-waterfall/results-20261111/REPRODUCE.md#kuairand). The replay uses the frozen case index and needs only the two original April 22–May 8 logs to recover the held-out labels. The downloaded 1K archive contains a CC BY-SA 4.0 notice; Zenodo's metadata lists CC BY 4.0 for both records.

If you are regenerating inputs for inference, use fresh output directories and the verified caption archive:

```sh
kr="$cache/kuairand"
exp="$code/experiments/agentic-waterfall"
# With the five raw CSVs under "$kr/raw":
python3 "$exp/kuairand/scripts/prepare.py" --raw "$kr/raw" \
  --output "$kr/prepared-v2" --eval-users 32 --seed 42 --training-cutoff-ms 1650553294007

mv "$kr/kuairand_video_captions.csv" "$kr/kuairand-video-captions-20261029.csv"
python3 - "$kr" <<'PY_SETUP'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
captions = root / "kuairand-video-captions-20261029.csv"
md5, sha256 = hashlib.md5(), hashlib.sha256()
with captions.open("rb") as source:
    for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
        md5.update(block)
        sha256.update(block)
assert captions.stat().st_size == 3222932768
assert md5.hexdigest() == "9fd4e7587ffd0c8dc289d013858fb229"
assert sha256.hexdigest() == "0032ff2062abbcf10d6a1dfb033a65b0cdcd448f4fc56e19c75f8ff4494e4455"
(root / "captions-full-20261029-manifest.json").write_text(json.dumps({
    "bytes": captions.stat().st_size, "sha256": sha256.hexdigest(), "official_md5_verified": True
}))
PY_SETUP
python3 "$exp/unified/prepare_kuairand_full.py" --data "$kr" --output "$kr/full"
python3 "$exp/unified/prepare_kuairand_window.py" --full-source "$kr/full" --output "$kr/window512"
```

The 32-user initial preparation builds the training catalog; the full-history command reads the raw logs for all 1,000 users. The final window projection should contain 617 cases.

## KuaiRec 2.0

Download [KuaiRec.zip](https://zenodo.org/records/18164998/files/KuaiRec.zip), SHA-256 `c23f211cf109c7a060a25a4afe9e8c681b1ccbbc816cca921d87ad37dd11c70c`. Put `big_matrix.csv`, `small_matrix.csv`, and `kuairec_caption_category.csv` from the archive into `$code/experiments/agentic-waterfall/kuairec/data/raw/`. In a fresh checkout, install NumPy and pandas in your Python environment and run:

```sh
mkdir -p "$code/experiments/agentic-waterfall/kuairec/results"
python "$code/experiments/agentic-waterfall/kuairec/scripts/prepare.py"
```

The replay uses `data/processed/eligibility.npz` and `data/processed/evaluator_only/labels.npz`. The eligibility mask defines the ideal ranking over the full observed catalog. All 1,129 test users stay in the precision denominator; empty or invalid rankings score zero. The source archive contains CC BY-SA 4.0, while the Zenodo metadata lists CC BY 4.0.

## ClawRec-SimBench

Get the [pinned archive](https://codeload.github.com/RUCAIBox/ClawRec/tar.gz/6eeb309c47430f91280e9845a98fb56a68dc0d90), SHA-256 `3c94429840b033f072b2bfff71fee207a177943cda9ffcce3ff838c14593cb1f`. The official repository has an [MIT license](https://github.com/RUCAIBox/ClawRec/blob/6eeb309c47430f91280e9845a98fb56a68dc0d90/LICENSE). For score replay, the study archive already includes the anonymous event-local item indices, rankings, and judge scores. It uses all 210 events, including empty rankings. For fresh inference from the public event histories, start at the [benchmarks guide in the research code](https://github.com/XiaoLuoLYG/Agentic-Waterfall/tree/research/experiments/agentic-waterfall).

## MIND-small

Accept the [Microsoft Research License Terms](https://github.com/msnews/MIND/blob/master/MSR%20License_Data.pdf) on the [official site](https://msnews.github.io/#download). Those terms limit use to research and prohibit redistribution of the dataset. Download and extract the MIND-small validation set (`MINDsmall_dev.zip`, SHA-256 `d6ce515dcaa6b6d47ddf0a326eebc8a31b84735ae410285c9882ca2a06eec669`). If needed, use the [Recommenders copy at revision `2115068`](https://huggingface.co/datasets/Recommenders/MIND/tree/2115068f457b577f93a268fffe22373e45727d89) under the same terms. The RecAgent replay rebuilds click labels from the locally downloaded `behaviors.tsv` and uses the [Microsoft evaluator fixed at `47fb985`](https://github.com/msnews/MIND/blob/47fb9852c97814d80ccf9c658d6b81f5c930b510/evaluate.py). The MIND TF-IDF ranking script also needs `MINDsmall_train.zip` for its news catalog.

Download the pinned evaluation script into the location expected by the replay:

```sh
mind_scorer="$code/experiments/agentic-waterfall/mind/upstream/MIND"
mkdir -p "$mind_scorer"
curl -fL https://raw.githubusercontent.com/msnews/MIND/47fb9852c97814d80ccf9c658d6b81f5c930b510/evaluate.py \
  -o "$mind_scorer/evaluate.py"
```

The MIND entries for Waterfall, the generic agent, ClawRec, i²Agent, MARS, TF-IDF, and NRMS are reported in the paper. The replay archive contains scoring inputs for RecAgent.
