import {createHash} from 'node:crypto';
import {SOURCE_SHA256} from './waterfall-version.mjs';
const digest=data=>createHash('sha256').update(typeof data==='string'?data:JSON.stringify(data)).digest('hex');

export const VERSION='waterfall-unified-dev-0.1';
export const VARIANTS=['full','no_expression','no_behavior','fixed_workflow','no_acquire','frozen_state'];
const clone=x=>structuredClone(x);
const check=(value,message)=>{if(!value)throw new Error(message);};
const rankingError=(message,details)=>{throw Object.assign(new Error(message),{details});};
const recoverableRankingFailure=r=>r.status==='failed'&&r.kind==='recommend'&&['invalid_candidate_indices','invalid_ranking','unacquired_recommendation','incomplete_ranking','too_many_recommendations','invalid_delivery'].includes(r.error);
const pick=(obj,fields)=>Object.fromEntries(fields.filter(k=>obj[k]!==undefined).map(k=>[k,clone(obj[k])]));
const itemFields=['id','title','text','abstract','category','tags','source_id','content_type','url','published_at','available_at','content_hash','duration_ms','retrieval_score','retrieval_backend','retrieval_query','retrieval_rank'];
const publicItem=item=>{check(item&&typeof item.id==='string','item_id_required'); return pick(item,itemFields);};
const visible=(record,cutoff)=>{
  const times=['feedback_available_at','available_at','received_at','ended_at','occurred_at','timestamp'].map(k=>record[k]).filter(t=>t!==undefined&&t!==null&&t!=='');
  return !cutoff || times.every(t=>Number.isFinite(Date.parse(t))&&Date.parse(t)<=Date.parse(cutoff));
};
const words=text=>(String(text||'').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]);

export function normalizeDecision(raw,candidates=[]) {
  const decision=clone(raw),repairs=[];
  if(Array.isArray(decision?.actions))for(const a of decision.actions) {
    if(!a||typeof a!=='object')continue;
    for(const field of ['evidence_refs','depends_on'])if(a[field]===undefined){a[field]=[];repairs.push({action_id:a.action_id,field,operation:'missing_optional_array_to_empty'});}
    const indices=a.arguments?.ordered_candidate_indices;
    if(a.kind==='recommend'&&!a.arguments?.ordered_item_ids&&Array.isArray(indices)){
      const byIndex=new Map(candidates.map((candidate,index)=>[candidate.candidate_index??index+1,candidate.id]));
      if(indices.every(index=>Number.isInteger(index)&&byIndex.has(index))){a.arguments.ordered_item_ids=indices.map(index=>byIndex.get(index));delete a.arguments.ordered_candidate_indices;repairs.push({action_id:a.action_id,field:'ordered_candidate_indices',operation:'candidate_indices_to_ids'});}
    }
  }
  return {decision,repairs};
}

function isolateInputs(o,env,variant,protocol) {
  const blocked=variant==='no_expression'?'expression':'behavior';
  const valid=new Set(['expression','behavior','independent_profile','environment','tool','inferred']);
  const removed=new Set(),rows=[...o.dialogue,...o.behavior_events,...o.user_state.records,...(env.candidate_pool||[])];
  const channels=new Map();
  for(const row of rows){
    let c=[...(row.source_channels||row.provenance?.channels||[])];
    check(c.every(x=>valid.has(x)),'ablation_unknown_provenance_channel');
    if(o.dialogue.includes(row)&&row.role==='user')c.push('expression');
    if(o.behavior_events.includes(row))c.push('behavior',...(['comment','correction','instruction','user_expression'].includes(row.type)?['expression']:[]));
    if(o.user_state.records.includes(row))check(c.length,'ablation_initial_state_provenance_required');
    // Unannotated candidates are permitted only as the common exogenous pool.
    if((env.candidate_pool||[]).includes(row)&&!c.length&&!row.evidence_refs?.length)c.push('environment');
    if(o.dialogue.includes(row)&&row.role!=='user'&&!c.length&&!row.evidence_refs?.length)removed.add(row);
    channels.set(row,new Set(c));
  }
  const byId=new Map(rows.filter(r=>r.id).map(r=>[r.id,r]));
  let changed=true;
  while(changed){changed=false;for(const row of rows){const c=channels.get(row);
    for(const ref of row.evidence_refs||[]){const parent=byId.get(ref);if(!parent){if(o.user_state.records.includes(row)&&c.size)continue;if(!c.has('unknown')){c.add('unknown');changed=true;}}else for(const x of channels.get(parent)){if(!c.has(x)){c.add(x);changed=true;}}}
  }}
  for(const row of rows){const c=channels.get(row);if(c.has(blocked)||c.has('unknown')||!c.size||(c.size===1&&c.has('inferred')))removed.add(row);}
  const deniedIds=new Set([...removed].map(r=>r.id));
  o.dialogue=o.dialogue.filter(r=>!removed.has(r));o.behavior_events=o.behavior_events.filter(r=>!removed.has(r));
  o.user_state={version:o.user_state.version,records:o.user_state.records.filter(r=>!removed.has(r))};
  const candidates=(env.candidate_pool||[]).filter(r=>!removed.has(r));
  check(protocol?.mode!=='fixed_candidates'||candidates.length===(env.candidate_pool||[]).length,'ablation_fixed_candidate_pool_must_be_exogenous');
  o.environment.candidate_pool=candidates.filter(x=>visible(x,o.observed_at)).map(publicItem);
  // A prior pending list and free-form trigger may encode a forbidden query or ranking.
  o.trigger='evaluation_checkpoint';o.environment.pending_queue=[];
  o.environment.visible_item_ids=variant==='no_behavior'?[]:o.environment.visible_item_ids.filter(id=>!deniedIds.has(id));
  check(!env.derived_features&&!env.tool_results&&!env.query_features&&!env.tool_history,'ablation_rebuild_environment_required');
}

// A small frozen-corpus tool, not the planned semantic retrieval baseline.
export function lexicalAcquire(catalog,args) {
  const query=words(args.query); const sources=args.source_ids||[];
  return catalog.filter(x=>(!sources.length||sources.includes(x.source_id||'offline'))&&(!args.content_types?.length||args.content_types.includes(x.content_type))&&(!args.target_id||x.id===args.target_id))
    .map((x,index)=>({x,index,score:query.reduce((s,w)=>s+(words([x.title,x.text,x.abstract,x.category,...(x.tags||[])].join(' ')).includes(w)?1:0),0)}))
    .sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,args.limit).map(x=>x.x);
}

export function createRuntime(input,{variant='full',acquire,lookupHistory,onAction}={}) {
  check(VARIANTS.includes(variant),'unknown_variant');
  const original=input.observation; check(original&&typeof original.decision_id==='string','observation_decision_id_required');
  check(!original.observed_at||Number.isFinite(Date.parse(original.observed_at)),'invalid_observed_at');
  const o=pick(original,['schema_version','decision_id','user_id','session_id','observed_at','trigger','dialogue','behavior_events','user_state']);
  o.dialogue=(o.dialogue||[]).filter(x=>visible(x,o.observed_at));
  o.behavior_events=(o.behavior_events||[]).filter(x=>visible(x,o.observed_at)&&(!x.visible_to_policy_id||x.visible_to_policy_id===(input.protocol?.policy_id||variant)));
  o.user_state=o.user_state||{version:0,records:[]};
  check(Number.isInteger(o.user_state.version)&&Array.isArray(o.user_state.records),'invalid_state');
  const env=original.environment||{};
  o.environment=pick(env,['sources','pending_queue','visible_item_ids','content_version']);
  o.environment.candidate_pool=(env.candidate_pool||[]).filter(x=>visible(x,o.observed_at)).map(publicItem);
  o.environment.sources=o.environment.sources||[{id:'offline',modes:['search','hot','browse','subscription']}];
  o.environment.pending_queue=o.environment.pending_queue||[];
  o.environment.visible_item_ids=o.environment.visible_item_ids||[];
  // No arbitrary environment/profile field is forwarded: it may contain target-derived features.
  const allowedRefs=new Set();
  if(variant==='no_expression'||variant==='no_behavior') {
    isolateInputs(o,env,variant,input.protocol);
  }
  [...o.dialogue,...o.behavior_events,...o.user_state.records].forEach(x=>x.id&&allowedRefs.add(x.id));
  for(const record of o.user_state.records)for(const ref of record.evidence_refs||[])allowedRefs.add(ref);
  const p={mode:'acquire',top_k:5,require_full_ranking:false,max_model_calls:3,max_tool_calls:10,max_acquired_items:100,max_output_tokens:4096,...input.protocol};
  check(['acquire','fixed_candidates'].includes(p.mode),'invalid_mode');
  for(const key of ['top_k','max_model_calls','max_tool_calls','max_acquired_items','max_output_tokens'])check(Number.isInteger(p[key])&&p[key]>=0,`invalid_${key}`);
  const catalog=(input.catalog||[]).filter(x=>visible(x,o.observed_at)).map(publicItem);
  const pool=new Map(o.environment.candidate_pool.map(x=>[x.id,x]));
  check(pool.size===o.environment.candidate_pool.length,'duplicate_candidate_ids');
  const fixedIds=new Set(pool.keys()),acquired=new Set(),receipts=new Map(),actionHashes=new Map(),pendingAcquisitions=new Map(),reservedTools=new Map();
  const remainingToolCalls=()=>p.max_tool_calls-toolCalls-[...reservedTools.values()].reduce((sum,count)=>sum+count,0);
  const trace=[],history=clone(o.user_state.history||[]); let toolCalls=0,ranking=[],ended=false,activeAcquisitions=0;
  function evidenceChannels(ref){
    const channels=new Set();
    const add=(row,channel)=>{if(!row)return;channels.add(channel);for(const value of row.source_channels||row.provenance?.channels||[])channels.add(value);if(channel==='behavior'&&['comment','correction','instruction','user_expression'].includes(row.type))channels.add('expression');};
    const addRaw=id=>{add(o.dialogue.find(row=>row.id===id),'expression');add(o.behavior_events.find(row=>row.id===id),'behavior');};
    addRaw(ref);
    for(const record of o.user_state.records.filter(row=>row.id===ref||row.evidence_refs?.includes(ref)))for(const channel of record.source_channels||record.provenance?.channels||[])channels.add(channel);
    if(receipts.has(ref)){
      channels.add('tool');const result=receipts.get(ref).result;
      for(const id of [...(result?.dialogue_ids||[]),...(result?.behavior_event_ids||[])])addRaw(id);
    }
    return channels;
  }
  function snapshot(){
    const toolResults=[...receipts.values()].map(receipt=>{
      const copy=clone(receipt);
      // Full retrieved content already appears exactly once in candidate_pool.
      // Preserve full receipts in the execution trace, but reference IDs here.
      if(copy.result?.items){copy.result.item_ids=copy.result.items.map(x=>x.id);delete copy.result.items;}
      return copy;
    });
    return {...clone(o),user_state:clone(o.user_state),environment:{...clone(o.environment),candidate_pool:[...pool.values()].map((item,index)=>({...clone(item),candidate_index:index+1})),tool_results:toolResults,pending_acquisitions:[...pendingAcquisitions.values()].map(clone),budget:{max_tool_calls:p.max_tool_calls,remaining_tool_calls:remainingToolCalls(),max_acquired_items:p.max_acquired_items,remaining_acquired_items:p.max_acquired_items-acquired.size},recommendation_constraints:{mode:p.mode,top_k:p.top_k,require_full_ranking:p.require_full_ranking,candidate_count:pool.size,candidate_index_range:[1,pool.size],allowed_candidate_indices:Array.from({length:pool.size},(_,index)=>index+1),acquire_enabled:variant!=='no_acquire'&&(p.mode!=='fixed_candidates'||!!acquire),state_update_enabled:variant!=='frozen_state',history_lookup_enabled:!!lookupHistory}}};
  }
  function validateAcquire(a){
    check(Number.isInteger(a.limit)&&a.limit>0,'invalid_acquire_limit');
    check(Array.isArray(a.source_ids)&&a.source_ids.length>0,'source_ids_required');
    for(const sourceId of a.source_ids){
      const source=o.environment.sources.find(s=>s.id===sourceId);check(source&&source.modes.includes(a.mode),'unsupported_source_or_mode');
      if(a.content_types!==undefined&&(!Array.isArray(a.content_types)||a.content_types.some(type=>typeof type!=='string'||(source.content_types&&!source.content_types.includes(type)))))
        rankingError('unsupported_content_types',{source_id:sourceId,allowed_content_types:source.content_types||[],message:'content_types selects media formats; put topics in query.'});
    }
  }
  function validateStateEvidence(record,dependencies=new Set()){
    const refs=record?.evidence_refs;
    const unknown=Array.isArray(refs)?refs.filter(ref=>!allowedRefs.has(ref)&&!receipts.has(ref)&&!dependencies.has(ref)):[];
    if(!Array.isArray(refs)||!refs.length||unknown.length)rankingError('state_evidence_missing',{record_id:record?.id,unknown_evidence_refs:unknown,message:'Use exact visible evidence IDs, or retrieve the supporting history before citing it.'});
  }
  function validateStructure(decision){
    if(!decision||decision.decision_id!==o.decision_id||!Array.isArray(decision.actions)||!decision.actions.length)
      rankingError('invalid_decision',{expected_decision_id:o.decision_id,received_decision_id:decision?.decision_id,required_actions:'A nonempty actions array.'});
    const actions=decision.actions,ids=new Set(actions.map(action=>action?.action_id));
    const kinds=['acquire','lookup_history','recommend','update_state','respond','idle'];
    if(ids.size!==actions.length||!actions.every(a=>a&&typeof a.action_id==='string'&&a.action_id&&kinds.includes(a.kind)&&a.arguments&&typeof a.arguments==='object'&&!Array.isArray(a.arguments)&&Array.isArray(a.depends_on)&&Array.isArray(a.evidence_refs)))
      rankingError('invalid_actions',{required:'Unique action_id, a supported kind, an arguments object, and depends_on/evidence_refs arrays.',allowed_kinds:kinds});
    for(const a of actions)if(!a.depends_on.every(id=>id!==a.action_id&&(ids.has(id)||receipts.has(id))))
      rankingError('invalid_dependency',{action_id:a.action_id,message:'Dependencies must reference another action in this response or a completed action.'});
    const pending=new Set(ids);
    while(pending.size){
      const ready=actions.filter(a=>pending.has(a.action_id)&&a.depends_on.every(id=>!pending.has(id)));
      if(!ready.length)rankingError('dependency_cycle',{action_ids:[...pending],message:'Remove cyclic dependencies; independent actions need no dependency.'});
      for(const action of ready)pending.delete(action.action_id);
    }
  }
  function validateRecommendation(a){
      let ids=a.ordered_item_ids;
      const candidateIds=[...pool.keys()],indexById=new Map(candidateIds.map((id,index)=>[id,index+1]));
      const bounds={candidate_count:pool.size,candidate_index_range:[1,pool.size],required_count:p.require_full_ranking?fixedIds.size:null,max_count:p.require_full_ranking?fixedIds.size:p.top_k};
      if(!ids&&Array.isArray(a.ordered_candidate_indices)){
        const indices=a.ordered_candidate_indices;
        const byIndex=new Map(candidateIds.map((id,index)=>[index+1,id]));
        let kept=indices;
        const over=p.mode==='fixed_candidates'&&p.require_full_ranking;
        if(over&&indices.some(index=>Number.isInteger(index)&&index>pool.size)){
          const retained=indices.filter(index=>!(Number.isInteger(index)&&index>pool.size));
          const complete=retained.length===pool.size&&new Set(retained).size===pool.size;
          if(complete&&retained.every(index=>Number.isInteger(index)&&byIndex.has(index)))kept=retained;
        }
        const known=index=>Number.isInteger(index)&&byIndex.has(index);
        if(kept.length&&kept.every(known))ids=kept.map(index=>byIndex.get(index));
        if(ids){a.ordered_item_ids=ids;delete a.ordered_candidate_indices;}
      }
      if(!ids&&a.ordered_candidate_indices!==undefined){
        const indices=Array.isArray(a.ordered_candidate_indices)?a.ordered_candidate_indices:[];
        rankingError('invalid_candidate_indices',{...bounds,received_count:Array.isArray(a.ordered_candidate_indices)?indices.length:null,
          invalid_indices:indices.filter(index=>!Number.isInteger(index)||index<1||index>pool.size),
          duplicate_indices:[...new Set(indices.filter((index,position)=>indices.indexOf(index)!==position))],
          missing_indices:p.require_full_ranking?candidateIds.map((_,index)=>index+1).filter(index=>!indices.includes(index)):[]});
      }
      const values=Array.isArray(ids)?ids:[],unique=new Set(values);
      const duplicates=[...new Set(values.filter((id,index)=>values.indexOf(id)!==index))];
      const missing=p.require_full_ranking?[...fixedIds].filter(id=>!unique.has(id)):[];
      const details={...bounds,received_count:Array.isArray(ids)?ids.length:null,unknown_item_ids:values.filter(id=>!pool.has(id)),
        duplicate_item_ids:duplicates,duplicate_indices:duplicates.filter(id=>indexById.has(id)).map(id=>indexById.get(id)),
        missing_item_ids:missing,missing_indices:missing.map(id=>indexById.get(id))};
      if(!Array.isArray(ids)||!ids.length||unique.size!==ids.length)rankingError('invalid_ranking',details);
      if(details.unknown_item_ids.length)rankingError('unacquired_recommendation',details);
      if(p.require_full_ranking){if(ids.length!==fixedIds.size||!ids.every(id=>fixedIds.has(id)))rankingError('incomplete_ranking',details);}
      else if(ids.length>p.top_k)rankingError('too_many_recommendations',details);
      if(!['append','replace_pending'].includes(a.delivery))rankingError('invalid_delivery',{...details,allowed_deliveries:['append','replace_pending']});
  }
  function validateDecision(decision){
    validateStructure(decision);
    let requested=0;
    const actions=Array.isArray(decision?.actions)?decision.actions:[],byId=new Map(actions.map(action=>[action?.action_id,action]));
    const waitsForAcquire=ids=>ids.some(id=>{const dependency=byId.get(id);return !receipts.has(id)&&dependency&&(dependency.kind==='acquire'||waitsForAcquire(dependency.depends_on));});
    for(const action of actions){
      if(actionHashes.has(action?.action_id))continue;
      if(action?.kind==='acquire'&&action.arguments){validateAcquire(action.arguments);requested+=action.arguments.source_ids.length;}
      else if(action?.kind==='lookup_history')requested++;
      else if(action?.kind==='recommend'){
        if(!waitsForAcquire(action.depends_on))validateRecommendation(action.arguments);
        else if(!['append','replace_pending'].includes(action.arguments.delivery))rankingError('invalid_delivery',{allowed_deliveries:['append','replace_pending']});
      }
      else if(action?.kind==='update_state'){
        if(!Array.isArray(action.arguments.edits)||action.arguments.edits.some(edit=>!edit||!['upsert','set_status'].includes(edit.op)))
          rankingError('invalid_actions',{action_id:action.action_id,required:'update_state edits must be an array of {op:"upsert",record:{id,kind,key,value,scope,scope_id,status,basis,evidence_refs}} or {op:"set_status",id,status} objects.'});
        const dependencies=new Set();
        const visit=ids=>{for(const id of Array.isArray(ids)?ids:[])if(!dependencies.has(id)){dependencies.add(id);visit(byId.get(id)?.depends_on);}};
        visit(action.depends_on);
        for(const edit of action.arguments.edits)if(edit?.op==='upsert')validateStateEvidence(edit.record,dependencies);
      }
    }
    if(requested>remainingToolCalls())rankingError('tool_budget_exhausted',{requested_tool_calls:requested,remaining_tool_calls:remainingToolCalls(),message:'This response was not executed. Use completed results and issue only requests that fit the remaining allowance.'});
  }
  async function executeOne(action,phase,receipt,waitForAcquisitions){
    const a=action.arguments;
    if(phase)check(action.kind===phase||action.kind==='respond'||action.kind==='lookup_history','fixed_workflow_wrong_phase');
    if(action.kind==='lookup_history'){
      check(typeof lookupHistory==='function','history_lookup_disabled');
      check(typeof a.query==='string'&&Number.isInteger(a.offset)&&a.offset>=0&&Number.isInteger(a.limit)&&a.limit>0&&a.limit<=100,'invalid_history_lookup');
      check(toolCalls<p.max_tool_calls,'tool_budget_exhausted');toolCalls++;
      const result=await lookupHistory(clone(a),{observation:snapshot()});
      for(const field of ['dialogue','behavior_events'])result[field]=(result[field]||[]).filter(row=>visible(row,o.observed_at)&&(row.user_id===undefined||row.user_id===o.user_id)&&(!row.visible_to_policy_id||row.visible_to_policy_id===(input.protocol?.policy_id||variant)));
      if(variant==='no_expression'||variant==='no_behavior'){
        const retrieved={...o,dialogue:result.dialogue,behavior_events:result.behavior_events,user_state:{version:o.user_state.version,records:[]},environment:{...o.environment}};
        isolateInputs(retrieved,{candidate_pool:[]},variant,p);
        result.dialogue=retrieved.dialogue;result.behavior_events=retrieved.behavior_events;
      }
      for(const field of ['dialogue','behavior_events'])for(const row of result[field]||[]){if(!o[field].some(x=>x.id===row.id))o[field].push(clone(row));if(row.id)allowedRefs.add(row.id);}
      return {dialogue_ids:(result.dialogue||[]).map(x=>x.id),behavior_event_ids:(result.behavior_events||[]).map(x=>x.id),next_offset:result.next_offset};
    }
    if(action.kind==='acquire') {
      check(variant!=='no_acquire','acquire_disabled');
      check(p.mode!=='fixed_candidates'||!!acquire,'fixed_candidate_acquire_disabled');
      validateAcquire(a);
      check(toolCalls+a.source_ids.length<=p.max_tool_calls,'tool_budget_exhausted');
      const count=a.source_ids.length; toolCalls+=count; // failures consume reserved subrequests
      // Retain issued queries even if the adapter later fails.
      receipt.result={request:clone(a)};
      pendingAcquisitions.set(action.action_id,{action_id:action.action_id,request:clone(a)});
      const accept=raw=>{
        const items=(raw||[]).filter(x=>visible(x,o.observed_at)).map(publicItem);
        check(items.length<=a.limit,'adapter_limit_violation');
        const newIds=new Set(items.filter(item=>!pool.has(item.id)).map(item=>item.id));
        check(acquired.size+newIds.size<=p.max_acquired_items,'unique_acquisition_budget_exhausted');
        check(p.mode!=='fixed_candidates'||items.every(item=>fixedIds.has(item.id)),'candidate_expansion_forbidden');
        for(const item of items){if(!pool.has(item.id))acquired.add(item.id);pool.set(item.id,item);}return items;
      };
      let part=0;const onItems=raw=>{
        const items=accept(raw);if(!items.length)return;
        const receipt={action_id:`${action.action_id}:partial:${++part}`,parent_action_id:action.action_id,kind:'acquire',status:'success',result:{request:clone(a),items},completed_at:new Date().toISOString()};
        receipts.set(receipt.action_id,receipt);onAction?.(clone(receipt),{pending_acquisitions:activeAcquisitions});
      };
      const result=acquire?await acquire(clone(a),{remaining_tool_calls:count,observation:snapshot(),onItems}):{items:lexicalAcquire(catalog,a),evidence:[],actual_requests:count};
      check(result.actual_requests===undefined||result.actual_requests===count,'adapter_actual_request_mismatch');
      const items=accept(result.items);
      const scores=Object.fromEntries(items.filter(item=>Number.isFinite(result.scores?.[item.id])).map(item=>[item.id,result.scores[item.id]]));
      return {request:clone(a),items,evidence:clone(result.evidence||[]),...(Object.keys(scores).length?{scores}:{}),actual_requests:count};
    }
    if(action.kind==='recommend') {
      validateRecommendation(a);
      const ids=a.ordered_item_ids;
      ranking=[...ids];o.environment.pending_queue=a.delivery==='append'?[...o.environment.pending_queue,...ids]:[...ids];
      return {queued_item_ids:[...ids],delivery:a.delivery,exposure_recorded:false};
    }
    if(action.kind==='update_state') {
      check(variant!=='frozen_state','state_update_disabled');
      check(a.base_version===o.user_state.version,'state_version_conflict');
      check(Array.isArray(a.edits),'state_edits_required');
      const next=clone(o.user_state.records),before=clone(o.user_state);
      for(const edit of a.edits) {
        if(edit.op==='upsert') {
          const r=clone(edit.record);check(r&&typeof r.id==='string'&&r.id,'record_id_required');
          check(['fact','preference','task','constraint','episode'].includes(r.kind),'invalid_record_kind');
          check(['active','completed','expired','superseded'].includes(r.status),'invalid_record_status');
          for(const field of ['key','value','scope','scope_id','basis','evidence_refs'])check(r[field]!==undefined,`record_${field}_required`);
          if(r.scope==='session'&&r.scope_id===null&&o.session_id)r.scope_id=o.session_id;
          validateStateEvidence(r);
          const channels=new Set();
          for(const ref of r.evidence_refs)for(const channel of evidenceChannels(ref))channels.add(channel);
          r.source_channels=[...channels];r.updated_at=o.observed_at||new Date().toISOString();
          const index=next.findIndex(x=>x.id===r.id);if(index>=0)next[index]=r;else next.push(r);
        } else if(edit.op==='set_status') {
          const record=next.find(x=>x.id===edit.id);check(record,'state_record_missing');
          check(['active','completed','expired','superseded'].includes(edit.status),'invalid_record_status');record.status=edit.status;record.updated_at=o.observed_at||new Date().toISOString();
        }else throw new Error('invalid_state_edit');
      }
      history.push({action_id:action.action_id,version:before.version,records:before.records});
      o.user_state={version:before.version+1,records:next,history};next.forEach(x=>allowedRefs.add(x.id));
      return {version:o.user_state.version,edits:clone(a.edits)};
    }
    if(action.kind==='respond'){check(typeof a.text==='string'&&['answer','explain','clarify'].includes(a.kind),'invalid_response');return {response:clone(a)};}
    check(action.kind==='idle'&&['keep','wait','end_task'].includes(a.mode),'invalid_idle');
    // Use the decision's observation too: its pending request may finish while the model answers.
    ended=a.mode!=='wait'||!(waitForAcquisitions||pendingAcquisitions.size);return {mode:a.mode,task_id:a.task_id||null};
  }
  async function execute(decision,{phase,waitForAcquisitions=false}={}) {
    validateStructure(decision);
    const actions=clone(decision.actions);
    if(phase)check(actions.some(a=>a.kind===phase),'fixed_workflow_required_action_missing');
    for(const a of actions)if(actionHashes.has(a.action_id)){
      check(actionHashes.get(a.action_id)===digest(a),'action_id_reuse_with_different_payload');
      check(receipts.has(a.action_id),'action_id_already_in_progress');
    }
    for(const a of actions)if(!actionHashes.has(a.action_id))actionHashes.set(a.action_id,digest(a));
    const acquiringInDecision=actions.some(a=>a.kind==='acquire'&&!receipts.has(a.action_id));
    for(const a of actions)if(!receipts.has(a.action_id)){
      if(a.kind==='acquire'){
        reservedTools.set(a.action_id,Array.isArray(a.arguments.source_ids)?a.arguments.source_ids.length:0);
        pendingAcquisitions.set(a.action_id,{action_id:a.action_id,request:clone(a.arguments)});
      }else if(a.kind==='lookup_history')reservedTools.set(a.action_id,1);
    }
    const pending=[...actions],groups=[];let newActions=0;
    while(pending.length) {
      const ready=pending.filter(a=>a.depends_on.every(id=>receipts.has(id)));
      check(ready.length>0,'dependency_cycle');
      // Synchronous state and queue writes remain ordered; independent acquisitions overlap.
      groups.push(ready.map(a=>a.action_id));
      const acquiring=new Set(ready.filter(a=>a.kind==='acquire'&&!receipts.has(a.action_id)).map(a=>a.action_id));
      const waitingAcquisitions=pending.filter(a=>a.kind==='acquire'&&!ready.includes(a)&&!receipts.has(a.action_id)).length;
      activeAcquisitions+=acquiring.size;
      await Promise.all(ready.map(async a=>{
        pending.splice(pending.indexOf(a),1);
        if(receipts.has(a.action_id)){check(actionHashes.get(a.action_id)===digest(a),'action_id_reuse_with_different_payload');return;}
        newActions++;
        reservedTools.delete(a.action_id);
        let receipt={action_id:a.action_id,kind:a.kind,started_at:new Date().toISOString()};
        if(a.depends_on.some(id=>receipts.get(id).status!=='success'))receipt={...receipt,status:'skipped',error:'dependency_failed'};
        else try {receipt={...receipt,status:'success',result:await executeOne(a,phase,receipt,waitForAcquisitions||acquiringInDecision)};}catch(e){receipt={...receipt,status:'failed',error:e.message,...(e.details?{error_details:e.details}:{})};}
        pendingAcquisitions.delete(a.action_id);receipt.completed_at=new Date().toISOString();receipts.set(a.action_id,receipt);actionHashes.set(a.action_id,digest(a));if(acquiring.delete(a.action_id))activeAcquisitions--;onAction?.(clone(receipt),{pending_acquisitions:activeAcquisitions+waitingAcquisitions});
      }));
    }
    const step={decision:clone(decision),dispatch_groups:groups,execution_results:actions.map(a=>clone(receipts.get(a.action_id))),state_after:clone(o.user_state),new_actions:newActions};trace.push(step);return step;
  }
  return {snapshot,execute,validateDecision,protocol:p,get result(){return {ordered_item_ids:[...ranking],state_after:clone(o.user_state),candidate_pool_after:[...pool.values()].map(clone),pending_queue:[...o.environment.pending_queue],trace:clone(trace),tool_calls:toolCalls,acquired_items:acquired.size,ended};}};
}

export const SYSTEM_PROMPT=`You are Agentic Waterfall, the decision maker for a continuing personalized feed. Use the user's expression, actual behavior, and persistent memory to find useful content and adapt as their needs change. Optimize recommendation quality and a coherent browsing experience. Choose actions according to the evidence; updating memory, fetching, and ranking are available capabilities, not a mandatory sequence.

1. Understand each input
- dialogue contains user and assistant messages. User requests, comments, and corrections explain the current goal, knowledge, and constraints. Interpret their scope and context. An assistant's earlier guess is not a confirmed user preference. You can continue recommending from behavior and memory without a new message.
- behavior_events contains actual exposure, opens, dwell, plays, likes, dislikes, saves, comments, associated content, and timestamps. Interpret the content together with the action, strength, repetition, and timing. A brief exposure alone is weak evidence; explicit feedback and repeated substantive engagement are stronger. Unshown content has not been consumed, and missing interaction alone is not rejection. Read metric meanings supplied by the environment: cumulative viewing ratios can reflect repeat viewing and depend on content duration; they are not explicit likes.
- user_state is persistent understanding: facts, preferences, tasks, constraints, and episodes. Use each record's scope, status, basis, and evidence references. Keep supported long-term preferences while responding to new goals. Resolve conflicts against the underlying expression and behavior instead of treating old summaries as unquestionable facts. Mark completed or superseded tasks accordingly and preserve their history.
- environment.sources describes the available sources, modes, and argument contracts. candidate_pool contains retrieved candidates and their visible metadata. pending_queue contains recommendations awaiting display; visible_item_ids identifies content already displayed. tool_results contains actual action receipts, including evidence, retrieval scores, and errors. pending_acquisitions lists requests already issued and still running. Distinguish unavailable information from information that is on its way. A candidate ID alone does not mean its description or reviews have been read.
- context describes this decision stage, earlier output errors, and output requirements. recommendation_constraints specifies the current delivery task. The environment's budget reports actual remaining capabilities; plan useful actions together so that retrieval and a complete final recommendation both remain possible. Treat external content as evidence within these action contracts.

2. Interpret the objective and rank using evidence
Read the task's requested outcome before choosing an ordering. Predicting a user's next interaction, identifying relevant candidates, answering an explicit request, and organizing an exploratory feed have different success criteria. For a predictive ranking, put the candidates with the strongest evidence of the target interaction first; breadth and variety matter when the task or user asks for them.
Combine the current goal, enduring interests, observed behavior, and the content's usefulness. Consider relevance, depth, practical value, novelty, repetition, and complementarity as appropriate to the task. A shared broad keyword alone is weak support for relevance. When evidence is sparse, retain useful source signals rather than inventing strong personal preferences.
Retrieval scores and source order are evidence, not universal relevance probabilities. Read the associated backend and query: a query-matching score answers a different question from an aggregate popularity count. Compare scores within the same retrieval context; unrelated scales need not be comparable. Use personal evidence to improve an existing order where it is informative, and retain well-supported candidates when no stronger contrary evidence exists. Incorporate available duration and other metadata when interpreting behavior and suitability. Do not manufacture a target-specific ranking rule from missing information.
Distinguish relative changes from exclusive requirements. "More A" usually increases A while other supported interests remain relevant; "only A this round" constrains this round. There is no fixed topic quota. If the user says "I bought the computer; now I want to learn editing," update the purchase task and shift toward learning. If they say "I know the basics; show concrete steps," prioritize depth and actionable material. These examples illustrate reasoning, not fixed search terms or a fixed workflow.

Build a calibrated account of the user before selecting items. Separate what was presented or consumed from how the user responded. Frequent exposure alone establishes familiarity, not strong preference. Compare the strength of response across observations, including repeated engagement, weak responses, and explicit negative feedback. Interpret each signal using its declared meaning: a low behavioral value is not automatically an explicit rejection. Compare responses to similar items and consider how format, duration, timing, and circumstances could explain differences. Small samples support tentative preferences; contradictory observations should reduce confidence rather than disappear from the account.
When task_instructions provides descriptive behavior statistics, use the counts, denominators, distributions, time ranges, and record references to check impressions against the complete raw history. Statistics describe observed behavior, not causal preference or guaranteed outcomes. Use the underlying records to understand what was actually consumed and to distinguish subtopics, creators, purposes, and presentation styles. A concise memory should preserve these distinctions and uncertainties instead of turning every encountered category into a strong interest.
Compare candidates at the level where the evidence distinguishes them. For each plausible choice, identify which available user observations support it, which observations weaken that match, what its content actually offers, and what remains unknown. A category match is a starting point: compare finer content attributes, intent, format, depth, and relevant context. Strong evidence about one attribute does not automatically support every item sharing it. Decide how these differences relate to the requested outcome before determining the order.
Compare across the complete candidate pool, including different queries, sources, and later arrivals. Display position, numeric identifiers, and arrival order are bookkeeping, not user preference. Keep the original retrieval context and scores in view, but distinguish query relevance from personalized suitability. Assess candidates from different parts of the pool on the same evidence criteria. Similar candidates still need an evidence-based ordering; neither keeping their input order nor reversing it by default resolves uncertainty.
Before committing the slate, compare the strongest omitted alternatives with its weakest selected items and reconsider unsupported placements. Check that the relative order reflects the task objective and the evidence, rather than the order in which candidates were read. When evidence cannot distinguish two items confidently, preserve that uncertainty instead of inventing a personal rationale. Ground recommend action evidence_refs in the visible records or tool receipts actually used. Choose the strongest matches before deciding the final slate's variety.

3. Fetch, inspect, deliver, and rerank
A personalized decision needs evidence about the user as well as the items. If behavior and memory are empty while a source provides user reviews or history, retrieve that evidence. A user record containing only an identifier is a pointer, not a preference profile. Read declared initial_evidence and coverage fields to recognize evidence already preloaded, evidence still available through tools, and sources that actually returned no records.
Build searches from specific supported needs and the terms used by the source. Examine returned content for relevance, useful distinctions, repetition, and gaps before deciding whether to refine a query or explore another supported interest. When initial matches are broad or uninformative, targeted follow-up searches can improve the comparison set. Once the evidence and candidates support a sound decision, recommend directly. No fixed number of searches, topic quota, or compulsory action sequence is required.
Use acquire when you need new content, the pool is insufficient, visible metadata is inadequate, the current material no longer fits, or continued browsing needs replenishment. Fetch enough useful candidates and supporting evidence to make a sound choice. Inspect tool_results before repeating a request: completed metadata and review responses remain available there. Choose sources, modes, queries, and limits according to their declared contracts. content_types means media formats such as video or article, not topics; put topics in query. For a browse tool, use its documented target_id or query structure.
When candidates and evidence are sufficient, recommend directly. Rerank pending content after a new request, meaningful behavior, a changed goal, or new evidence. Metadata or reviews for an existing ID can change the ranking even when no new IDs arrive. Distinguish the pending queue from already consumed content.
Independent actions can share a response: for example, update a task while searching, fetch from multiple sources, or deliver known candidates while fetching more. A ranking that depends on new information should be decided after you observe the actual return. With partial returns, you may deliver a useful interim slate or choose idle/wait; when the remaining results arrive, reassess the full evidence and deliver the final slate. A failed request includes an actual error: use the diagnostic to correct the action with a new ID or use an available alternative. An empty result is evidence to adjust the query or source.
Use idle/keep when retaining the current queue is the appropriate completed decision, idle/wait to await in-flight information or further interaction, and idle/end_task when the task is complete or explicitly ended. Waiting for an issued request is not abandoning the task. For a requested ranking, complete that ranking after obtaining the evidence needed to judge it.

4. Maintain and consult memory
Use update_state when new evidence changes a fact, preference, task, constraint, or meaningful episode. If existing state is accurate, you can fetch or recommend without rewriting it. Distinguish explicit user statements, observed behavior, and inferred conclusions through basis values explicit, observed, and inferred.
Use the current user_state.version as base_version. Include scope and evidence references. Visible raw record IDs, existing memory IDs, successful tool action IDs, and historical evidence references already attached to persisted memory may support an update. Preserve changes through the state history; express completion, expiration, or replacement through status.
Use lookup_history when earlier expression, behavior, or supporting evidence could resolve an uncertainty. Use each source’s declared coverage to distinguish already loaded records from additional history available through that source. query may be empty; offset starts at 0, and next_offset allows continuation. Returned records become available in dialogue and behavior_events. Recheck a summary against the underlying evidence when necessary.

5. Task and output contract
For an open feed, acquire and organize the appropriate next slate. In fixed_candidates mode, work within the given set and use enabled tools to enrich it. If require_full_ranking is true, rank every candidate exactly once; otherwise deliver according to top_k and the task's stated requested count. Acquisition quantity and delivery quantity are different. Fixed-candidate ranking does not require imposing an open-feed topic mix.
Return a complete JSON object:
{"decision_id":"the supplied decision ID","actions":[{"action_id":"a unique action ID within this episode","kind":"action type","arguments":{},"evidence_refs":[],"depends_on":[]}]}
Action IDs identify actions and dependencies. depends_on can reference earlier successful actions or actions in this response. Independent actions need no artificial dependency. Read errors and use new IDs for corrected actions.
- acquire: {source_ids:[source ID],mode:"supported source mode",query:"query text or null",target_id:"optional target ID",content_types:[media format],limit:positive integer}. Each selected source consumes one tool request. Source-specific argument and response contracts are listed in sources.
- lookup_history: {query:"query text",offset:nonnegative integer,limit:integer from 1 to 100}.
- recommend: {ordered_candidate_indices:[actual candidate_index values],delivery:"replace_pending" or "append"}. Copy the actual candidate_index field from each selected candidate. The id and item_id fields identify content and are not output indices. Include delivery explicitly. Output order is recommendation order; use candidates that have actually returned. For the final delivery, follow the count in context.output_requirements.recommendation_contract; interim slates may be shorter while acquisitions are pending. Check the complete list for repeated or missing indices before returning it.
- update_state: {base_version:current version,edits:[edit]}. An edit is {op:"upsert",record:{id,kind,key,value,scope,scope_id,status,basis,evidence_refs}} or {op:"set_status",id,status}. Record kind is fact, preference, task, constraint, or episode; status is active, completed, expired, or superseded.
- respond: {kind:"answer" or "explain" or "clarify",text:"concise user-facing text in the user's language"}. Answer or explain when useful, and ask only for missing information that materially affects the recommendation.
- idle: {mode:"keep" or "wait" or "end_task",task_id:"associated task ID or null"}.
Ground recommendations in the actual content and available evidence. Hidden future interactions and evaluation labels are not inputs. No self-assigned evaluation score is required.

Evidence-conditioned acquisition: Treat a search query as a hypothesis about useful content. When the catalog is unfamiliar, obtain an initial set and inspect the actual returned content before deciding the remaining queries and quantities. Leave acquisition capacity available for decisions informed by those returns. Compare the first matches with the user evidence, refine weak or repetitive matches, and seek alternatives to weak prospective recommendations. Choose the initial quantity, subsequent quantities, and whether another round is useful from the observed evidence; there is no fixed topic quota or fixed number of rounds. Independent metadata reads may still run together. When the current candidates support the requested decision, deliver the ranking.
`;

function currentRequirements(observation){
  if(observation.environment.recommendation_constraints.mode!=='acquire')return null;
  const records=observation.user_state.records.filter(r=>r.status==='active'&&(r.kind==='task'||r.kind==='constraint')&&
    (r.scope!=='session'||!r.scope_id||r.scope_id===observation.session_id));
  return digest(records.sort((a,b)=>String(a.id).localeCompare(String(b.id))).map(r=>[r.id,r.kind,r.key,r.value,r.scope,r.scope_id]));
}

const feedRequirementGuidance=' For an open feed, use the strongest supported current task and applicable constraints to drive search and ranking. When a request or sustained behavior changes what to serve now, record the new purpose as a task; retain older interests and mark completion only when supported. Write material changes first and decide dependent searches or recommendations after the state update returns. Review the pending queue under the new requirements. Independent actions can still run together.';

export async function runEpisode(input,{experiment,variant='full',decide,acquire,lookupHistory,onAction,modelCall,systemPrompt=SYSTEM_PROMPT,taskInstructions}={}) {
  const start=Date.now(),modelCalls=[],normalizations=[];let error=null,callsIssued=0,partialTask=null,partialAttempted=false,formatFeedback=null,runtime;
  const phases=variant==='fixed_workflow'?['update_state','acquire','recommend']:null;
  const actionInputs=new Map();let recommendation,ending;
  const acquiredEvidence=observation=>observation.environment.tool_results.filter(r=>r.kind==='acquire'&&r.status==='success').map(r=>r.action_id);
  const reviewedOutput=(result,snapshot)=>{
    const requirements=currentRequirements(snapshot);
    const stop=result.ended&&ending?.requirements===requirements;
    const slate=result.ordered_item_ids.length>0&&(recommendation?.requirements===requirements||stop&&ending.mode==='keep');
    return {stop,slate};
  };
  runtime=createRuntime(input,{variant,acquire,lookupHistory,onAction:(receipt,progress)=>{
    if(receipt.kind==='recommend'&&receipt.status==='success')recommendation=actionInputs.get(receipt.action_id);
    if(receipt.kind==='idle'&&receipt.status==='success')ending={...actionInputs.get(receipt.action_id),mode:receipt.result.mode};
    onAction?.(receipt,progress);
    if(!phases&&!partialAttempted&&!partialTask&&receipt.kind==='acquire'&&receipt.status==='success'&&receipt.result?.items?.length&&progress.pending_acquisitions>0&&callsIssued+1<runtime.protocol.max_model_calls){
      partialAttempted=true;partialTask=perform(undefined,true).catch(error=>{const call=modelCalls.findLast(entry=>entry.context?.other_acquisitions_pending);if(call&&!call.error)call.error=error.message;});
    }
  }});
  const messagesFor=(observation,context,extra='')=>[{role:'system',content:systemPrompt+extra},{role:'user',content:JSON.stringify({observation,context:{...context,...(taskInstructions?{task_instructions:taskInstructions}:{}),...(formatFeedback?{previous_output_error:formatFeedback}:{}),output_requirements:{candidate_count:observation.environment.candidate_pool.length,recommendation_contract:{order_field:'ordered_candidate_indices',count:observation.environment.recommendation_constraints.require_full_ranking?observation.environment.candidate_pool.length:runtime.protocol.top_k,delivery:['replace_pending','append'],instruction:'Copy candidate_index values from the current candidate_pool. Supply delivery explicitly and every index once. The id and item_id fields are not candidate indices.'},recommendation:`${observation.environment.recommendation_constraints.mode==='fixed_candidates'?'Rank the supplied candidates using visible history and candidate evidence.':'Update the next feed slate using current requirements and supported interests; distinguish relative adjustments from exclusive requests.'} Use only allowed_candidate_indices for ordered_candidate_indices. ${observation.environment.recommendation_constraints.require_full_ranking?'Include every listed candidate index exactly once.':'Follow top_k for the delivery count.'} Return complete action JSON.`}}})}];
  async function requestDecision(observation,context,extra){
    const feedback=formatFeedback,messages=messagesFor(observation,context,extra);
    const entry={input:observation,context,messages};modelCalls.push(entry);let receipt;
    try{receipt=await modelCall({messages,temperature:0.3,max_tokens:runtime.protocol.max_output_tokens,response_format:{type:'json_object'}},{experiment});}
    catch(e){Object.assign(entry,e.receipt,{error:e.message});throw e;}
    Object.assign(entry,receipt);let decision;
    if(receipt.finish_reason==='length')entry.error='model_output_truncated';
    else try{decision=JSON.parse(receipt.content);}catch{entry.error='model_invalid_json';}
    if(entry.error){
      formatFeedback={error:entry.error,call_index:context.call_index,message:'No actions from this response were executed. Return complete JSON with allowed candidate indices and new action IDs.'};
      throw Object.assign(new Error(entry.error),{recoverableModelFormat:true});
    }
    if(formatFeedback===feedback)formatFeedback=null;
    entry.parsed_output=decision;return decision;
  }
  async function perform(phase,partial=false){
    const observation=runtime.snapshot(),index=callsIssued++,feedback=formatFeedback;let executionIndex=index;
    const context={variant,phase,call_index:index,remaining_model_calls:runtime.protocol.max_model_calls-index,...(index===runtime.protocol.max_model_calls-1?{final_decision:'This is the final decision call. Complete the requested recommendation using the observed evidence; new acquisitions cannot be reviewed by another decision.'}:{}),...(formatFeedback?{previous_output_error:formatFeedback}:{}),...(partial?{other_acquisitions_pending:true}:{})};
    let decision,entry;
    if(decide){entry={origin:'scripted_fixture',input:observation,context};modelCalls.push(entry);decision=await decide(clone(observation),context);entry.parsed_output=clone(decision);}
    else {
      check(typeof modelCall==='function','model_transport_required');
      const extra=phase?` Fixed-workflow ablation: execute the ${phase} phase; responses and history lookups may accompany it. Use edits:[] if no state changes are needed; acquire in the acquisition phase.`:partial?' Other acquisitions are still pending. Recommend useful known content or wait for the remaining evidence.':'';
      try{
        const constraints=observation.environment.recommendation_constraints;
        const guidance=!phase&&constraints.mode==='acquire'&&constraints.state_update_enabled?feedRequirementGuidance:'';
        decision=await requestDecision(observation,context,extra+guidance);
      }catch(e){if(!e.recoverableModelFormat||phase)throw e;return {model_format_error:e.message,new_actions:0,execution_results:[]};}
    }
    const normalized=normalizeDecision(decision,observation.environment.candidate_pool);normalizations.push(...normalized.repairs.map(r=>({...r,call_index:executionIndex})));
    const registered=[],review={requirements:currentRequirements(observation),evidence:new Set(acquiredEvidence(observation))};
    for(const action of Array.isArray(normalized.decision?.actions)?normalized.decision.actions:[])if(['recommend','idle'].includes(action?.kind)&&!actionInputs.has(action.action_id)){
      actionInputs.set(action.action_id,review);registered.push(action.action_id);
    }
    let step;
    try{runtime.validateDecision(normalized.decision);step=await runtime.execute(normalized.decision,{phase,waitForAcquisitions:observation.environment.pending_acquisitions.length>0});}catch(e){
      if(!['action_id_reuse_with_different_payload','action_id_already_in_progress','unsupported_content_types','unsupported_source_or_mode','source_ids_required','invalid_acquire_limit','tool_budget_exhausted','state_evidence_missing','invalid_decision','invalid_actions','invalid_dependency','dependency_cycle','invalid_candidate_indices','invalid_ranking','unacquired_recommendation','incomplete_ranking','too_many_recommendations','invalid_delivery'].includes(e.message))throw e;
      for(const id of registered)actionInputs.delete(id);
      const call=modelCalls.findLast(x=>x.context?.call_index===executionIndex);if(call){call.error=e.message;call.error_details=e.details;}
      formatFeedback={error:e.message,call_index:executionIndex,...(e.details?{error_details:e.details}:{}),message:'No actions from this response were executed. Correct the reported issue and regenerate the decision with new action IDs.'};
      return {model_format_error:e.message,new_actions:0,execution_results:[]};
    }
    step.call_index=executionIndex;step.normalizations=normalized.repairs;
    const failed=step.execution_results.filter(receipt=>receipt.status==='failed');
    if(failed.length){const call=modelCalls.findLast(entry=>entry.context?.call_index===executionIndex);if(call){call.execution_errors=clone(failed);call.error=failed[0].error;call.error_details=failed[0].error_details;}}
    if(decide&&formatFeedback===feedback)formatFeedback=null;
    if(step.execution_results.some(r=>r.status==='failed')&&!step.execution_results.some(r=>r.status==='success')&&!step.execution_results.every(recoverableRankingFailure))throw new Error('action_execution_failed');
    if(phase)check(step.execution_results.some(r=>r.kind===phase&&r.status==='success'),'fixed_workflow_required_action_failed');
    return step;
  }
  try {
    for(let i=0;callsIssued<runtime.protocol.max_model_calls;i++){
      if(phases&&i>=phases.length)break;
      const beforeAcquired=runtime.result.acquired_items,beforeHistory=runtime.snapshot().dialogue.length+runtime.snapshot().behavior_events.length;
      partialAttempted=false;partialTask=null;
      const step=await perform(phases?.[i]);
      if(partialTask)await partialTask;
      if(step.model_format_error||formatFeedback)continue;
      const result=runtime.result,snapshot=runtime.snapshot(),afterHistory=snapshot.dialogue.length+snapshot.behavior_events.length;
      // Known-item enrichment adds evidence without increasing the acquired-ID count.
      const unseenEvidence=acquiredEvidence(snapshot).some(id=>!recommendation?.evidence.has(id));
      const review=reviewedOutput(result,snapshot);
      if(review.stop||(review.slate&&!unseenEvidence&&result.acquired_items===beforeAcquired&&afterHistory===beforeHistory&&!step.execution_results.some(recoverableRankingFailure)))break;
      if(!step.new_actions){error='no_progress';break;}
    }
  }catch(e){error=e.message;}
  const result=runtime.result,snapshot=runtime.snapshot(),review=reviewedOutput(result,snapshot);
  const outdated=(result.ended&&!review.stop)||(result.ordered_item_ids.length>0&&!review.slate);
  if(!review.stop)result.ended=false;
  if(!review.slate)result.ordered_item_ids=[];
  if(!error&&outdated&&!result.ended&&!result.ordered_item_ids.length)error='model_call_budget_exhausted_with_unreviewed_requirements';
  if(!error&&!result.ended&&result.ordered_item_ids.length&&acquiredEvidence(snapshot).some(id=>!recommendation?.evidence.has(id)))error='model_call_budget_exhausted_with_unreviewed_evidence';
  if(!error&&['action_id_reuse_with_different_payload','action_id_already_in_progress'].includes(formatFeedback?.error))error=formatFeedback.error;
  const continuationError=error&&result.ordered_item_ids.length?error:null;if(continuationError)error=null;
  if(!error&&!result.ordered_item_ids.length&&!result.ended)error='model_call_budget_exhausted_without_submission';
  return {runtime_version:VERSION,runtime_source_sha256:SOURCE_SHA256,variant,decision_id:input.observation.decision_id,status:error?'failed':result.ordered_item_ids.length?'submitted':'idle',error,continuation_error:continuationError,...result,normalizations,model_calls:modelCalls,model_request_count:decide?0:modelCalls.filter(x=>x.attempt_id).length,origin:decide?'synthetic_scripted_contract_test':'llm',input_sha256:digest(input),duration_ms:Date.now()-start};
}
