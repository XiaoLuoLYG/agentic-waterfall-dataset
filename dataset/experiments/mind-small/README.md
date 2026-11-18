# MIND 预测结果

这里只保存排序结果。每行一条曝光，字段是 `source_id`、`decision_id`、`status`、`ordered_item_ids`，失败时另有 `error`。新闻正文、点击历史、提示词和模型调用记录没有复制进来。原始目录仍留在原来的位置。来源、条数和校验值见 [manifest.json](manifest.json)。

`mind-000000` 与 `mind-test-1` 都对应 `mind:test:1`。

## MIND-small 开发集

73,152 条曝光。文件在 [predictions/mind-small-dev](predictions/mind-small-dev)。

| 文件 | 提交 | 失败 | 其他 |
| --- | ---: | ---: | --- |
| waterfall.jsonl.gz | 73,146 | 6 | |
| generic-agent.jsonl.gz | 73,125 | 27 | |
| clawrec.jsonl.gz | 73,131 | 21 | |
| i2agent.jsonl.gz | 69,413 | 448 | 3,291 条历史点击不足，记为 `not_applicable` |
| mars.jsonl.gz | 73,126 | 25 | 缺 `mind-019404`（`mind:test:19405`），原目录没有 `result.json` |
| tf-idf.jsonl.gz | 73,152 | 0 | |

原始位置：

| 方法 | 原目录 |
| --- | --- |
| Waterfall | `1106/mind-waterfall-small-16`、`mind-waterfall-small-10`、`mind-waterfall-small-10b` 的三次运行结果，合成这一份 |
| 通用 Agent | `1106/mind-generic-small/runs/mind-small-4keys` |
| ClawRec | `clawrec/experiments/agentic-waterfall/mind/mind-clawrec-results/2026-11-03T15-31-30-211` |
| i²Agent | `i2agent/experiments/agentic-waterfall/mind/i2agent-mind/2026-11-03_22-59-32` |
| MARS | `1106/mind-mars-small/runs/mind-small-4keys` |
| TF-IDF | `nrms/predictions/tfidf-small-dev.jsonl` |

## 其他切分和试跑

这些不能和上表混用。文件在 [predictions/other](predictions/other)。

| 文件 | 内容 |
| --- | --- |
| waterfall-mind-large-dev-1000.jsonl.gz | MIND-large 开发集前 1,000 条，全部提交 |
| i2agent-2026-11-03_20-29-31.jsonl.gz | 同一前缀 1,000 条：962 提交，38 条历史点击不足 |
| i2agent-2026-11-03_19-58-38.jsonl.gz | 20 条试跑：18 提交，2 失败 |
| i2agent-2026-11-03_20-18-46.jsonl.gz | 20 条试跑，全部提交 |
| i2agent-2026-11-03_19-44-00.jsonl.gz | 20 条试跑，全部失败 |
| clawrec-2026-11-03T15-18-40-599.jsonl.gz | 50 条试跑，全部提交 |
| clawrec-2026-11-03T12-03-12-920.jsonl.gz | 90 条有结果，另有 13 个目录没有 `result.json` |
| clawrec-2026-11-05T10-53-00-105.jsonl.gz | 30 条有结果，另有 14 个目录没有 `result.json` |

## 没有预测文件的方法

RecAgent 和 NRMS 在本机没有 MIND 排序文件。NRMS 只有 `1118/nrms/checkpoints` 里的检查点。这两行的分数只写在 [docs/results.json](../../../docs/results.json)。
