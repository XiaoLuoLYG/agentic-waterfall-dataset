# Collection boundary

The demo's online provider search remains live. An observer archives every returned lightweight result before recommendation exclusion/truncation, including results never shown or rated. The observer does not replace retrieval with a fixed corpus, expand model budgets, invent policy actions or change recommendation behavior.

Original source event records remain authoritative. Small archive indexes live with the original events; private gzip capture artifacts can live in private object storage. An archive write failure must leave an observable retryable state while ordinary reading continues. Do not claim an artifact exists because a source event or pending index exists. The transport may carry unavailable external artifact references explicitly.

Normal browser use does not write this local checkout. Local import is a deliberate offline action. The server must enforce current-account ownership and existing blind/evaluation export seal guards before supplying a dataset transport. This repository's formatter is a pure projection and is not an authentication boundary.

In the reference demo, production events and archive indexes persist in the site's D1 database; compressed lightweight content and retrieval artifacts persist in its private R2 binding `DATASET_ARCHIVE`. This is automatic server storage, not automatic synchronization to a user's Mac, GitHub, or cloud drive. In **我的画像 → 数据保存与导出**, check archive status, retry pending writes, or download the current session's `.json.gz` transport. Use `tools/import_demo.py` to materialize the versioned files, optionally merging several session downloads. Old JSON/JSONL exports remain available. Complete capture begins with the integration release; missing historical material is not invented.

Frozen experiment snapshots, the full acquisition → recommendation → state → feedback loop, and the distinction between observed source events and evaluator labels remain intact. There is no formal recruitment, training, simulator implementation or benchmark method expansion in this repository.
