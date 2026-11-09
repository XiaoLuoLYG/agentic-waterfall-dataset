import {check,exact,hash,id,comparisonAssignment,collectionProfile} from './core.mjs';
import {createHash} from 'node:crypto';
import {researchPublicInput} from './research-input.mjs';
import {RESEARCH_METHODS as METHODS,validResearchMethods,sameResearchMethods} from './research-methods.mjs';

const itemFields=['id','title','summary','source','modality','url','image_url','duration','published_at','content_hash'];
const publicItem=item=>Object.fromEntries(itemFields.filter(key=>item[key]!==undefined).map(key=>[key,item[key]]));
const contentKey=item=>item.url||item.id;
const answerKey=(study,question)=>`${study.id}:${question}`;
const legacy=study=>study.kind==='comparison'&&study.study_protocol==='blind-next-v1';
export const researchStopped=(store,studyId)=>store.rows.some(row=>row.kind==='research_stop'&&row.study_id===studyId);
function answers(store,study){return store.rows.filter(row=>row.kind==='evaluation'&&(legacy(study)?row.comparison_id===study.id:row.study_id===study.id));}

export function publicStudy(store,study){
 if(!study)return null;
 if(legacy(study))return {id:study.id,session_id:study.session_id,legacy:true,mode:'blind',created_at:study.available_at,stopped:researchStopped(store,study.id),completed:answers(store,study).length?1:0,total:1,items:[],pairs:[],annotation_policy:'evaluation_only'};
 const saved=answers(store,study),byQuestion=new Map(saved.map(row=>[row.question_id,row]));
 return {id:study.id,session_id:study.session_id,mode:study.mode,created_at:study.available_at,collection_profile_id:study.collection_profile_id||null,collection_subset:study.collection_subset||'general',annotation_policy:'evaluation_only',stopped:researchStopped(store,study.id),
  items:study.items.map(question=>({id:question.id,item:question.item,answered:byQuestion.has(question.id)})),
  pairs:study.pairs.map(pair=>({id:pair.id,A:pair.A,B:pair.B,unavailable:pair.unavailable,same_content:pair.same_content,answered:byQuestion.has(pair.id)})),
  method_count:(study.method_ids||METHODS).length,incomplete_methods:(study.method_ids||METHODS).filter(id=>!methodResults(study).some(method=>method.method_id===id&&method.status==='submitted'&&method.slate?.length===5)).length,completed:saved.length,total:study.mode==='rating'?study.items.length:study.pairs.length};
}

export function assertResearchExportable(store,sessionId){
 for(const job of store.rows.filter(row=>row.kind==='research_job'&&row.session_id===sessionId&&!store.rows.some(study=>study.kind==='research_study'&&study.preparation_id===row.preparation_id))){check(store.rows.some(row=>row.kind==='research_job_status'&&row.preparation_id===job.preparation_id&&['failed','interrupted'].includes(row.status)),'参评系统评测尚未完成归档，请稍后导出',409);}
 for(const study of store.rows.filter(row=>(row.kind==='research_study'||legacy(row))&&row.session_id===sessionId)){
  const view=publicStudy(store,study);check(view.stopped||view.completed===view.total,'请先完成或结束评测，再导出包含方法身份的数据',409);
 }
}

function questions(result,mode){
 const unique=new Map(),mappings=[];
 for(const method of result.methods){
  check(typeof method.method_id==='string'&&Array.isArray(method.slate),'方法结果无效',502);
  for(const [index,item] of method.slate.slice(0,5).entries()){
   check(item&&typeof item.id==='string'&&typeof item.title==='string','推荐内容无效',502);
   const key=contentKey(item);if(!unique.has(key))unique.set(key,{id:id(),item:publicItem(item)});
   mappings.push({method_id:method.method_id,rank:index+1,question_id:unique.get(key).id,item_id:item.id});
  }
 }
 const pairs=[],waterfall=result.methods.find(method=>method.method_id==='waterfall');
 if(mode==='blind'){
  check(waterfall,'缺少Waterfall输出',502);
  for(const opponent of result.methods.filter(method=>method!==waterfall)){
   const assignment=comparisonAssignment(['waterfall',opponent.method_id]);
   const sides=Object.fromEntries(['A','B'].map(side=>[side,result.methods.find(method=>method.method_id===assignment.mapping[side]).slate.slice(0,5).map(publicItem)]));
   pairs.push({id:id(),...assignment,...sides,unavailable:sides.A.length!==5||sides.B.length!==5,
    same_content:JSON.stringify(sides.A.map(contentKey))===JSON.stringify(sides.B.map(contentKey))});
  }
 }
 const items=mode==='rating'?[...unique.values()]:[];
 const displayed=mode==='rating'?items:pairs;
 for(let i=displayed.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[displayed[i],displayed[j]]=[displayed[j],displayed[i]];}
 return {items,mappings,pairs};
}

const methodResults=study=>legacy(study)?Object.entries(study.results||{}).map(([method_id,result])=>({...result,method_id,status:result.status||(result.error?'failed':'submitted')})):study.summary?.methods||study.result?.methods||[];
const sealed=(store,study)=>{const view=publicStudy(store,study);return view.stopped||view.completed===view.total;};
function researchOrigin(store,study){
 const prep=store.rows.find(row=>row.kind==='research_preparation'&&row.id===study.preparation_id),origins=[store.session(study.session_id).record_kind,study.record_kind,study.summary?.data_origin,study.result?.data_origin,study.input_snapshot?.qa_environment?.data_origin,study.result?.input_snapshot?.qa_environment?.data_origin,prep?.snapshot?.qa_environment?.data_origin];
 if(origins.some(value=>['test','test_only'].includes(value)))return 'test_only';
 if(origins.some(value=>value==='synthetic')||answers(store,study).some(row=>row.simulated||row.origin&&row.origin!=='human'))return 'synthetic';
 return origins.includes('human')?'human':'unknown';
}
export function researchDisposition(store,study){
 const data_origin=researchOrigin(store,study),record=store.rows.findLast(row=>row.kind==='research_curation'&&row.study_id===study.id),human=data_origin==='human',disposition=human?record?.disposition||'pending':'exclude',can_keep=human&&sealed(store,study);
 return {disposition,data_origin,can_keep,release_eligible:can_keep&&disposition==='keep',updated_at:record?.available_at||null};
}
export function researchReleaseRows(store,sessionId){
 const session=store.session(sessionId),studies=store.rows.filter(row=>(row.kind==='research_study'||legacy(row))&&row.session_id===sessionId&&researchDisposition(store,row).release_eligible),ids=new Set(studies.map(row=>row.id)),preparations=new Set(studies.map(row=>row.preparation_id).filter(Boolean));
 check(session.record_kind==='human'&&ids.size,'请先保留至少一组已完成或已结束的人工评测',409);
 const natural=row=>row.record_kind==='human'&&!row.simulated&&![row.data_origin,row.input_snapshot?.qa_environment?.data_origin,row.result?.data_origin,row.result?.input_snapshot?.qa_environment?.data_origin].some(value=>['synthetic','test_only','test'].includes(value));
 const feed=store.rows.filter(row=>row.session_id===sessionId&&natural(row)&&(row.track==='feed'||['session','state'].includes(row.kind))),inputIds=new Set(feed.filter(row=>row.kind==='input').map(row=>row.input_snapshot?.id).filter(Boolean)),captureIds=new Set(store.rows.filter(row=>row.kind==='dataset_capture'&&row.session_id===sessionId&&inputIds.has(row.input_snapshot_id)).map(row=>row.capture_id)),feedIds=new Set(feed.map(row=>row.id));
 return store.rows.filter(row=>row.session_id===sessionId&&(feedIds.has(row.id)||ids.has(row.id)||['research_preparation','research_job','research_job_status'].includes(row.kind)&&(preparations.has(row.id)||preparations.has(row.preparation_id))||['evaluation','research_event','research_presentation','research_stop','research_legacy_artifact','research_curation','blind_presentation','blind_open','blind_return'].includes(row.kind)&&(ids.has(row.study_id)||ids.has(row.comparison_id))||['dataset_capture','dataset_archive','dataset_capture_chunk'].includes(row.kind)&&captureIds.has(row.capture_id)));
}
const artifactUrl=(sessionId,studyId)=>`/api/research/artifact?sessionId=${encodeURIComponent(sessionId)}&studyId=${encodeURIComponent(studyId)}`;
const historyOf=store=>store.rows.filter(row=>row.track==='feed'&&['command','feedback','exposure','open','return'].includes(row.kind));
const smallMethods=methods=>methods.map(method=>Object.fromEntries(['method_id','status','method_version','implementation','runtime_source_sha256','slate','costs','error'].filter(key=>method[key]!==undefined).map(key=>[key,method[key]])));
export function researchExportRows(rows){
 return rows.map(row=>{
  if(row.kind==='research_study'){const {result,input_snapshot,...rest}=row,ref=row.artifact_ref||rows.find(entry=>entry.kind==='research_legacy_artifact'&&entry.study_id===row.id)?.artifact_ref;return {...rest,summary:row.summary||{methods:smallMethods(result?.methods||[])},...(ref?{artifact_ref:ref}:{}),artifact_url:ref?artifactUrl(row.session_id,row.id):null};}
  if(row.kind==='research_preparation'){const {snapshot,history,...rest}=row;return rest;}
  return row;
 });
}
function ownInput(study,user){
 if(study.public_input)return study.public_input;
 return researchPublicInput({...study.input_snapshot,captured_at:study.input_snapshot?.captured_at||study.available_at,state:study.input_snapshot?.state||{}},[],user.id);
}
async function bytes(value){
 if(value instanceof Uint8Array)return value;
 if(value?.arrayBuffer)return new Uint8Array(await value.arrayBuffer());
 if(value?.body)return new Uint8Array(await new Response(value.body).arrayBuffer());
 check(false,'原始归档不可用',503);
}
function verifyGzip(data,ref){check(ref?.encoding==='gzip'&&/^[a-f0-9]{64}$/i.test(ref.sha256)&&Number.isInteger(ref.size)&&data.byteLength===ref.size&&data[0]===31&&data[1]===139&&createHash('sha256').update(data).digest('hex')===ref.sha256,'原始归档校验失败',502);}
export async function readResearchArtifact(archive,ref,userId){
 check(archive?.get,'私有原始归档暂不可用',503);check(ref?.key?.startsWith(`research/${userId}/`),'原始归档不属于当前账号',404);
 const data=await bytes(await archive.get(ref.key));verifyGzip(data,ref);return data;
}

export async function handleResearch({req,url,store,user,send,body,snapshot,config=null,backend,archive,storage='d1+r2'}){
 if(!url.pathname.startsWith('/api/research/'))return false;
 const path=url.pathname,input=req.method==='POST'?await body(req):{sessionId:url.searchParams.get('sessionId')};
 check(typeof input.sessionId==='string','会话无效');
 const session=store.session(input.sessionId);check(session.user_id===user.id,'会话不存在',404);
 const ownedStudy=studyId=>{const study=store.rows.find(row=>(row.kind==='research_study'||legacy(row))&&row.id===studyId);check(study&&store.session(study.session_id).user_id===user.id,'评测不存在',404);return study;};
 const capabilities=async()=>{try{const info=await backend?.info();return info?.ready&&validResearchMethods(info.methods)&&Array.isArray(info.sources)&&info.sources.every(source=>source&&typeof source.id==='string'&&Array.isArray(source.modes)&&source.modes.length&&source.modes.every(mode=>['search','explore'].includes(mode))&&Array.isArray(source.modalities)&&source.modalities.length&&source.modalities.every(type=>['text','video','image'].includes(type)))?info:null;}catch{return null;}};
 const context=async info=>{
  const raw=await snapshot(session.session_id),history=historyOf(store),public_input=researchPublicInput(raw,history,user.id);
  const sources=(info?.sources||[]).filter(source=>!user.settings.sources.length||user.settings.sources.includes(source.id)).map(source=>({...source,modalities:source.modalities.filter(type=>user.settings.contentTypes.includes(type))})).filter(source=>source.modalities.length);
  const persona=collectionProfile(store,session.session_id),expressions=public_input.evidence.filter(row=>row.type==='command'||row.type==='feedback'&&row.value==='comment'&&row.text);
  check(persona.subset!=='behavior_ambiguity'||!expressions.length,'行为歧义场景的共同历史不能含用户指令或文字需求',409);
  check(persona.subset!=='interactive_revision'||expressions.length,'请先在发现页表达一次具体需求，再开始交互修改评测',409);
  const unavailable_sources=user.settings.sources.filter(id=>!sources.some(source=>source.id===id));
  const frozen={...raw,unavailable_sources,state:{version:1,...public_input.provided_profile,memory:'',context:''},candidate_pool:[],previous_slate_ids:[],available_sources:sources,original_source_catalog:raw.available_sources||[]};delete frozen.hash;frozen.hash=hash(frozen);
  return {snapshot:frozen,history,public_input,sources,unavailable_sources,collection_profile_id:persona.profile_id,collection_subset:persona.subset,fingerprint:hash({collection_profile_id:persona.profile_id,public_input,settings:user.settings,sources,backend:{methods:info?.methods,model:info?.model,catalog_sha256:info?.catalog_sha256,source_sha256:info?.source_sha256}})};
 };
 const payload=prep=>({job_id:prep.id,user_id:user.id,session_id:session.session_id,mode:prep.mode,context_hash:prep.context_hash,method_ids:prep.methods,snapshot:prep.snapshot,history:prep.history,data_origin:prep.snapshot.qa_environment?.data_origin==='test_only'?'test_only':session.record_kind==='human'?'human':'synthetic'});
 const finish=async(prep,job)=>{
  check(job?.job_id===prep.id&&job.user_id===user.id&&job.session_id===session.session_id,'计算任务身份不匹配',502);
  check(['queued','running','succeeded','failed','interrupted'].includes(job.status),'计算任务状态无效',502);
  if(['failed','interrupted'].includes(job.status)){await store.recordOnce('research_job_status',session.session_id,`research-job-status:${prep.id}:${job.status}`,{track:'evaluation',preparation_id:prep.id,status:job.status,error:job.error});return {pending:{id:prep.id,status:job.status,error:job.error}};}
  if(job.status!=='succeeded')return {pending:{id:prep.id,status:job.status}};
  const existing=store.rows.find(row=>row.kind==='research_study'&&row.preparation_id===prep.id);if(existing)return {study:publicStudy(store,existing)};
  const summary=job.summary;check(summary&&Array.isArray(summary.methods)&&sameResearchMethods(summary.methods.map(method=>method.method_id),prep.methods||METHODS)&&summary.methods.every(method=>METHODS.includes(method.method_id)&&Array.isArray(method.slate)&&['submitted','failed','not_applicable'].includes(method.status)),'参评系统交付无效',502);
  check(archive?.put&&archive?.get,'私有原始归档尚未配置',503);
  const data=await bytes(await backend.artifact(prep.id));verifyGzip(data,job.artifact);
  const key=`research/${user.id}/${prep.id}.json.gz`,artifact_ref={...job.artifact,key,job_id:prep.id};
  try{await archive.put(key,data,{httpMetadata:{contentType:'application/gzip'},customMetadata:{sha256:job.artifact.sha256,user_id:user.id,session_id:session.session_id,job_id:prep.id,context_hash:prep.context_hash}});}catch{check(false,'原始记录归档失败，尚未创建评测，请稍后重试',503);}
  const cleanSummary={run_id:summary.run_id,artifact_version:summary.artifact_version,data_origin:payload(prep).data_origin,methods:smallMethods(summary.methods),environment:{...summary.environment,collection_subset:prep.collection_subset||'general',reference_trajectory:'shared_prefix'},costs:summary.costs};
  const record={track:'evaluation',mode:prep.mode,preparation_id:prep.id,collection_profile_id:prep.collection_profile_id||null,collection_subset:prep.collection_subset||'general',protocol:'awf-evaluation/4.0',method_ids:[...prep.methods],annotation_policy:'evaluation_only',context_hash:prep.context_hash,public_input:prep.public_input,summary:cleanSummary,artifact_ref,...questions(cleanSummary,prep.mode)};
  check(Buffer.byteLength(JSON.stringify(record))<900000,'评测摘要过大',502);
  const study=await store.recordOnce('research_study',session.session_id,`research-study:${prep.id}`,record);return {study:publicStudy(store,study)};
 };
 if(req.method==='GET'&&path==='/api/research/data'){
  const studies=store.rows.filter(row=>(row.kind==='research_study'||legacy(row))&&store.session(row.session_id).user_id===user.id).map(study=>{
   const view=publicStudy(store,study),isSealed=sealed(store,study);
   return {id:study.id,session_id:study.session_id,mode:legacy(study)?'blind':study.mode,legacy:legacy(study),can_stop:!isSealed,created_at:study.available_at,completed:view.completed,total:view.total,stopped:view.stopped,sealed:isSealed,curation:researchDisposition(store,study),input:ownInput(study,user),answers:legacy(study)?answers(store,study).map(row=>Object.fromEntries(['id','comparison_id','choice','origin','simulated','event_time','available_at'].filter(key=>row[key]!==undefined).map(key=>[key,row[key]]))):answers(store,study),...(isSealed?{methods:smallMethods(methodResults(study))}:{})};
  });send(200,{storage:{kind:storage,private_archive:!!archive,label_storage:storage==='sqlite+files'?'sqlite':'d1',export_scope:'current_session',export_note:'整体下载仅包含当前会话；历史组可单独查看和下载。'},studies,export_url:`/api/export?sessionId=${encodeURIComponent(session.session_id)}&format=json`});return true;
 }
 if(req.method==='GET'&&['/api/research/details','/api/research/artifact'].includes(path)){
  const study=ownedStudy(url.searchParams.get('studyId'));check(sealed(store,study),'请先完成或结束本组评测',409);
  if(path.endsWith('/details')){
   const prep=store.rows.find(row=>row.kind==='research_preparation'&&row.id===study.preparation_id),view=publicStudy(store,study),methods=smallMethods(methodResults(study));
   const input=prep?.snapshot||study.input_snapshot||study.result?.input_snapshot||null,history=prep?.history||input?.behavior||[];
   const artifact_ref=study.artifact_ref||store.rows.find(row=>row.kind==='research_legacy_artifact'&&row.study_id===study.id)?.artifact_ref||null,artifact_url=artifact_ref||study.result||study.results?artifactUrl(study.session_id,study.id):null;
   const record={version:'awf-study-record/1',study_id:study.id,session_id:study.session_id,mode:legacy(study)?'blind':study.mode,legacy:legacy(study),protocol:study.protocol||study.study_protocol||null,
    data_origin:study.summary?.data_origin||study.result?.data_origin||study.record_kind||store.session(study.session_id).record_kind,input,public_input:ownInput(study,user),history,
    history_cutoff:{captured_at:prep?.captured_at||input?.captured_at||null,event_ids:history.map(row=>row.id).filter(Boolean)},context_hash:study.context_hash||prep?.context_hash||null,
    total:view.total,completed:view.completed,unknown:Math.max(0,view.total-view.completed),stopped:view.stopped,sealed:true,
    questions:legacy(study)?[{id:study.id,...Object.fromEntries(['A','B'].map(side=>[side,(study.results?.[study.mapping?.[side]]?.slate||[]).slice(0,1).map(publicItem)]))}]:study.mode==='rating'?study.items:study.pairs,mappings:legacy(study)?study.mapping:study.mappings||[],methods,
    answers:answers(store,study),stops:store.rows.filter(row=>row.kind==='research_stop'&&row.study_id===study.id),artifact_ref,artifact_url};
   send(200,{details:{id:study.id,methods,environment:study.summary?.environment||study.result?.environment,artifact_ref,artifact_url,record}},'application/json; charset=utf-8',url.searchParams.get('download')==='1'?{'Content-Disposition':`attachment; filename="waterfall-${hash(study.id).slice(0,16)}-record.json"`}:{});return true;
  }
  let ref=study.artifact_ref||store.rows.find(row=>row.kind==='research_legacy_artifact'&&row.study_id===study.id)?.artifact_ref;
  check(archive?.get&&archive?.put,'私有原始归档暂不可用',503);
  if(!ref){
   check(study.result||study.results,'本组暂无独立原始归档',503);
   const stream=new Response(JSON.stringify({version:'awf-legacy-study/1',study,answers:answers(store,study),stops:store.rows.filter(row=>row.kind==='research_stop'&&row.study_id===study.id)})).body.pipeThrough(new CompressionStream('gzip')),data=new Uint8Array(await new Response(stream).arrayBuffer());
   ref={encoding:'gzip',size:data.byteLength,sha256:createHash('sha256').update(data).digest('hex'),key:`research/${user.id}/legacy-${hash(study.id)}.json.gz`};
   try{await archive.put(ref.key,data,{httpMetadata:{contentType:'application/gzip'}});}catch{check(false,'历史原始记录归档失败，请稍后重试',503);}
   const saved=await store.recordOnce('research_legacy_artifact',study.session_id,`research-legacy-artifact:${study.id}`,{track:'evaluation',study_id:study.id,artifact_ref:ref});ref=saved.artifact_ref;
  }
  const data=await readResearchArtifact(archive,ref,user.id);send(200,data,'application/gzip',{'Content-Disposition':`attachment; filename="waterfall-${hash(study.id).slice(0,16)}.json.gz"`,'X-Artifact-Sha256':ref.sha256,'X-Artifact-Size':String(ref.size)});return true;
 }
 if(req.method==='GET'&&path==='/api/research/current'){
  const mode=url.searchParams.get('mode');check(!mode||['rating','blind'].includes(mode),'评测类型无效');
  const pending=store.rows.findLast(row=>row.kind==='research_job'&&row.session_id===session.session_id&&(!mode||row.mode===mode));
  const completed=pending&&store.rows.find(row=>row.kind==='research_study'&&row.preparation_id===pending.preparation_id);
  if(completed){send(200,{study:publicStudy(store,completed),full_comparison_available:!!backend&&!!archive});return true;}
  if(pending){const prep=store.rows.find(row=>row.kind==='research_preparation'&&row.id===pending.preparation_id);check(backend&&prep,'参评系统后端尚未配置',503);let job;try{job=await backend.poll(prep.id);}catch(error){if(error.status===404)job=await backend.start(payload(prep));else check(false,'参评系统计算后端暂不可用，请稍后重新连接',503);}send(200,{...await finish(prep,job),full_comparison_available:!!backend&&!!archive});return true;}
  const study=store.rows.findLast(row=>row.kind==='research_study'&&row.session_id===session.session_id&&(!mode||row.mode===mode));send(200,{study:publicStudy(store,study),full_comparison_available:!!backend&&!!archive});return true;
 }
 if(req.method==='POST'&&path==='/api/research/prepare'){
  exact(input,['sessionId','mode']);check(['rating','blind'].includes(input.mode),'评测类型无效');
  const info=await capabilities(),shared=await context(info),ready=!!info&&!!archive?.put&&!!archive?.get&&shared.sources.length>0;
  const previous=store.rows.findLast(row=>row.kind==='research_preparation'&&row.session_id===session.session_id&&row.mode===input.mode&&row.fingerprint===shared.fingerprint&&row.backend_ready===ready&&!store.rows.some(job=>job.kind==='research_job'&&job.preparation_id===row.id));
  const preparation=previous||await store.record('research_preparation',session.session_id,{track:'evaluation',user_id:user.id,mode:input.mode,captured_at:shared.snapshot.captured_at,context_hash:hash(shared.snapshot),backend_ready:ready,methods:info?.methods||[],deferred_methods:info?.methods?METHODS.filter(id=>!info.methods.includes(id)):[],sources:shared.sources,backend_info:info,...shared});
  const visible=Object.fromEntries(['id','mode','captured_at','context_hash','public_input','methods','deferred_methods','sources','unavailable_sources','backend_ready','collection_subset'].map(key=>[key,preparation[key]]));send(previous?200:201,{preparation:visible});return true;
 }
 if(req.method==='POST'&&path==='/api/research/curate'){
  exact(input,['sessionId','studyId','disposition']);check(['keep','exclude','pending'].includes(input.disposition),'数据保留状态无效');
  const study=ownedStudy(input.studyId);check(study.session_id===session.session_id,'评测不存在',404);check(user.type==='human','仅本人可管理人工评测',403);
  const curation=researchDisposition(store,study);check(input.disposition==='exclude'||curation.data_origin==='human','测试或合成记录不能纳入正式数据',409);check(input.disposition!=='keep'||curation.can_keep,'请先完成或结束本组人工评测',409);
  await store.record('research_curation',study.session_id,{track:'administration',study_id:study.id,disposition:input.disposition,annotation_policy:'evaluation_only',label_use:'administration_only_never_controller_input'});
  send(201,{study_id:study.id,curation:researchDisposition(store,study)});return true;
 }
 if(req.method==='POST'&&path==='/api/research/stop'){
  exact(input,['sessionId','studyId']);const study=ownedStudy(input.studyId);
  if(!researchStopped(store,study.id))await store.recordOnce('research_stop',study.session_id,`research-stop:${study.id}`,{track:'evaluation',study_id:study.id,reason:'participant_stop',legacy:legacy(study),missing_answers_preserved:true,annotation_policy:'evaluation_only'});send(201,{study:publicStudy(store,study)});return true;
 }
 if(req.method==='POST'&&path==='/api/research/start'){
  exact(input,['sessionId','mode','preparationId']);check(typeof input.preparationId==='string','请先查看并确认本组共同输入',400);check(['rating','blind'].includes(input.mode),'评测类型无效');
  const prep=store.rows.find(row=>row.kind==='research_preparation'&&row.id===input.preparationId&&row.session_id===session.session_id&&row.user_id===user.id&&row.mode===input.mode);check(prep,'共同输入准备记录不存在',404);
  const existing=store.rows.find(row=>row.kind==='research_study'&&row.preparation_id===prep.id);if(existing){send(200,{study:publicStudy(store,existing)});return true;}
  check(prep.backend_ready&&backend&&archive?.put,'参评系统计算后端或私有归档暂不可用',503);
  const already=store.rows.find(row=>row.kind==='research_job'&&row.preparation_id===prep.id);
  if(!already){const info=await capabilities();check(info,'参评系统计算后端暂不可用',503);const current=await context(info);check(current.fingerprint===prep.fingerprint,'共同输入已变化，请重新查看并确认',409);await store.recordOnce('research_job',session.session_id,`research-job:${prep.id}`,{track:'evaluation',mode:prep.mode,preparation_id:prep.id,status:'queued',context_hash:prep.context_hash});}
  let job;try{job=await backend.start(payload(prep));}catch{check(false,'参评系统任务连接失败，可重新连接同一任务',503);}const response=await finish(prep,job);send(response.study?201:202,response);return true;
 }
 check(req.method==='POST'&&['/api/research/present','/api/research/answer','/api/research/interaction','/api/research/simulate'].includes(path),'地址不存在',404);
 const study=store.rows.find(row=>row.kind==='research_study'&&row.id===input.studyId&&row.session_id===session.session_id);
 check(study,'评测不存在',404);
 check(!publicStudy(store,study).stopped,'本次评测已结束，不能继续提交答案',409);
 const question=(study.mode==='rating'?study.items:study.pairs).find(question=>question.id===input.questionId);check(question,'题目不存在',404);
 const comparison_id=answerKey(study,question.id);
 const simulated=path==='/api/research/simulate';let simulationAttempt=null;
 if(simulated){
  exact(input,['sessionId','studyId','questionId']);check(user.type==='agent','只有Agent账号可以模拟评价',403);check(config,'Agent评价需要配置模型',503);
  check(!store.rows.some(row=>row.kind==='evaluation'&&row.comparison_id===comparison_id),'本题已经作答',409);
  const record=store.rows.find(row=>row.kind==='collection_profile'&&row.id===study.collection_profile_id&&row.session_id===session.session_id);
  check(record?.collection_profile.hidden_profile,'本组没有冻结的隐藏画像，请补充后重新准备评测',409);
  const messages=[{role:'system',content:'模拟该人物对匿名内容的当前兴趣。只依据隐藏人物设定、截至当前的共同历史和实际提供的卡片材料判断，不猜系统身份，不把未来阶段当成已经发生。内容不足以判断时选择无法判断。评分只用于评价，不产生浏览反馈。评分任务只输出JSON {"rating":0到3,"status":"rated"}，无法判断输出{"rating":null,"status":"unable"}；盲选任务只输出{"choice":"A"或"B"或"tie"或"neither"或"insufficient"}。同一列表不能选胜方，交付不足只能insufficient。'},
   {role:'user',content:JSON.stringify({mode:study.mode,hidden_profile:record.collection_profile.hidden_profile,public_input:study.public_input,content:study.mode==='rating'?question.item:{A:question.A,B:question.B,same_content:question.same_content,unavailable:question.unavailable}})}];
  simulationAttempt=await store.record('agent_attempt',session.session_id,{track:'evaluation',study_id:study.id,question_id:question.id,collection_profile_id:record.id,simulated:true,model:config.model,messages,annotation_policy:'evaluation_only'});
  try{
   const response=await fetch(config.endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.key}`},body:JSON.stringify({model:config.model,...config.requestParameters,messages,response_format:{type:'json_object'}}),signal:config.signal?AbortSignal.any([config.signal,AbortSignal.timeout(config.timeoutMs)]):AbortSignal.timeout(config.timeoutMs)});
   check(response.ok,`模型接口返回HTTP ${response.status}`,502);const result=await response.json(),raw=result.choices?.[0]?.message?.content;let decision;
   try{decision=JSON.parse(raw);}catch{check(false,'模拟评价没有返回有效JSON',502);}
   exact(decision,study.mode==='rating'?['rating','status']:['choice']);
   if(study.mode==='rating')check(decision.status==='rated'&&Number.isInteger(decision.rating)&&decision.rating>=0&&decision.rating<=3||decision.status==='unable'&&decision.rating===null,'模拟评分无效',502);
   else check(['A','B','tie','neither','insufficient'].includes(decision.choice)&&(!question.unavailable||decision.choice==='insufficient')&&(!question.same_content||['tie','neither','insufficient'].includes(decision.choice)),'模拟选择无效',502);
   Object.assign(input,decision);
   await store.record('agent_decision',session.session_id,{track:'evaluation',study_id:study.id,question_id:question.id,attempt_id:simulationAttempt.id,collection_profile_id:record.id,model:config.model,provider_response_model:result.model||null,usage:result.usage||null,messages,raw_output:raw,decision,simulated:true,annotation_policy:'evaluation_only'});
  }catch(error){await store.record('agent_failure',session.session_id,{track:'evaluation',study_id:study.id,question_id:question.id,attempt_id:simulationAttempt.id,error:error.message,simulated:true,annotation_policy:'evaluation_only'});throw error;}
 }
 if(path==='/api/research/interaction'){
  exact(input,['sessionId','studyId','questionId','event','itemId']);
  check(['open','return'].includes(input.event),'事件类型无效');
  const items=study.mode==='rating'?[question.item]:[...question.A,...question.B];
  check(items.some(item=>item.id===input.itemId),'内容引用无效');
  if(input.event==='return')check(store.rows.some(row=>row.kind==='research_event'&&row.comparison_id===comparison_id&&row.content_id===input.itemId&&row.event==='open'),'缺少打开记录');
  await store.record('research_event',session.session_id,{track:'evaluation',study_id:study.id,question_id:question.id,comparison_id,event:input.event,content_id:input.itemId,measurement:'open_return_only_not_reading_duration',annotation_policy:'evaluation_only'});
  send(201,{saved:true});return true;
 }
 if(path==='/api/research/present'){
  exact(input,['sessionId','studyId','questionId','itemId']);
  const items=study.mode==='rating'?[question.item]:[...question.A,...question.B];
  const shown=input.itemId?items.find(item=>item.id===input.itemId):study.mode==='rating'?question.item:null;check(shown,'展示内容引用无效');
  const present=store.rows.find(row=>row.kind==='research_presentation'&&row.comparison_id===comparison_id&&row.content_id===shown.id);
  if(!present)await store.record('research_presentation',session.session_id,{track:'evaluation',study_id:study.id,question_id:question.id,comparison_id,content_id:shown.id,displayed_ids:[shown.id],presentation_hash:hash(publicItem(shown)),measurement:'client_attested_half_visible_not_full_reading',annotation_policy:'evaluation_only'});
  send(present?200:201,{saved:true});return true;
 }
 check(user.type==='human'||simulated,'Agent请使用单题模拟评价入口',403);
 check(simulated||store.rows.some(row=>row.kind==='research_presentation'&&row.comparison_id===comparison_id),'请先查看内容再作答',409);
 check(!store.rows.some(row=>row.kind==='evaluation'&&row.comparison_id===comparison_id),'本题已经作答',409);
 let label;
 if(study.mode==='rating'){
  exact(input,['sessionId','studyId','questionId','rating','status']);
  check(input.status==='rated'&&Number.isInteger(input.rating)&&input.rating>=0&&input.rating<=3||input.status==='unable'&&input.rating===null,'评分无效');
  label={rating_value:input.rating,grade_status:input.status,label_type:'content_rating'};
 }else{
  exact(input,['sessionId','studyId','questionId','choice']);
  check(['A','B','tie','neither','insufficient'].includes(input.choice),'选择无效');
  check(!question.unavailable||input.choice==='insufficient','本题交付不足，不能判断偏好');
  check(!question.same_content||['tie','neither','insufficient'].includes(input.choice),'两组相同时不能选择胜方');
  label={choice:input.choice,label_type:'blind_choice'};
 }
 try{await store.record('evaluation',session.session_id,{track:'evaluation',study_id:study.id,question_id:question.id,comparison_id,...label,
  origin:session.record_kind==='human'?'human':'synthetic',simulated:session.record_kind!=='human',annotation_source:simulated?'model':'participant',agent_attempt_id:simulationAttempt?.id||null,context_hash:study.context_hash,
  rubric_version:study.mode==='rating'?'interest-0-3/v1':'list-preference/v1',...(study.mode==='rating'?{content_id:question.item.id}:{}),
  evaluated_at:new Date().toISOString(),annotation_policy:'evaluation_only',label_use:'evaluation_only_never_controller_input'});}
 catch(error){if(/unique/i.test(error.message))check(false,'本题已经作答',409);throw error;}
 send(201,{saved:true,study:publicStudy(store,study)});return true;
}

export function researchMetrics(rows){
 return rows.filter(row=>row.kind==='research_study'&&row.mode==='rating').map(study=>({study_id:study.id,context_hash:study.context_hash,annotation_policy:'evaluation_only',
  methods:methodResults(study).map(method=>{
   let lower=0,upper=0,observed=0,unknown=0;
   const mappings=study.mappings.filter(mapping=>mapping.method_id===method.method_id);
   for(const mapping of mappings){
    const answer=rows.find(row=>row.kind==='evaluation'&&row.study_id===study.id&&row.question_id===mapping.question_id);
    if(answer?.grade_status==='rated'){lower+=answer.rating_value/Math.log2(mapping.rank+1);upper+=answer.rating_value/Math.log2(mapping.rank+1);observed+=answer.rating_value;}
    else{unknown++;upper+=3/Math.log2(mapping.rank+1);}
   }
   return {method_id:method.method_id,status:method.status||'submitted',delivered:mappings.length,unknown,observed_reward:observed,dcg_at_5:unknown?null:lower,dcg_lower:lower,dcg_upper:upper};
  })}));
}
