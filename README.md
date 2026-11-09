# Agentic Waterfall Dataset

内容、自然交互轨迹、系统运行记录和独立评价标签的数据格式与工具。

**本私有仓库收录代码、格式说明、虚构测试样例和 50 人合成评测快照。** 线上 demo 的真人采集记录保存在私有存储。代码采用 MIT，数据许可待定。 [合成数据、结果表与实验代码](dataset/releases/synthetic50-20261107/README.md)

所有工程文件统一放在一个主目录 [`dataset/`](dataset/)，顶层仅保留项目说明、许可证和引用信息。

```text
agentic-waterfall-dataset/
├── README.md
├── LICENSE
├── CITATION.cff
└── dataset/
    ├── README.md     # 完整使用说明
    ├── docs/         # 数据说明、采集和评价约定
    ├── schemas/      # 数据格式
    ├── src/          # demo 共用的导出格式实现
    ├── tools/        # 下载、导入、校验、构造输入、计算指标
    ├── fixtures/     # 虚构样例
    ├── experiments/  # 合成评测源码与复算工具
    ├── tests/
    ├── releases/     # 版本记录
    └── package.json
```

## 开始使用

需要 Node.js 18+、Python 3.9+，无需安装第三方依赖。

```sh
cd dataset
npm test
python3 tools/import_demo.py fixtures/tiny/transport.json.gz /tmp/awf-tiny
python3 tools/validate.py /tmp/awf-tiny
```

网页只提供“我的数据 → 导出”一个入口，下载本账号各会话的已保存数据；未完成评测会保留续答，并暂不进入导出。实际下载的是一个 `.json.gz` 数据包：JSON 是内容，gzip 只是压缩，无需选择格式。导入工具会自动生成 `manifest.json`、`artifact_refs.json` 和各表的 `.jsonl.gz` 文件；无需手工整理。表的拆分用于区分内容、行为、系统输出和评价标签，未评分内容不会变成零分。

- [完整使用说明](dataset/README.md)
- [数据说明](dataset/docs/dataset-card.md)
- [字段和文件格式](dataset/docs/format.md)
- [采集与存储](dataset/docs/collection.md)
- [评价规则](dataset/docs/evaluation.md)

目录调整没有改变数据协议或格式代码。既有 demo 固定到旧提交的格式副本继续有效；新版本源码位置为 `dataset/src/format.mjs`。
