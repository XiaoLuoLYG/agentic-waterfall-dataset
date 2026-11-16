# Submit a result

Choose a track on the [leaderboard](https://xiaoluolyg.github.io/agentic-waterfall-dataset/). Use the data version, split, allowed inputs, and scoring rule listed under that table. The [benchmark guide](dataset/docs/public-benchmarks.md) links to the source datasets. [Waterfall release files](dataset/releases/waterfall-dataset-v1/README.md) describe the frozen trajectories and score replay.

Open a [result submission](https://github.com/XiaoLuoLYG/agentic-waterfall-dataset/issues/new?template=leaderboard.yml) with your method name, code revision, model and retrieval configuration, exact commands, per-case outputs, scoring logs, and aggregate metrics. Include the number of evaluated cases and the full expected denominator. Keep credentials out of the artifacts.

The archived replay commands recalculate existing scores. They do not run a new method or produce judgments for newly retrieved cards. A new Waterfall Dataset entry also needs the permitted checkpoint inputs, the frozen catalogs, and judgments made with the same scoring protocol. Share the judge configuration and outputs with the submission.

## Review and inclusion

Maintainers check the protocol, case coverage, failure handling, and scoring evidence. They record which commands they reran in the issue or pull request. Accepted entries are merged into `docs/results.json` and appear on GitHub Pages. Anyone can discuss a result or propose a correction through its linked review.

The **Reference** label identifies a result from the paper or an archived author run. **Community** identifies a contributed result with a review link. Neither label means an independent model rerun has been certified. The automated check validates the result format and protects the original reported values; it does not establish that an experiment is correct.

Keep different evaluation setups in separate tracks. In particular:

- Report failures and missing predictions under the track's scoring rule. Do not drop them to raise the score.
- Waterfall Dataset DCG uses linear gains on fully rated top-five lists. Include scored and complete list counts. Report missing metrics as `null`.
- Leave vote fields `null` for a new method. The published vote credits belong to a fixed group of opponents. A new blind-vote comparison needs a separate track with all participating methods evaluated together.
- MIND paper entries include separate runs. A new entry must give its impression IDs and coverage so reviewers can establish whether its cohort matches.
- Ablations are recorded separately. State carryover and rebuilt checkpoint state are different conditions.

## Add an entry by pull request

You can submit a PR directly instead of opening an issue. Add one entry to the matching board's `entries` array in `docs/results.json`. Keep the existing reference rows. The fields are:

| Field | What to provide |
| --- | --- |
| `id` | A unique lowercase name within the track, such as your method and run date |
| `method` | The displayed method name |
| `origin` | `community` |
| `metrics` | The track's metric keys, using numbers or `null`; use percentages only where the column says `%` |
| `reproduction.version` | The board's exact `version` value |
| `reproduction.code`, `revision` | HTTPS source link and the full 40-character Git commit |
| `reproduction.artifacts` | HTTPS link to per-case outputs and scoring logs |
| `reproduction.review` | The submission issue or PR URL in this repository |
| `reproduction.configuration` | Model revision, prompts, retrieval access, judge setup, and other settings needed to repeat the run |
| `reproduction.command` | The command that produces the reported score |
| `reproduction.evaluated`, `expected` | Integer case counts, including failures in the expected total |

Run the check from the repository root with Node.js 18 or newer:

```sh
node --test dataset/tests/leaderboard.test.mjs
```

GitHub Actions runs the same check on result PRs. A score correction should link to the affected entry and explain how the corrected value was obtained.

## Preview the website

The page uses plain HTML, CSS, and JavaScript. It needs no package install or build step.

```sh
python3 -m http.server 4198 --bind 127.0.0.1 --directory docs
```

Open `http://127.0.0.1:4198`. `docs/results.json` stores the scores and track descriptions; `docs/leaderboard.mjs` renders them; `docs/leaderboard.css` styles the page. On GitHub, Pages serves `main` from `/docs`. Publishing the data release and enabling Pages are separate repository settings. Remove the pending-release notice only after the listed release files are downloadable.
