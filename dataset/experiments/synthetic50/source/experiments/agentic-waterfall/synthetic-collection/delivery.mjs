import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { blindProtocol, judgeMessages } from './comparison.mjs';
import { errorText, now, read, save, sha, workspace } from './collection.mjs';

const protocol = 'synthetic-collection/1';
const blindOptions = ['A', 'B', 'C', 'D', 'E'];
const href = (label, path) => '[' + label + '](' + path + ')';
const subsetTitles = { general: '一般组', behavior_ambiguity: '行为歧义', interactive_revision: '交互修改', all: '合计' };
const name = { waterfall: 'Waterfall', clawrec: 'ClawRec-adapted', i2agent: 'i²Agent-adapted', recagent: 'RecAgent-adapted', 'generic-agent': '通用 Agent', 'fixed-retrieval': 'BM25+BGE' };
const pretty = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const duration = ms => Number.isFinite(ms) ? (ms / 60000).toFixed(1) + ' 分钟' : '—';
const cleanTitle = title => String(title || '').replace(/<[^>]+>/g, '').replaceAll('|', '｜').replace(/\s+/g, ' ').slice(0, 100);

function studyFiles(comparisonRoot, input) {
  const path = join(comparisonRoot, 'studies', input.user, String(input.round));
  const file = join(path, 'questions.json');
  return existsSync(file) ? { path, questions: read(file), mapping: read(join(path, 'mapping.json')) } : null;
}

function storedLabel(path, id) {
  const file = join(path, 'labels', id + '.json');
  return existsSync(file) ? read(file) : null;
}

// Normalize incomplete UTF-16 only in the standard export. Raw receipts and their hashes stay intact.
function normalizeUnicode(value, counts) {
  if (typeof value === 'string') {
    if (value.isWellFormed()) return value;
    counts.repaired_string_fields++;
    return value.toWellFormed();
  }
  if (Array.isArray(value)) return value.map(item => normalizeUnicode(item, counts));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeUnicode(item, counts)]));
}

export function augmentComparison(episode, result, comparisonRoot) {
  episode.artifact_refs = ['persona.json', 'trajectory.jsonl', 'events.jsonl'].map(file => {
    const location = join('users', result.persona.id, file);
    return { path: '../../' + location, kind: 'private_raw_session', sha256: sha(readFileSync(join(dirname(comparisonRoot), location))),
      availability: 'private_local', session_id: episode.metadata.session_id };
  });
  for (const input of result.inputs) {
    const study = studyFiles(comparisonRoot, input);
    if (!study) continue;
    const { path, questions, mapping } = study;
    const ratingId = input.context.snapshot.id + '-ratings', blindId = input.context.snapshot.id + '-blind';
    const { snapshot, public_input } = input.context;
    const blindMethods = mapping.blind?.flatMap(row => Object.values(row.options)) ?? mapping.pairs.flatMap(row => [row.A, row.B]);
    const methodIds = [...new Set([...mapping.cards.map(row => row.method), ...blindMethods])];
    const methods = methodIds.flatMap(method => {
      const file = join(comparisonRoot, 'runs', input.user, String(input.round), method + '.json.gz');
      if (!existsSync(file)) return [];
      const record = JSON.parse(gunzipSync(readFileSync(file)));
      return record.methods.map(row => ({ ...row, source_run_id: record.run_id, source_run_sha256: sha(readFileSync(file)) }));
    });
    const itemMappings = mapping.cards.map(row => ({ method_id: row.method, rank: row.rank, item_id: row.item_id, question_id: row.question_id }));
    const common = { protocol, input_snapshot: snapshot, public_input, context_hash: snapshot.hash, available_at: now(),
      annotation_policy: 'evaluation_only' };
    const labels = new Map(questions.ratings.map(question => [question.id, storedLabel(path, question.id)]));
    episode.research_studies.push({
      ...common, id: ratingId, mode: 'rating', items: questions.ratings.map(q => ({ id: q.id, item: q.material })),
      mappings: itemMappings, result: {
        methods, environment: { public_input }, collection_subset: input.persona.subset, checkpoint_round: input.round,
        blind_study_id: blindId, compliance_by_card: mapping.cards.map(({ method, rank, question_id, constraint }) => ({ method, rank, question_id, constraint })),
      },
    });
    const blindStudy = {
      ...common, id: blindId, mode: 'blind', result: { methods: [], environment: { public_input }, rating_study_id: ratingId,
        collection_subset: input.persona.subset, checkpoint_round: input.round },
    };
    if (questions.blind) {
      blindStudy.protocol = blindProtocol;
      const assignments = new Map(mapping.blind.map(row => [row.question_id, row]));
      blindStudy.result.blind_ballots = questions.blind.map(question => {
        const assignment = assignments.get(question.id);
        assert.equal(assignment?.rank, question.rank, 'blind ballot rank does not match its mapping');
        return { ...question, mapping: assignment.options };
      });
    } else {
      blindStudy.pairs = questions.pairs.map(q => {
        const sides = mapping.pairs.find(row => row.question_id === q.id);
        return { id: q.id, unavailable: q.unavailable, same_content: q.same_content, mapping: { A: sides.A, B: sides.B },
          A: q.material.A.map(card => ({ ...card.material, constraint: card.constraint })),
          B: q.material.B.map(card => ({ ...card.material, constraint: card.constraint })) };
      });
    }
    episode.research_studies.push(blindStudy);
    for (const question of questions.ratings) {
      const label = labels.get(question.id);
      if (!label?.decision) continue;
      episode.content_ratings.push({
        id: ratingId + '-' + question.id, study_id: ratingId, question_id: question.id, content_id: question.material.id,
        rating_value: label.decision.rating, grade_status: label.decision.status, material_sha256: label.material_sha256,
        origin: 'synthetic', provider_model: label.provider_model, evaluated_at: label.evaluated_at, rubric_version: protocol,
      });
    }
    for (const question of questions.blind ?? questions.pairs) {
      const label = storedLabel(path, question.id);
      if (!label?.decision || questions.blind && question.unavailable) continue;
      episode.research_blind_choices.push({
        id: blindId + '-' + question.id, study_id: blindId, question_id: question.id, choice: label.decision.choice,
        material_sha256: label.material_sha256, origin: 'synthetic', annotation_source: label.origin, provider_model: label.provider_model,
        evaluated_at: label.evaluated_at, rubric_version: blindStudy.protocol,
      });
    }
  }
  const counts = { repaired_string_fields: 0 };
  Object.assign(episode, normalizeUnicode(episode, counts));
  return counts.repaired_string_fields;
}

async function auditLabels(root, results, api) {
  if (!api.stats().slots.some(slot => slot.enabled.pro)) return { status: 'no_pro_route' };
  const comparisonRoot = join(root, 'comparison');
  const candidates = results.flatMap(result => result.inputs.flatMap(input => {
    const study = studyFiles(comparisonRoot, input);
    if (!study) return [];
    return Object.entries({ rating: study.questions.ratings, blind: study.questions.blind ?? study.questions.pairs }).flatMap(([mode, questions]) => questions.flatMap(question => {
      const label = storedLabel(study.path, question.id);
      const opponent = mode === 'blind' ? study.mapping.pairs?.find(pair => pair.question_id === question.id)?.opponent : null;
      return label?.origin === 'model' && label.decision && !question.unavailable ? [{ mode, input, question, decision: label.decision, opponent }] : [];
    }));
  }));
  const selected = Object.keys(subsetTitles).filter(key => key !== 'all').flatMap(subset => ['rating', 'blind'].flatMap(mode => {
    const sample = candidates.filter(row => row.input.persona.subset === subset && row.mode === mode)
      .sort((a, b) => sha('audit-1:' + a.question.material_sha256).localeCompare(sha('audit-1:' + b.question.material_sha256)));
    if (mode === 'rating') return sample.slice(0, 4);
    const claw = sample.find(row => row.opponent === 'clawrec');
    return claw ? [claw, ...sample.filter(row => row !== claw).slice(0, 1)] : sample.slice(0, 2);
  }));
  const audited = await Promise.all(selected.map(async row => {
    const { mode, question, input, decision } = row;
    const base = { mode, subset: input.persona.subset, user: input.user, round: input.round, question_id: question.id, flash: decision };
    try {
      const messages = judgeMessages({ ...input, public_input: input.context.public_input }, question, mode);
      const response = await api.generate(messages, { model: 'pro', stage: 'label_audit_' + mode, max_tokens: 4096, temperature: .1, question_id: question.id });
      const pro = JSON.parse(response.choices[0].message.content);
      const isOption = choice => mode === 'blind' && typeof choice === 'string' && Object.hasOwn(question.material, choice) && question.material[choice] !== null;
      const valid = mode === 'rating'
        ? pro.status === 'rated' && Number.isInteger(pro.rating) && pro.rating >= 0 && pro.rating <= 3 || pro.status === 'unable' && pro.rating === null
        : ['tie', 'neither', 'insufficient'].includes(pro.choice) || !question.same_content && isOption(pro.choice);
      const sameOptionMaterial = question.rank && isOption(decision.choice) && isOption(pro.choice) &&
        JSON.stringify(question.material[decision.choice]) === JSON.stringify(question.material[pro.choice]);
      return valid ? { ...base, model: response.model, pro, ...(sameOptionMaterial ? { same_option_material: true } : {}) }
        : { ...base, error: 'invalid_pro_label' };
    } catch (error) { return { ...base, error: errorText(error) }; }
  }));
  const ratings = audited.filter(row => row.mode === 'rating' && row.flash.status === 'rated' && row.pro?.status === 'rated');
  const blind = audited.filter(row => row.mode === 'blind' && row.pro);
  const summary = { status: 'recorded', count: audited.length, errors: audited.filter(row => row.error).length, ratings: {
    comparable: ratings.length, exact: ratings.filter(row => row.flash.rating === row.pro.rating).length,
    within_one: ratings.filter(row => Math.abs(row.flash.rating - row.pro.rating) <= 1).length,
  }, blind: { comparable: blind.length, exact: blind.filter(row => row.flash.choice === row.pro.choice || row.same_option_material).length,
    reversals: blind.filter(row => !row.same_option_material && blindOptions.includes(row.flash.choice) &&
      blindOptions.includes(row.pro.choice) && row.flash.choice !== row.pro.choice).length } };
  save(join(root, 'quality', 'labels-pro.json'), { ...summary, audited });
  return summary;
}

function dcg(row) {
  return row?.cards.length === 5 && row.cards.every(card => card.interest?.status === 'rated')
    ? row.cards.reduce((score, card) => score + card.interest.rating / Math.log2(card.rank + 1), 0) : null;
}

function paired(full, subset) {
  return full.checkpoints.filter(x => x.subset === subset).flatMap(x => {
    const waterfall = dcg(x.methods.waterfall), clawrec = dcg(x.methods.clawrec);
    return waterfall !== null && clawrec !== null ? [{ user: x.user, round: x.round, diff: waterfall - clawrec }] : [];
  });
}

export async function writeReport({ root, results, quality, full, verification, api, auditResults = results }) {
  // The demo formatter identifies ordinary feed runs as Waterfall. This feed uses archived reference cards.
  const main = join(root, 'dataset', 'main');
  const runsPath = join(main, 'runs.jsonl.gz');
  const referenceIds = new Set(results.flatMap(row => row.trajectory.map(round => round.reference_id)));
  const runs = gunzipSync(readFileSync(runsPath)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(runs.filter(row => referenceIds.has(row.run_id)).length, referenceIds.size);
  for (const row of runs) if (referenceIds.has(row.run_id)) row.method_id = 'controlled_reference';
  save(runsPath, gzipSync(runs.map(row => JSON.stringify(row) + '\n').join('')));
  if (full.fixed_pool) {
    const { path, manifest_path, ...pool } = full.fixed_pool;
    const file = join(main, 'manifest.json'), manifest = read(file);
    manifest.evaluation_candidate_pool = { ...pool, path: relative(main, path), manifest_path: relative(main, manifest_path) };
    save(file, manifest);
  }
  const check = spawnSync('python3', [resolve(workspace, '../agentic-waterfall-dataset/dataset/tools/validate.py'), main], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.deepEqual(JSON.parse(check.stdout), verification);

  const pro = await auditLabels(root, auditResults, api);
  const stats = api.stats();
  const checkpoints = full.coverage.contexts_total;
  const rankedBlind = Number.isInteger(full.by_subset.all?.blind?.expected_choices);
  const authored = results.reduce((sum, { trajectory }) => sum + trajectory.filter(row => row.behavior_status === 'authored_common_seed').length, 0);
  const lines = ['# 自采合成预试与五方法对比', '',
    '本批 ' + results.length + ' 人、' + quality.users.reduce((sum, user) => sum + user.valid_rounds, 0) + ' 个有效轮次。' +
      (rankedBlind ? '其中 ' + authored + ' 个配对开局轮次使用人工固定动作，其余有效轮次的动作由 Flash 生成。'
        : '前四轮共同开局为人工固定素材与动作，后续动作由 Flash 生成。') +
      (full.fixed_pool
        ? '参考卡来自已归档的真实来源，含本轮冻结的采集素材。五种方法使用同一公开历史截点。Waterfall 和 ClawRec 各自联网检索，RecAgent、i²Agent 和 BM25+BGE 使用同一份冻结候选池。'
        : '参考卡取自上次归档的真实来源。五个方法按相同公开历史各自联网检索。'), '',
    '主包通过标准校验，包含 ' + verification.table_counts.participants + ' 位参与者、' + verification.table_counts.ratings + ' 条单卡评价、' +
      verification.table_counts.blind_choices + (rankedBlind ? ' 条盲选答卷。' : ' 条列表判定。') + '评价与隐藏画像只用于研究。', '',
    '## 五方法结果', '',
    '完整 Top 5 表示该检查点交付了五张。兴趣分只均值已打分卡位。DCG@5 使用 0–3 分除以排名折扣，仅汇总五张都已打分的检查点。明确限制另算合规，兴趣 ≥ 2 视为相关。' +
      (rankedBlind ? '' : '盲选只在两份列表都齐全时比较偏好。'), '',
  ];
  if (full.fixed_pool) lines.push(
    '冻结候选池含 ' + full.fixed_pool.cards_count + ' 张卡，来源为 ' + full.fixed_pool.selected_sources.join('、') + '。RecAgent 和 i²Agent 共用由公开证据产生的 20 张词项匹配候选，i²Agent 另用一张未见对照卡。BM25+BGE 对未见的冻结候选执行本地混合检索和重排。检索来源边界不同，结果属于混合路线端到端对照。',
    '',
    'RecAgent-adapted 使用 AgentRecBench 作者工作流和既有候选追加修正。适配增加一次方法自己的画像更新，排序只接收其更新后的画像与候选。Waterfall 和 ClawRec 首次读入公开种子，后续接续自身状态和新增行为或指令。i²Agent 的排序使用其原有阶段生成的画像、兴趣和知识。' +
      href('冻结候选池清单', full.fixed_pool.manifest_path),
    '',
  );
  if (rankedBlind) lines.push(
    '盲选协议 ' + blindProtocol + ' 要求同一检查点的五种方法各交付有序 Top 5。按第 1 至第 5 名依次呈现五组，每组把五种方法的同名次卡片随机分配到匿名 A–E。每组可选一张、并列、都不选或无法判断。相同卡片被选中时，提交该卡的方法平分这一票。', '',
  );
  for (const subset of ['general', 'behavior_ambiguity', 'interactive_revision', 'all']) {
    const group = full.by_subset[subset];
    if (!group?.methods) continue;
    lines.push('### ' + subsetTitles[subset], '',
      '| 方法 | 完整 Top 5 | 兴趣分（卡位） | DCG@5（检查点） | 合规且相关 / 有限制卡位 | 合规未知 |' + (rankedBlind ? ' 盲选得票 |' : ''),
      '|---|---:|---:|---:|---:|---:|' + (rankedBlind ? '---:|' : ''));
    for (const [id, m] of Object.entries(group.methods)) {
      const hard = m.hard_relevance;
      lines.push('| ' + (name[id] || id) + ' | ' + m.complete_lists + '/' + m.checkpoints + ' | ' + pretty(m.mean_card_interest) + '（' + m.rated_cards +
        '） | ' + pretty(m.mean_dcg_at_5) + '（' + m.dcg_at_5_denominator + '） | ' + (hard?.constrained_delivered_cards ? hard.pass_and_relevant + '/' + hard.constrained_delivered_cards : '—') +
        ' | ' + m.hard_compliance.unknown + ' |' + (rankedBlind ? ' ' + pretty(group.blind.votes_by_method[id]) + ' |' : ''));
    }
    if (rankedBlind) {
      const { expected_choices, available_choices, answered_choices, unavailable_choices, missing_choices, outcomes } = group.blind;
      lines.push('', '| 计划组数 | 五方法齐全 | 已答 | 选中一张 | 并列 | 都不选 | 无法判断 | 缺卡不可比 | 缺答 |',
        '|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
        '| ' + [expected_choices, available_choices, answered_choices, outcomes.selected, outcomes.tie, outcomes.neither,
          outcomes.insufficient, unavailable_choices, missing_choices].join(' | ') + ' |');
    } else {
      lines.push('', '| Waterfall 对手 | 双方完整 | Waterfall 胜 | 对手胜 | 平 | 都不选 | 无法判断 | 缺失 |', '|---|---:|---:|---:|---:|---:|---:|---:|');
      for (const [id, blind] of Object.entries(group.blind)) {
        const o = blind.complete_pair_outcomes;
        lines.push('| ' + (name[id] || id) + ' | ' + blind.both_complete + '/' + blind.expected_pairs + ' | ' + o.waterfall_win + ' | ' + o.opponent_win +
          ' | ' + o.tie + ' | ' + o.neither + ' | ' + o.insufficient + ' | ' + o.missing + ' |');
      }
    }
    if (subset !== 'all') {
      const rows = paired(full, subset);
      const mean = rows.length ? rows.reduce((sum, row) => sum + row.diff, 0) / rows.length : null;
      lines.push('', 'Waterfall 与 ClawRec 同时有可算 DCG 的检查点为 ' + rows.length + ' 个，Waterfall 减 ClawRec 的平均差为 ' + pretty(mean) + '。');
    }
    lines.push('');
  }
  lines.push(rankedBlind ? '## 两个场景的卡片评分例子' : '## 两个场景的实际例子', '');
  for (const subset of ['behavior_ambiguity', 'interactive_revision']) {
    const set = full.checkpoints.filter(x => x.subset === subset && (subset === 'behavior_ambiguity' ? x.round >= 8 : x.round === 11));
    const shown = rankedBlind ? set.slice(0, 2) : [...new Set([
      set.find(x => x.blind.clawrec?.outcome === 'opponent_win'),
      set.find(x => x.blind.clawrec?.outcome === 'waterfall_win'),
      set[0],
    ].filter(Boolean))].slice(0, 2);
    for (const item of shown) {
      const result = results.find(r => r.persona.id === item.user);
      const input = result.inputs.find(x => x.round === item.round);
      const describe = row => row?.cards.slice(0, 2).map(card => cleanTitle(card.material.title) + '（' + (card.interest?.rating ?? '未知') +
        ' 分，' + ({ pass: '合规', fail: '违规', unknown: '合规未知', not_applicable: '无硬限制' }[card.constraint.status] || '—') + '）').join('、') || '无交付';
      lines.push('- ' + subsetTitles[subset] + ' ' + item.user + ' 第 ' + item.round + ' 轮。当前目标为「' + input.phase.goal + '」。Waterfall 前两张是 ' +
        describe(item.methods.waterfall) + '。ClawRec 前两张是 ' + describe(item.methods.clawrec) + '。' +
        href('公开输入', join(root, 'users', item.user, 'checkpoints', 'r' + String(item.round).padStart(2, '0') + '.json')));
    }
  }
  const example = results.find(row => row.persona.subset === 'interactive_revision') || results[0];
  const examplePath = join(root, 'users', example.persona.id);
  const exampleRound = example.inputs.at(-1).round;
  const exampleCutoff = 'r' + String(exampleRound).padStart(2, '0') + '.json';
  lines.push('', '## 数据怎么读', '',
    '- ' + href('主集清单', join(root, 'dataset', 'main', 'manifest.json')) + '。主集 15 张压缩表，加清单和归档引用。内容和来源进 contents、tool_calls，用户画像、会话、事件和输入进 participants、profiles、sessions、events、contexts，推荐和评审进 runs、slates、studies、questions、presentations、ratings、blind_choices、model_calls。',
    ...(rankedBlind ? ['- questions 保留五组的名次、A–E 题面及对应卡片版本。blind_choices 通过问题编号关联已答选择。主集清单记录内容池压缩文件的哈希和内容版本数。'] : []),
    '- ' + href('行为歧义索引', join(root, 'dataset', 'subsets', 'behavior_ambiguity.json')) + ' · ' + href('交互修改索引', join(root, 'dataset', 'subsets', 'interactive_revision.json')) + '。索引引用主集中的同一参与者、会话和检查点。',
    '- 每人目录中的 ' + href('persona.json', join(examplePath, 'persona.json')) + ' 是公私设定和阶段，' +
      href('trajectory.jsonl', join(examplePath, 'trajectory.jsonl')) + ' 一行一轮，包含候选卡、指令和动作。' +
      href('events.jsonl', join(examplePath, 'events.jsonl')) + ' 是原始事件账本，' +
      href('checkpoints/' + exampleCutoff, join(examplePath, 'checkpoints', exampleCutoff)) + ' 是各方法共用的一个截点输入。',
    '- ' + href('对照运行', join(root, 'comparison', 'runs')) + ' 和 ' + href('匿名题面与标签', join(root, 'comparison', 'studies')) + ' 按用户、轮次归档。Key 只保留匿名编号。',
    '', '## 质量、时间和用量', '',
    '- ' + full.coverage.done + '/' + full.coverage.total + ' 次方法运行已记录，' + full.coverage.contexts_done + '/' + checkpoints +
      (rankedBlind ? ' 个检查点已归档评审状态。' : ' 个检查点有题面及答卷记录。') + '标签失败 ' +
      full.coverage.label_failures + '。小样复用 ' + full.coverage.reused_runs + ' 次方法运行和 ' + full.coverage.reused_labels + ' 条标注。',
    '- ' + (rankedBlind ? '主包通过程序校验。' : '全量程序校验，加三条小样逐条核对和扩批阶段复核。') + (pro.status === 'recorded'
      ? 'Pro 盲复核 ' + pro.count + ' 道题。单卡 ' + pro.ratings.exact + '/' + pro.ratings.comparable + ' 完全一致，盲选 ' + pro.blind.exact +
        '/' + pro.blind.comparable + ' 一致，' + (rankedBlind ? '改选其他卡片 ' : '直接翻转 ') + pro.blind.reversals + '。'
      : 'Pro 标签复核缺少可用路由。'),
    '- 本轮累计 ' + stats.attempts + ' 次请求，已记录输入 ' + stats.prompt_tokens + '、输出 ' + stats.completion_tokens + ' token，缺用量 ' +
      stats.usage_missing + '。' + (stats.reported_cost_calls ? '网关成本头覆盖 ' + stats.reported_cost_calls + ' 次，这部分返回金额合计 ' + stats.reported_usd.toFixed(4) + ' 美元。全批账单需要以网关账单为准。'
      : '网关未回传账单金额。') + '旧小样请求另行归档。',
    '- 本轮耗时 ' + duration(Date.now() - Date.parse(read(join(root, 'plan.json')).created_at)) + '，含小样人工验收等候。',
    '', '模拟动作由受控素材和私有设定生成。盲选和兴趣分尚缺真人校准。这里的名次适用于本批合成预试。', '');
  save(join(root, 'quality', 'delivery.json'), { verification, comparison_status: full.status, coverage: full.coverage, pro, api: stats,
    ...(rankedBlind ? { blind_choice_protocol: blindProtocol } : {}),
    delivery_sha256: sha(readFileSync(fileURLToPath(import.meta.url))) });
  writeFileSync(join(root, 'REPORT.md'), lines.join('\n'), { mode: 0o600 });
}
