import {demoInput} from './unified-input.mjs';
import {runEpisode} from './waterfall-core.mjs';
import {randomUUID} from 'node:crypto';
import {acquire,id,hash,check} from './core.mjs';
import {readModelResponse} from './model-response.mjs';

export function demoModelCall(config,signal,{thinkingMode}={}){
 return async request=>{
  const attempt_id=randomUUID(),started_at=new Date().toISOString();
  const parameters={...config.requestParameters,...(thinkingMode==='enabled'&&config.requestParameters?.thinking?{enable_thinking:true,thinking:{type:'enabled'},extra_body:{...config.requestParameters.extra_body,thinking:{type:'enabled'}}}:{}),stream:true,stream_options:{include_usage:true}};
  const body={model:config.model,...parameters,...request};
  try{
   const timeout=AbortSignal.timeout(Math.max(config.timeoutMs||60000,600000));
   const signals=[signal,config.signal,timeout].filter(Boolean);
   const response=await fetch(config.endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.key}`},body:JSON.stringify(body),signal:signals.length>1?AbortSignal.any(signals):timeout});
   if(!response.ok){
    const response_body=(await response.text()).split(config.key).join('[REDACTED]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]');
    throw Object.assign(Error(`model_http_${response.status}`),{http_status:response.status,response_body});
   }
   const result=await readModelResponse(response),content=result.choices?.[0]?.message?.content,finish_reason=result.choices?.[0]?.finish_reason||null;
   if(typeof content!=='string')throw Error('model_missing_content');
   return {attempt_id,status:'success',requested_model:config.model,provider_response_model:result.model||null,content,...(typeof result.choices?.[0]?.message?.reasoning_content==='string'?{reasoning_content:result.choices[0].message.reasoning_content}:{}),...(result.stream_metadata?{stream_metadata:result.stream_metadata}:{}),usage:result.usage||null,finish_reason,request_settings:{...parameters,temperature:body.temperature,max_tokens:body.max_tokens},started_at,completed_at:new Date().toISOString()};
  }catch(error){
   error.receipt={attempt_id,status:'failed',error:error.message,requested_model:config.model,...(error.http_status?{http_status:error.http_status,response_body:error.response_body}:{}),...(error.partialResponse?{partial_response:error.partialResponse,stream_diagnostic:error.streamDiagnostic}:{}),request_settings:{...parameters,temperature:body.temperature,max_tokens:body.max_tokens},started_at,completed_at:new Date().toISOString()};throw error;
  }
 };
}

export async function runDemo(snapshot,{userId,sessionId,modelCall,acquireSource,lookupHistory,onAction,topK=1000}){
 check(Number.isInteger(topK)&&topK>0&&topK<=1000,'topK must be an integer from 1 to 1000');
 const input=demoInput(snapshot,{userId,sessionId});
 let historyReads=0;
 if(lookupHistory){
  const seen=Object.fromEntries(['dialogue','behavior_events'].map(field=>[field,new Set(input.observation[field].map(row=>row.id))]));
  for(let offset=0;;){
   const page=await lookupHistory({query:'',offset,limit:100},{observation:input.observation});historyReads++;
   for(const field of ['dialogue','behavior_events'])for(const row of page[field]||[])if(!seen[field].has(row.id)){input.observation[field].push(structuredClone(row));seen[field].add(row.id);}
   if(page.next_offset==null)break;
   check(Number.isInteger(page.next_offset)&&page.next_offset>offset,'invalid_history_pagination');offset=page.next_offset;
  }
 }
 input.protocol={mode:'acquire',top_k:topK,max_model_calls:20,max_tool_calls:20,max_acquired_items:1000,max_output_tokens:32768};
 const original=new Map(input.observation.user_state.records.map(record=>[record.id,JSON.stringify(record)]));
 const items=new Map((snapshot.candidate_pool||[]).map(item=>[item.id,structuredClone(item)]));
 const acquire=async(args,context)=>{
  const found=[],seen=new Set();let remaining=args.source_ids.length;
  const results=await Promise.all(args.source_ids.map(async source=>{
   const result=await acquireSource(source,args,context);remaining--;
   const fresh=(result.items||[]).filter(item=>!seen.has(item.id)).slice(0,Math.max(0,args.limit-found.length));
   fresh.forEach(item=>{seen.add(item.id);items.set(item.id,item);found.push(item);});
   if(remaining&&fresh.length)context.onItems(fresh.map(item=>({id:item.id,title:item.title,abstract:item.summary,source_id:item.source,content_type:item.modality,url:item.url,content_hash:item.content_hash,published_at:item.published_at})));
   return result;
  }));
  const successes=results.filter(result=>result.status!=='failed');
  if(!successes.length)throw Error('all_sources_failed');
  return {items:found.map(item=>({id:item.id,title:item.title,abstract:item.summary,source_id:item.source,content_type:item.modality,url:item.url,content_hash:item.content_hash,published_at:item.published_at})),evidence:results.map(({items,...rest})=>rest),actual_requests:args.source_ids.length};
 };
 const runtime=await runEpisode(input,{modelCall,acquire,lookupHistory,onAction:onAction?(receipt,progress)=>onAction(receipt,{...progress,items:[...items.values()],slate:(receipt.result?.queued_item_ids||[]).map(id=>items.get(id)).filter(Boolean)}):undefined});
 runtime.preparation_history_reads=historyReads;
 if(runtime.status==='failed')throw Object.assign(new Error(`本轮推荐未完成：${runtime.error}`),{status:502,runtime});
 const state=structuredClone(snapshot.state);
 if(runtime.state_after.version!==state.version){
  state.version=runtime.state_after.version;
  state.entries=runtime.state_after.records.flatMap(record=>{
   if(original.get(record.id)===JSON.stringify(record)){
    if(record.legacy)return [record.legacy];
    const old=state.entries.find(entry=>entry.canonical_record?.id===record.id);
    return old?[old]:[];
   }
   const legacy=record.legacy||{};
   return [{...legacy,type:'update_state',target:record.kind==='task'?'goal':'memory',value:String(record.value),scope:'profile',topic:String(record.key).slice(0,60),lifetime:'persistent',version:state.version,evidence_ids:record.evidence_refs||[],canonical_record:structuredClone(record)}];
  });
 }
 const keep=runtime.status==='idle'&&runtime.trace.some(step=>step.execution_results.some(entry=>entry.kind==='idle'&&entry.status==='success'&&entry.result?.mode==='keep'));
 return {runtime,state_after:state,slate:(keep?snapshot.previous_slate_ids:runtime.ordered_item_ids).map(id=>items.get(id)).filter(Boolean),content_items:[...items.values()]};
}

function runtimeTrace(runtime){
 return runtime.model_calls.map((call,index)=>{const step=runtime.trace.find(item=>item.call_index===index);return {phase:'unified',at:call.completed_at||new Date().toISOString(),...call,actions:call.parsed_output?.actions||[],normalized_output:step?.decision||null,execution_results:step?.execution_results||[],dispatch_groups:step?.dispatch_groups||[],state_after:step?.state_after||null};});
}

export async function executeUnifiedPolicy(snapshot,config,sourceConfig,{userId,sessionId,lookupHistory,signal,onAction,onTrace=()=>{},nextPage=()=>1,frozen=null}={}){
 const started=Date.now();
 const acquireSource=async(source,args)=>{
  if(frozen)return {source,status:'frozen',items:frozen.items.slice(0,args.limit)};
  const entry=snapshot.available_sources.find(item=>item.id===source);
  const modality=args.content_types?.find(type=>entry.modalities.includes(type))||entry.modalities[0];
  const action={source,mode:args.mode,query:args.query||'',modality};
  return acquire(action,sourceConfig,{excludedIds:snapshot.rendered_ids||[],limit:args.limit,...(source==='bilibili'?{page:nextPage(action)}:{})});
 };
 let result;
 try{result=await runDemo(frozen?{...snapshot,candidate_pool:frozen.items}:snapshot,{userId,sessionId,modelCall:demoModelCall(config,signal,{thinkingMode:'enabled'}),acquireSource,lookupHistory,onAction});}
 catch(error){if(error.runtime){error.partial_trace=runtimeTrace(error.runtime);if(error.partial_trace.length)error.partial_trace.at(-1).error=error.message;error.partial_trace.push({phase:'failure',failed_phase:'unified',error:error.message,model_metadata:error.runtime.model_calls.at(-1)||null,at:new Date().toISOString()});for(const entry of error.partial_trace)await onTrace(entry);}throw error;}
 const trace=runtimeTrace(result.runtime);
 for(const entry of trace)await onTrace(entry);
 const response=result.runtime.trace.flatMap(step=>step.execution_results).find(entry=>entry.kind==='respond'&&entry.status==='success')?.result?.response?.text||'';
 return {policy_id:'joint-v1',policy_version:result.runtime.runtime_version,prompt_version:result.runtime.runtime_version,mode:'llm',model:config.model,input_snapshot:snapshot,state_before_version:snapshot.state.version,state_after:result.state_after,content_snapshot:{id:id(),hash:hash(result.content_items),items:result.content_items},slate:result.slate,reason:'',response,trace,duration_ms:Date.now()-started,runtime_source_sha256:result.runtime.runtime_source_sha256};
}
