# Collection boundary

The demo's online provider search remains live. An observer archives every returned lightweight result before recommendation exclusion/truncation, including results never shown or rated. The observer does not replace retrieval with a fixed corpus, expand model budgets, invent policy actions or change recommendation behavior.

Original source event records remain authoritative. Small archive indexes live with the original events; private gzip capture artifacts can live in private object storage. An archive write failure must leave an observable retryable state while ordinary reading continues. Do not claim an artifact exists because a source event or pending index exists. The transport may carry unavailable external artifact references explicitly.

Normal browser use does not write this local checkout. Local import is a deliberate offline action. The server must enforce current-account ownership and existing blind/evaluation export seal guards before supplying a dataset transport. This repository's formatter is a pure projection and is not an authentication boundary.

In the reference demo, production events persist in D1; compressed lightweight content and retrieval artifacts persist in private R2 storage. Storage is automatic and does not synchronize files to a Mac, GitHub or a cloud drive. **我的数据 → 导出** is the single user-facing export: one gzip-compressed JSON transport for all of the current account's sessions, natural history and completed or explicitly ended evaluations. It does not require keep/exclude/review actions. Unfinished evaluation groups remain resumable and are omitted to preserve blind mappings; their count is recorded in the manifest. Test/synthetic origins remain explicit, and a private export is not a reviewed public release. The old per-session and curated-release API formats remain for script compatibility, without duplicate UI downloads.

In **我的画像 → 保存状态**, check storage status or retry failed writes. **发现 → 清空并刷新** clears the displayed feed and requests fresh online content; it retains the profile, memory, natural history and archived records. The screen-reset event is an interface action, not recommendation feedback.

Use `tools/import_demo.py` to materialize exported table files, then `tools/validate.py` to check them. Complete capture begins with the integration release; missing historical material is not invented.

Frozen experiment snapshots, the full acquisition → recommendation → state → feedback loop, and the distinction between observed source events and evaluator labels remain intact. There is no formal recruitment, training, simulator implementation or benchmark method expansion in this repository.
