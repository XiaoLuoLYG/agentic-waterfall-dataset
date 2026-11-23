# MIND-small 开发集预测

六个方法的全量排序在 [Waterfall Dataset v1](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/tag/waterfall-dataset-v1) 的 `mind-small-dev-predictions-v1.zip`。这份压缩包是按原始运行结果重新整理的。条目数和提交、失败统计与 `manifest.json` 一致；压缩后的字节和 SHA-256 与更早那份已经不存在的发布不同。

| 文件 | 内容 |
| --- | --- |
| [mind-small-dev-predictions-v1.zip](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/download/waterfall-dataset-v1/mind-small-dev-predictions-v1.zip) | Waterfall、通用 Agent、ClawRec、i²Agent、MARS、TF-IDF 的 MIND-small 开发集排序 |
| [SHA256SUMS](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/download/waterfall-dataset-v1/SHA256SUMS) | 同一发布里各压缩包的校验值 |

压缩包 36,724,543 字节，SHA-256 为 `513fff6f01cf3d0de5d6f9f90b8b9713aca41ac4895d982d226f18275cf394e6`。

```sh
curl -fL -O https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/download/waterfall-dataset-v1/mind-small-dev-predictions-v1.zip
curl -fL -O https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/releases/download/waterfall-dataset-v1/SHA256SUMS
grep "  mind-small-dev-predictions-v1.zip$" SHA256SUMS | shasum -a 256 -c -
unzip mind-small-dev-predictions-v1.zip
```

解压后是 `mind-small-dev-predictions-v1/`。每行一条曝光，字段是 `source_id`、`decision_id`、`status`、`ordered_item_ids`，失败时另有 `error`。新闻正文、点击历史、提示词和模型调用记录没有放进压缩包。各文件的条数、来源和 SHA-256 在压缩包里的 `manifest.json`。仓库里不保存这份压缩包。

73,152 条曝光。文件在压缩包的 `predictions/mind-small-dev/`。

| 文件 | 提交 | 失败 | 其他 |
| --- | ---: | ---: | --- |
| waterfall.jsonl.gz | 73,146 | 6 | 由三次 small 运行合成 |
| generic-agent.jsonl.gz | 73,125 | 27 | |
| clawrec.jsonl.gz | 73,131 | 21 | |
| i2agent.jsonl.gz | 69,413 | 448 | 3,291 条历史点击不足，记为 `not_applicable` |
| mars.jsonl.gz | 73,126 | 25 | 缺 `mind-019404`（`mind:test:19405`），原目录没有 `result.json` |
| tf-idf.jsonl.gz | 73,152 | 0 | |

`mind-000000` 与 `mind-test-1` 都对应 `mind:test:1`。

原始位置：

| 方法 | 原目录 |
| --- | --- |
| Waterfall | `1106/mind-waterfall-small-16`、`mind-waterfall-small-10`、`mind-waterfall-small-10b` 的三次运行结果，合成这一份 |
| 通用 Agent | `1106/mind-generic-small/runs/mind-small-4keys` |
| ClawRec | `clawrec/experiments/agentic-waterfall/mind/mind-clawrec-results/2026-11-03T15-31-30-211` |
| i²Agent | `i2agent/experiments/agentic-waterfall/mind/i2agent-mind/2026-11-03_22-59-32` |
| MARS | `1106/mind-mars-small/runs/mind-small-4keys` |
| TF-IDF | `nrms/predictions/tfidf-small-dev.jsonl` |

RecAgent 和 NRMS 没有预测文件。这两行的分数只写在 [docs/results.json](../../../docs/results.json)。
