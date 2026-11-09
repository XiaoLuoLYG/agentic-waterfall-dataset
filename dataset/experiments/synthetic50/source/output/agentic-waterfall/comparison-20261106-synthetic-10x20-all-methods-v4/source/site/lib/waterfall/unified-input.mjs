import {createHash} from 'node:crypto';

const id=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);

export function lookupDemoHistory(store,sessionId,observedAt,{query='',offset=0,limit=30}){
 const owner=store.session(sessionId).user_id;
 const sessions=owner?new Set(store.rows.filter(r=>r.kind==='session'&&r.user_id===owner).map(r=>r.session_id)):new Set([sessionId]);
 const matches=store.rows.filter(r=>sessions.has(r.session_id)&&r.track==='feed'&&['command','feedback','exposure','open','return'].includes(r.kind)&&(r.kind!=='exposure'||r.phase==='end')&&[r.available_at,r.event_time].filter(Boolean).every(time=>Date.parse(time)<=Date.parse(observedAt))&&(!query||[r.text,r.title,r.topic,r.source].some(x=>String(x||'').toLowerCase().includes(query.toLowerCase())))).reverse();
 const page=matches.slice(offset,offset+limit),dialogue=[],behavior_events=[];
 for(const r of page){
  if(r.kind==='command'||(r.kind==='feedback'&&r.value==='comment'&&r.text))dialogue.push({id:r.id,role:'user',text:r.text,available_at:r.available_at,...(r.kind==='feedback'?{source_channels:['behavior','expression']}: {})});
  if(r.kind!=='command')behavior_events.push(Object.fromEntries(['id','value','text','content_id','content_hash','reference_id','exposure_id','position','session_id','simulated','title','topic','source','visible_ms','event_time','available_at'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]).concat([['type',r.kind],...(r.value==='comment'?[['source_channels',['behavior','expression']]]:[])])));
 }
 return {dialogue,behavior_events,next_offset:offset+page.length<matches.length?offset+page.length:null};
}

// Read-only projection: legacy records remain unchanged in the demo store.
export function demoInput(snapshot,{userId,sessionId}){
 const state=snapshot.state;
 const records=[];
 const add=(key,value,kind,basis,legacy=null)=>{
  if(value===undefined||value===null||value==='')return;
  records.push({id:`demo:${id(key)}`,kind,key:JSON.stringify(key),value,scope:legacy?.scope||'legacy',scope_id:legacy?.origin_session_id||null,status:legacy?.target==='goal'&&value==='completed'?'completed':'active',basis,evidence_refs:[],...(legacy?{legacy:structuredClone(legacy)}:{})});
 };
 add('profile',state.profile,'episode','explicit');
 add('memory',state.memory,'episode','unknown');
 add('context',state.context,'episode','unknown');
 for(const interest of state.interests||[])add(['interest',interest],interest,'preference','explicit');
 for(const entry of state.entries||[]){
  if(entry.canonical_record&&entry.origin!=='user_edit')records.push(structuredClone(entry.canonical_record));
  else add(['entry',entry.target,entry.topic,entry.scope,entry.lifetime],entry.value,entry.target==='goal'?'task':'episode','unknown',entry);
 }
 const behavior=structuredClone(snapshot.behavior||[]).map(row=>row.type==='feedback'&&row.value==='comment'?{...row,source_channels:['behavior','expression']}:row);
 const dialogue=(snapshot.recent_commands||[]).map(c=>({id:c.id,role:'user',text:c.command,available_at:c.available_at}));
 for(const row of behavior)if(row.type==='feedback'&&row.value==='comment'&&row.text)dialogue.push({id:row.id,role:'user',text:row.text,available_at:row.available_at,source_channels:['behavior','expression']});
 if(snapshot.command)dialogue.push({id:snapshot.command_event_id||snapshot.id,role:'user',text:snapshot.command,available_at:snapshot.captured_at});
 const items=(snapshot.candidate_pool||[]).map(item=>({id:item.id,title:item.title,abstract:item.summary,source_id:item.source,content_type:item.modality,url:item.url,content_hash:item.content_hash,published_at:item.published_at}));
 return {observation:{schema_version:'agentic-waterfall-v1',decision_id:snapshot.id,user_id:userId,session_id:sessionId,observed_at:snapshot.captured_at,trigger:snapshot.trigger||'demo',dialogue,behavior_events:behavior,user_state:{version:state.version,records},environment:{candidate_pool:items,sources:structuredClone(snapshot.available_sources||[]),pending_queue:structuredClone(snapshot.previous_slate_ids||[]),visible_item_ids:structuredClone(snapshot.rendered_ids||[])}}};
}
