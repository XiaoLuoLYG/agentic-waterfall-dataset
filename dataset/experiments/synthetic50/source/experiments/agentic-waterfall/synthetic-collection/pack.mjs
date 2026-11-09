import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildEpisode } from '../../../output/agentic-waterfall/comparison-20261106-synthetic-10x20-all-methods-v4/source/site/lib/waterfall/research-episode.mjs';
import { buildDataset } from '../../../output/agentic-waterfall/comparison-20261106-synthetic-10x20-all-methods-v4/source/site/lib/waterfall/dataset-format.mjs';
import { now, read, readLines, save, sha, userPath, workspace } from './collection.mjs';

const datasetTools = resolve(workspace, '../agentic-waterfall-dataset/dataset/tools');
function python(tool, args) {
  const result = spawnSync('python3', [join(datasetTools, tool), ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, tool + ': ' + (result.error || result.stderr || result.stdout).toString().slice(0, 2000));
  return JSON.parse(result.stdout);
}

function projectBlindBallots({ tables, manifest }) {
  const slates = new Map(tables.slates.map(row => [row.slate_id, row]));
  for (const study of tables.studies) {
    const ballots = study.source_metadata?.blind_ballots;
    if (!ballots) continue;
    // The pinned formatter already sanitized this metadata and normalized the exact slate versions.
    delete study.source_metadata.blind_ballots;
    const ratingId = study.source_metadata.rating_study_id;
    for (const { id, rank, material, mapping, material_sha256, unavailable, same_content } of ballots) {
      const options = Object.fromEntries(Object.entries(mapping).map(([slot, method_id]) => {
        const slate = slates.get(ratingId + ':' + method_id);
        const item = slate?.items.find(row => row.rank === rank);
        const { content_id = null, content_version_id = null, original_item_id = null, material_status = 'unavailable' } = item ?? {};
        assert.equal(material[slot]?.material.id ?? null, original_item_id, 'blind option does not match the recorded slate rank');
        return [slot, { method_id, slate_id: slate?.slate_id ?? null, content_id, content_version_id, original_item_id, material_status }];
      }));
      tables.questions.push({ question_id: study.study_id + ':' + id, original_question_id: id, study_id: study.study_id,
        kind: 'blind_choice', rank, mapping, options, displayed_material: material, material_sha256, unavailable, same_content,
        annotation_policy: 'evaluation_only' });
    }
  }
  manifest.table_counts.questions = tables.questions.length;
}

export function packDataset({ root, target, results, quality, augment = () => {}, includeCutoffs = false }) {
  assert(!existsSync(target), 'dataset target already exists');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(target), '.dataset-transport-'));
  const transports = [];
  const members = new Map();
  const main = join(target, 'main');
  let evaluated = 0;
  for (const result of results) {
    const { persona, inputs } = result;
    const rows = readLines(join(userPath(root, persona), 'events.jsonl'));
    const session = rows.find(row => row.kind === 'session');
    const episode = buildEpisode(rows, { session, exportedAt: now() });
    episode.metadata.ended_at = rows.at(-1)?.available_at || null;
    episode.run_meta.note = 'Archived reference material. Natural events are simulated. Research methods use only shared public prefixes.';
    augment(episode, result);
    const data = buildDataset(episode);
    projectBlindBallots(data);
    if (data.tables.studies.length) evaluated++;
    for (const slate of data.tables.slates) if (!slate.study_id) slate.method_id = 'controlled_reference';
    if (includeCutoffs) {
      for (const run of data.tables.runs) if (!run.study_id) run.method_id = 'controlled_reference';
      const provided = data.tables.sessions[0].provided_profile_id;
      const existingCutoffs = new Set(data.tables.contexts.map(row => row.source_input_snapshot?.id));
      for (const { context } of inputs) {
        const { snapshot, public_input } = context;
        if (existingCutoffs.has(snapshot.id)) continue;
        data.tables.contexts.push({
          context_id: 'context:' + sha(JSON.stringify([session.session_id, snapshot.id, snapshot.hash])),
          session_id: session.session_id, participant_id: session.participant_id, owner_ref: snapshot.id,
          cutoff_at: snapshot.captured_at, provided_profile_id: provided, inferred_profile_id: null,
          source_input_snapshot: snapshot, environment: { public_input },
          history_completeness: 'referenced_snapshots_only', annotation_policy: 'evaluation_only',
        });
      }
      data.manifest.table_counts.contexts = data.tables.contexts.length;
      const existingRefs = new Set(data.artifact_refs.map(row => row.path));
      for (const file of ['persona.json', 'trajectory.jsonl', 'events.jsonl']) {
        const location = join(userPath(root, persona), file);
        const path = relative(main, location);
        if (existingRefs.has(path)) continue;
        data.artifact_refs.push({ path, kind: 'private_raw_session', sha256: sha(readFileSync(location)),
          availability: 'private_local', session_id: session.session_id });
      }
    }
    data.manifest.collection_protocol = 'synthetic-collection/1';
    const file = join(staging, persona.id + '.json.gz');
    save(file, gzipSync(JSON.stringify(data)));
    transports.push(file);
    members.set(persona.id, {
      user_id: persona.id, participant_id: session.participant_id, session_id: session.session_id, pair: persona.pair,
      accepted: quality.users.find(user => user.user === persona.id)?.pass && (!persona.pair || quality.pairs.find(pair => pair.pair === persona.pair)?.pass),
      checkpoints: inputs.map(x => ({
        round: x.round,
        snapshot_id: x.context.snapshot.id,
        context_ids: data.tables.contexts.filter(c => c.source_input_snapshot?.id === x.context.snapshot.id).map(c => c.context_id),
      })),
    });
  }
  python('import_demo.py', [...transports, main]);
  const manifest = read(join(main, 'manifest.json'));
  manifest.collection_protocol = 'synthetic-collection/1';
  manifest.eligible_for_analysis = false;
  manifest.analysis_eligibility_reason = 'synthetic_pilot_requires_human_calibration';
  manifest.trajectory_source = 'controlled_exposure_of_archived_real_source_cards';
  const contentFile = manifest.table_files.contents;
  manifest.content_pool = { file: contentFile, sha256: sha(readFileSync(join(main, contentFile))), content_versions: manifest.table_counts.contents };
  if (includeCutoffs) {
    manifest.collection_stage = !evaluated ? 'trajectories_only' : evaluated === results.length ? 'with_evaluation' : 'mixed_evaluated_and_trajectories';
    manifest.evaluation_coverage = { participants_with_studies: evaluated, participants_without_studies: results.length - evaluated };
  }
  save(join(main, 'manifest.json'), manifest);
  for (const subset of ['behavior_ambiguity', 'interactive_revision']) {
    save(join(target, 'subsets', subset + '.json'), {
      schema_version: 'awf-subset-index/1.0', main: '../main', subset,
      members: results.filter(x => x.persona.subset === subset).map(x => members.get(x.persona.id)),
    });
  }
  const verification = python('validate.py', [main]);
  assert(verification.valid, 'standard dataset validation failed');
  rmSync(staging, { recursive: true, force: true });
  return verification;
}
