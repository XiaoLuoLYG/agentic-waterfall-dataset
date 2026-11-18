# 50 人合成实验代码

50 人数据快照可以用 Python 3.9+ 和仓库自带工具离线校验及复算。 [数据和结果表](../../releases/synthetic50-20261107/README.md) · [复算入口](verify.py)

从本地已验收的私有运行目录重建这次元数据快照时，使用投影脚本并指定一个新输出目录。 [投影入口](project.py)

## 源码归档

源码按原 Waterfall 工作区的相对目录保存。 [源码目录](source/) · [源码与运行哈希](provenance.json)

| 原相对路径 | 用途 |
| --- | --- |
| source/experiments/agentic-waterfall/synthetic-collection/run.mjs | 轨迹生成、小样和批量验收 |
| source/experiments/agentic-waterfall/synthetic-collection/evaluate-cohort.mjs | 接续已验收 10 人，评估新 40 人，导出全量 |
| source/experiments/agentic-waterfall/synthetic-collection/comparison.mjs | 同一轨迹下的五方法对照、逐卡评分、五方盲选 |
| source/experiments/agentic-waterfall/synthetic-collection/pack.mjs | 主集和两个子集索引的导出 |
| source/experiments/agentic-waterfall/synthetic-collection/monitor.py | 三个匿名 API 路由和评测进度的 Terminal 面板 |
| source/output/agentic-waterfall/synthetic-20261107-full50/ | 50 人分组设计、指令审阅和参考内容补采入口 |
| source/demos/agentic-feed-site/lib/waterfall/ | 本轮固定的 Waterfall 核心与版本 |
| source/output/agentic-waterfall/ 中的两个运行源码目录 | 本轮依赖的第一方历史工具和归档适配层 |

在线实验入口保留原工作区相对路径和归档依赖。原批次使用 Node.js 22、两套本地 Python 环境、BGE 权重、基线作者依赖、私有网关配置和冻结输入。这些需要从原工作区接入。仓库中的数据验证、逐卡复算和盲选计票可以单独运行。

四个公开基准的实验入口位于 Waterfall 研究仓库。 [旧基准源码](https://github.com/XiaoLuoLYG/Agentic-Waterfall/tree/research/experiments/agentic-waterfall)
