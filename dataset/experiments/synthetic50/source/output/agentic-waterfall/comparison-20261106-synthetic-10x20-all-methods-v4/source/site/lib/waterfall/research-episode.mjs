import {researchMetrics,researchExportRows} from './research.mjs';
import { hash } from './core.mjs';

// This projection preserves what the demo actually ran; it does not invent the paper's action protocol.
export function buildEpisode(rows, { session, exportedAt, contextRows = [] }) {
  const inputs = new Map(rows.filter(r => r.kind === 'input' && r.track === 'feed').map(r => [r.input_snapshot.id, r]));
  const runs = rows.filter(r => r.kind === 'run' && r.track === 'feed');
  const failures = rows.filter(r => r.kind === 'failure' && r.track === 'feed');
  const decisions = [];
  const corpus = new Map();
  const addItems = (items = []) => { for (const item of items) if (item?.id) corpus.set(`${item.id}:${item.content_hash || ''}`, item); };
  const addTrace = (snapshot, trace, owner, stateAfter, failed) => {
    addItems(snapshot?.candidate_pool);
    const toolStep = (trace || []).find(step => step.phase === 'tool_result');
    for (const step of trace || []) {
      if (step.phase === 'tool_result') { for (const result of step.results || []) addItems(result.items); continue; }
      if (step.phase === 'unified') {
        const canonicalInput=step.input||null;let modelInput=null;try{if(step.messages?.[1]?.content)modelInput=JSON.parse(step.messages[1].content);}catch{modelInput=step.messages?.[1]?.content||null;}
        const output=step.parsed_output||null;
        decisions.push({decision_id:`${owner.id}:unified:${decisions.length+1}`,phase:'unified',input:snapshot,canonical_input:canonicalInput,input_sha256:canonicalInput?hash(canonicalInput):null,model_input:modelInput,model_call:{messages:step.messages||null,requested_model:step.requested_model||null,provider_response_model:step.provider_response_model||null,request_settings:step.request_settings||null,usage:step.usage||null,finish_reason:step.finish_reason||null,started_at:step.started_at||null,completed_at:step.completed_at||null},raw_output:step.content??null,parsed_output:output,validation:{valid:!step.error&&!(step.execution_results||[]).some(result=>result.status==='failed'),errors:(step.execution_results||[]).filter(result=>result.status==='failed').map(result=>result.error)},normalized_output:step.normalized_output||output,dispatch_groups:step.dispatch_groups||[],execution_results:step.execution_results||[],state_after:step.state_after||null,recorded_at:step.at||owner.available_at,run_id:failed?null:owner.id,failure_id:failed?owner.id:null});
        continue;
      }
      if (!['plan', 'rank', 'rank_retry', 'failure'].includes(step.phase)) continue;
      const modelCall = step.phase === 'failure' ? step.model_metadata || {} : step;
      const actualInput = modelCall.messages?.[1]?.content;
      let modelInput = null; try { if (actualInput) modelInput = JSON.parse(actualInput); } catch { modelInput = actualInput; }
      const phase = step.phase === 'failure' ? (step.failed_phase || 'unknown') : step.phase === 'rank_retry' ? 'rank' : step.phase;
      const isFailure = step.phase === 'failure' || step.phase === 'rank_retry';
      const actions = step.actions || step.rejected_output?.actions || [];
      const execution = step.execution_results || (step.phase === 'plan' ? toolStep?.execution_results : null) || [];
      const decisionKey = `${owner.id}:${phase}${step.phase === 'rank_retry' ? ':rejected' : ''}`;
      const normalized = actions.map((action, index) => {
        const args = action.type === 'acquire' ? { source_ids:[action.source], mode:action.mode, query:action.query, target_id:null, content_types:[action.modality], constraint_refs:[], limit:null } : action.type === 'recommend' ? { ordered_item_ids:action.candidate_ids, delivery:snapshot?.pending_queue ? 'replace_pending' : 'append', reason:action.reason } : action.type === 'keep' ? { mode:'keep', task_id:null, text:action.text } : Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'type'));
        return { action_id:`${decisionKey}:${index + 1}`, kind:action.type === 'keep' ? 'idle' : action.type, arguments:args, evidence_refs:action.evidence_ids || [], depends_on:[], provenance:'collector_projection_of_demo_output', dependency_origin:'demo_controller_has_no_explicit_dependency_ids' };
      });
      const groups = (step.dispatch_groups || (step.phase === 'plan' ? toolStep?.dispatch_groups : null) || []).map(group => {
        const used = new Set();
        const parallelActions = (group.actions || []).map(action => { const index=actions.findIndex((candidate,i) => !used.has(i) && JSON.stringify(candidate) === JSON.stringify(action)); if (index < 0) return null; used.add(index); return normalized[index].action_id; }).filter(Boolean);
        return { started_at:group.started_at, parallel_actions:parallelActions, original_actions:group.actions || [] };
      });
      const controller = modelInput?.input || snapshot;
      const canonicalInput = snapshot ? { schema_version:'awf-io/0.1-collection-projection', decision_id:`${owner.id}:${phase}`, user_id:session.user_id, session_id:session.session_id, observed_at:modelCall.started_at || step.at || snapshot.captured_at, trigger:snapshot.trigger || 'unknown', dialogue:[...(snapshot.recent_commands || []).map(c => ({ id:c.id, role:'user', text:c.command, available_at:c.available_at })), ...(snapshot.command ? [{ id:snapshot.command_event_id || snapshot.id, role:'user', text:snapshot.command, available_at:rows.find(r => r.id === snapshot.command_event_id)?.available_at || snapshot.captured_at }] : [])], behavior_events:snapshot.behavior || [], user_state:controller?.state || null, environment:{ candidate_pool:controller && 'candidate_pool' in controller ? controller.candidate_pool : null, pending_item_ids:snapshot.pending_queue ? snapshot.previous_slate_ids : null, rendered_item_ids:snapshot.rendered_ids || null, source_catalog:snapshot.available_sources || [], tool_results:modelInput?.tool_results || null, resulting_state:modelInput?.resulting_state || null, in_flight:null, limits:null } } : null;
      for (const result of execution) addItems(result.result?.items);
      decisions.push({
        decision_id: decisionKey, phase, ...(step.phase === 'rank_retry' ? { retry_rejected:true } : {}), input: snapshot, canonical_input:canonicalInput, input_sha256: snapshot ? hash(snapshot) : null,
        model_input: modelInput, rule_input:step.rule_input || null, model_call: { messages: modelCall.messages || null, requested_model: modelCall.requested_model || null, provider_response_model: modelCall.provider_response_model || null, request_settings: modelCall.request_settings || null, usage: modelCall.usage || null, finish_reason: modelCall.finish_reason || null, http_status:modelCall.http_status ?? null, transport_response:modelCall.transport_response ?? null, started_at: modelCall.started_at || null, completed_at: modelCall.completed_at || null },
        raw_output: modelCall.raw_output ?? null, parsed_output: isFailure ? step.rejected_output ?? null : { actions },
        validation: { valid: isFailure ? (step.rejected_output || modelCall.raw_output != null ? false : null) : !execution.some(item => item.status === 'rejected'), errors: isFailure ? [step.error || step.validation_error] : execution.filter(item => item.status === 'rejected').map(item => item.error), ...(execution.some(item => item.status === 'rejected') ? { partial: true } : {}) },
        normalized_output: isFailure && !step.rejected_output ? null : { decision_id:decisionKey, actions:normalized },
        dispatch_groups: groups, execution_results: execution.map((item,index) => ({ action_id: normalized[index]?.action_id || null, ...item })),
        proposed_state_after:step.proposed_state_after || null,
        state_after: phase === 'rank' && !failed && !isFailure ? stateAfter : null,
        recorded_at: step.at || owner.available_at, run_id: failed ? null : owner.id, failure_id: failed ? owner.id : null
      });
    }
  };
  for (const run of runs) { addItems(run.result?.content_snapshot?.items); addTrace(run.result?.input_snapshot, run.result?.trace, run, run.result?.state_after, false); }
  for (const failure of failures) addTrace(inputs.get(failure.input_snapshot_id)?.input_snapshot, failure.partial_trace, failure, null, true);
  const finishedSnapshots = new Set([...runs.map(r => r.result?.input_snapshot?.id), ...failures.map(r => r.input_snapshot_id)]);
  for (const [snapshotId, input] of inputs) if (!finishedSnapshots.has(snapshotId)) {
    const trace = rows.filter(r => r.kind === 'decision_trace' && r.input_snapshot_id === snapshotId).map(r => r.trace);
    addTrace(input.input_snapshot, trace, input, null, true);
    if (!trace.some(x => x.phase === 'failure')) decisions.push({ decision_id:`${input.id}:incomplete`, phase:'incomplete', input:input.input_snapshot, input_sha256:hash(input.input_snapshot), raw_output:null, parsed_output:null, validation:{valid:null,errors:[]}, dispatch_groups:[], execution_results:[], state_after:null, recorded_at:input.available_at, failure_id:null, run_id:null, status:'interrupted_or_in_progress' });
  }
  decisions.sort((a,b) => (a.recorded_at || '').localeCompare(b.recorded_at || ''));
  const eventKinds = new Set(['session','enter','leave','scroll','exposure','open','return','feedback','command','response','feed_update','feed_reset','settings_change']);
  const eventLog = rows.filter(r => eventKinds.has(r.kind) && (!r.track || r.track === 'feed'||r.kind==='feed_reset')).map(r => ({
    id:r.id, type:r.kind === 'feedback' ? r.value : r.kind === 'session' ? 'session_start' : r.kind,
    occurred_at:r.event_time || r.available_at, available_at:r.available_at, item_id:r.content_id || null, exposure_id:r.exposure_id || null,
    payload:{ ...r }
  }));
  const blindIds=new Set(rows.filter(r=>r.kind==='comparison' && r.study_protocol==='blind-next-v1').map(r=>r.id));
  const blindEventLog=rows.filter(r=>r.track==='blind' && (r.kind==='blind_presentation' && blindIds.has(r.comparison_id) || r.kind==='evaluation' && blindIds.has(r.comparison_id) || ['open','return'].includes(r.kind) && blindIds.has(r.reference_id))).map(r=>{
    const {mapping,assignment_probability,...payload}=r;
    return { id:r.id, type:r.kind==='evaluation'?'blind_choice':r.kind==='blind_presentation'?'blind_presentation':`blind_${r.kind}`, occurred_at:r.event_time || r.available_at, available_at:r.available_at, item_id:r.content_id || null, payload };
  });
  const dialogue = rows.filter(r => ['command','response'].includes(r.kind)).map(r => ({ id:r.id, role:r.kind === 'command' ? 'user' : 'assistant', text:r.text, occurred_at:r.event_time, available_at:r.available_at, target_refs:r.reference_id ? [r.reference_id] : [], origin:r.simulated ? 'synthetic' : 'human' }));
  for (const row of inputs.values()) if (row.input_snapshot.command && !row.input_snapshot.command_event_id) dialogue.push({ id:row.input_snapshot.id, role:'user', text:row.input_snapshot.command, occurred_at:null, available_at:row.available_at, target_refs:[], origin:'legacy_recorded_at_execution' });
  dialogue.sort((a,b) => a.available_at.localeCompare(b.available_at));
  const starts = rows.filter(r => r.kind === 'exposure' && r.track === 'feed' && r.phase === 'start');
  const windows = starts.map(start => {
    const end = rows.find(r => r.kind === 'exposure' && r.phase === 'end' && r.exposure_id === start.exposure_id);
    const feedback = rows.filter(r => ['open','return','feedback'].includes(r.kind) && r.exposure_id === start.exposure_id);
    return { exposure_id:start.exposure_id, item_id:start.content_id, slate_id:start.reference_id, position:start.position, started_at:start.event_time, observation_end_at:end?.event_time || null, observation_status:end ? 'complete' : 'open_or_interrupted', visible_ms:end?.visible_ms ?? null, measurement:start.visibility_rule || 'unknown', simulated:!!start.simulated, observed_feedback_types:['open','return','like','dislike','save','unsave','comment'], feedback_event_ids:feedback.map(r=>r.id) };
  });
  const ids = new Set();
  for (const row of inputs.values()) { for (const e of row.input_snapshot.behavior || []) ids.add(e.id); for (const c of row.input_snapshot.recent_commands || []) ids.add(c.id); }
  for (const comparison of rows.filter(r=>r.kind==='comparison' && r.study_protocol==='blind-next-v1')) for (const eventId of comparison.history_event_ids || []) ids.add(eventId);
  const referencedContext = contextRows.filter(r => r.session_id !== session.session_id && ((ids.has(r.id) && ['feedback','exposure','open','return','command'].includes(r.kind) && r.track === 'feed') || (r.kind === 'input' && r.track === 'feed' && ids.has(r.input_snapshot?.id))));
  const runRefs = new Set(referencedContext.map(r => r.reference_id).filter(Boolean));
  const contextRuns = contextRows.filter(r => r.session_id !== session.session_id && r.kind === 'run' && r.track === 'feed' && runRefs.has(r.id));
  for (const run of contextRuns) addItems(run.result?.content_snapshot?.items);
  referencedContext.push(...contextRuns);
  return {
    schema_version:'awf-collection/1.0', exported_at:exportedAt,
    metadata:{ episode_id:session.session_id, user_id:session.user_id, session_id:session.session_id, data_origin:session.record_kind === 'human' ? 'human' : 'synthetic', eligible_for_analysis:null, started_at:session.event_time, ended_at:null, exported_at:exportedAt },
    run_meta:{ io_contract:'demo-controller-two-phase/0.2', collection_protocol:{ version:'awf-collection/1.0', exposure_rule:'foreground + focused, at least 50% visible for 1 second; immediate on card interaction', external_time:'open and return only; external playback is not measured', simulated_exposure:'simulated action, not actual viewing' }, note:'Original model calls and demo actions are retained as executed; no hypothetical actions or evaluation labels are added.' },
    environment_snapshot:{ source_catalog:inputs.size ? [...inputs.values()].at(-1).input_snapshot.available_sources || [] : [], corpus:[...corpus.values()], note:'Content and source snapshots are also preserved per decision.' },
    initial_snapshot:{ user_state:rows.find(r=>r.kind==='state')?.state || null, settings:session.initial_settings ?? null },
    research_studies:researchExportRows(rows.filter(row=>['research_study','research_legacy_artifact'].includes(row.kind))).filter(row=>row.kind==='research_study'),
    research_preparations:researchExportRows(rows.filter(row=>row.kind==='research_preparation')),
    research_artifacts:[...new Map(rows.filter(row=>row.artifact_ref).map(row=>[row.study_id||row.id,{study_id:row.study_id||row.id,session_id:row.session_id,artifact_ref:row.artifact_ref,download_url:`/api/research/artifact?sessionId=${encodeURIComponent(row.session_id)}&studyId=${encodeURIComponent(row.study_id||row.id)}`}])).values()],
    archive_policy:'This export contains research indices and labels. Full method records are private gzip artifacts available only through authenticated sealed-study downloads.',
    research_stops:rows.filter(row=>row.kind==='research_stop'),
    content_ratings:rows.filter(row=>row.kind==='evaluation'&&row.label_type==='content_rating'),
    research_blind_choices:rows.filter(row=>row.kind==='evaluation'&&row.label_type==='blind_choice'),
    research_presentations:rows.filter(row=>row.kind==='research_presentation'),
    research_events:rows.filter(row=>row.kind==='research_event'),
    content_rating_metrics:researchMetrics(rows),
    decisions, event_log:[...eventLog,...rows.filter(r=>r.kind==='collection_profile'||r.kind==='agent_decision'&&r.track==='evaluation').map(r=>({id:r.id,type:r.kind,occurred_at:r.event_time||r.available_at,available_at:r.available_at,payload:{...r,annotation_policy:'evaluation_only'}}))], blind_event_log:blindEventLog, dialogue_log:dialogue,
    slates:runs.map(r=>({ slate_id:r.id, item_ids:(r.result?.slate || []).map(i=>i.id), available_at:r.available_at, content_snapshot:r.result?.content_snapshot || null })),
    feedback_windows:windows, simulator_decisions:rows.filter(r=>['agent_attempt','agent_decision','agent_failure'].includes(r.kind)),
    final_snapshot:{ state:rows.findLast(r=>['state','collection_profile'].includes(r.kind)&&r.state)?.state || null, feed: (() => { const last=rows.findLast(r=>['feed_update','feed_reset'].includes(r.kind)); return last ? { visible_cards:last.visible_cards||[], pending_cards:last.pending_cards||[], recorded_at:last.event_time } : null; })(), last_leave:rows.findLast(r=>r.kind==='leave') || null, termination_reason:null },
    referenced_context:referencedContext,
    blind_trials:rows.filter(r=>r.kind==='comparison' && r.study_protocol==='blind-next-v1').map(comparison=>({
      comparison, attempt:rows.find(r=>r.id===comparison.attempt_id) || null,
      presentation:rows.find(r=>r.kind==='blind_presentation' && r.comparison_id===comparison.id) || null,
      choice:rows.find(r=>r.kind==='evaluation' && r.comparison_id===comparison.id) || null,
      simulated_choice:rows.find(r=>r.kind==='blind_simulated_choice' && r.comparison_id===comparison.id) || null,
      events:rows.filter(r=>r.track==='blind' && (r.comparison_id===comparison.id || r.reference_id===comparison.id) && !['blind_presentation','evaluation','blind_simulated_choice'].includes(r.kind))
    })),
    blind_attempts_incomplete:rows.filter(r=>r.kind==='blind_attempt' && !rows.some(c=>c.kind==='comparison' && c.attempt_id===r.id)).map(attempt=>({attempt,status:'interrupted_or_in_progress'})),
    source_records:researchExportRows(rows.filter(r=>r.track !== 'blind' && !['evaluation','comparison'].includes(r.kind)))
  };
}
