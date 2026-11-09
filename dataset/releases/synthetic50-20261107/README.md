# 50 人合成评测快照

2026-11-07 的私有研究快照。50 人均为模拟用户。共 837 轮浏览、300 个评测截点和 1,500 次方法运行。保留 5,852 条逐卡评分和 1,300 组有效五方盲选，另外 200 组缺榜仍有题目状态。当前访问范围沿用本私有仓库，数据许可待定。

| 文件 | 内容 |
| --- | --- |
| [RESULTS.md](RESULTS.md) | 四个旧基准的正式总表、新 50 人总表、一般组与两个子集 |
| [metrics.json](metrics.json) | 新评测的机器可读指标，含分母、缺榜、合规和盲选 |
| [main/](main/) | AWF 格式的元数据快照。按记录类型分成 15 张表，字段见主集清单 |
| [cohort.jsonl.gz](cohort.jsonl.gz) | 每行一位模拟用户，含编号、会话、公开画像、模拟时用的隐藏画像、阶段目标和浏览轮数 |
| [subsets/](subsets/) | 行为歧义和交互修改各 20 人，引用主集中已有的参与者、会话和截点 |
| [evaluation-candidates.jsonl.gz](evaluation-candidates.jsonl.gz) | 离线方法共用的 1,000 张冻结候选卡引用，原始候选池和快照各自有 SHA-256 |
| [rating-links.json](rating-links.json) | 原评测的 3 条卡位评分映射，供复算使用。主集保留标准导出的版本不匹配标记 |
| [SHA256SUMS](SHA256SUMS) | 本目录的文件校验值 |

内容表保留原档的内容 ID、版本 ID、平台、公开链接和媒体类型等元数据。标题、摘要、平台正文、原始模型请求与回复、模型自由文本状态、平台原始返回和真人采集记录保存在各自的私有原档。快照中的版本 ID 和输入哈希指向原始记录。盲选题面用材料指纹表示，评分、选择、名次和方法映射保持原值。

从仓库根目录运行：

    python3 dataset/tools/validate.py dataset/releases/synthetic50-20261107/main
    python3 dataset/experiments/synthetic50/verify.py
    (cd dataset/releases/synthetic50-20261107 && shasum -a 256 -c SHA256SUMS)

复算脚本校验参与者、子集、候选池和文件引用，并从题目、标签和榜单复算五家方法的兴趣分、DCG@5 和盲选得票。精确重放原推荐请求需要本地私有原档和当时的环境。 [实验代码与依赖](../../experiments/synthetic50/README.md)
