import {check,hash} from './core.mjs';

const fields=['id','value','text','content_id','content_hash','reference_id','exposure_id','position','session_id','title','topic','source','visible_ms','event_time','available_at'];

// The confirmation page and every method consume this same natural-history projection.
export function researchPublicInput(snapshot,history=[],userId){
 const cutoff=Date.parse(snapshot.captured_at),events=new Map();check(Number.isFinite(cutoff),'输入截止时间无效');
 const add=row=>{
  const type=row.kind||row.type;
  if(row.track&&row.track!=='feed'||row.user_id&&row.user_id!==userId||!['command','feedback','open','return','exposure'].includes(type)||type==='exposure'&&row.phase&&row.phase!=='end'||type==='feedback'&&!['like','dislike','save','unsave','comment'].includes(row.value))return;
  if([row.available_at,row.event_time].filter(Boolean).some(time=>!Number.isFinite(Date.parse(time))||Date.parse(time)>cutoff))return;
  const event={type,...Object.fromEntries(fields.filter(key=>row[key]!==undefined).map(key=>[key,structuredClone(row[key])]))};events.set(event.id||hash(event),event);
 };
 for(const row of [...(snapshot.behavior||[]),...history])add(row);
 for(const row of snapshot.recent_commands||[])if(!events.has(row.id))add({...row,kind:'command',text:row.command});
 if(snapshot.command&&!events.has(snapshot.command_event_id||snapshot.id))add({id:snapshot.command_event_id||snapshot.id,kind:'command',text:snapshot.command,available_at:snapshot.captured_at});
 return {provided_profile:{profile:snapshot.state?.profile||'',interests:structuredClone(snapshot.state?.interests||[]),entries:(snapshot.state?.entries||[]).filter(row=>row.origin==='user_edit').map(row=>Object.fromEntries(['origin','target','topic','value','scope','lifetime'].filter(key=>row[key]!==undefined).map(key=>[key,structuredClone(row[key])])))} ,
  evidence:[...events.values()].sort((a,b)=>String(a.available_at||a.event_time||'').localeCompare(String(b.available_at||b.event_time||'')))};
}
