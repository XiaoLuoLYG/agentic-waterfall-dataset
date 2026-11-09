import {createServer} from 'node:http';
import {readFileSync,readdirSync,mkdirSync,chmodSync,lstatSync,openSync,closeSync,writeFileSync,fsyncSync,fchmodSync,renameSync,unlinkSync,existsSync,constants} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createResearchRunner} from './research-live-methods.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import {RESEARCH_METHODS,ONLINE_METHODS,validResearchMethods,sameResearchMethods} from '../lib/waterfall/research-methods.mjs';
const methodIds=RESEARCH_METHODS;
const sha=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const fail=(message,status=400)=>Object.assign(Error(message),{status});
function privateDirectory(path){mkdirSync(path,{recursive:true,mode:0o700});if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory())throw Error('private directory invalid');chmodSync(path,0o700);}
function writePrivate(path,value){
 const temporary=path+'.'+randomUUID()+'.tmp',fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,Buffer.isBuffer(value)?value:JSON.stringify(value));fsyncSync(fd);}catch(error){try{unlinkSync(temporary);}catch{}throw error;}finally{closeSync(fd);}
 renameSync(temporary,path);const directory=openSync(dirname(path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
function readPrivate(path){if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw Error('private file invalid');return JSON.parse(readFileSync(path,'utf8'));}
function appendArchive(directory,entry){
 if(!uuid.test(entry.run_id))throw Error('archive run identity invalid');
 const fd=openSync(resolve(directory,entry.run_id+'.jsonl'),constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
 try{fchmodSync(fd,0o600);writeFileSync(fd,JSON.stringify(entry)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
}
function lockData(directory){
 const file=resolve(directory,'service.lock'),identity=JSON.stringify({pid:process.pid,nonce:randomUUID()});
 for(let attempt=0;attempt<2;attempt++){
  try{const fd=openSync(file,'wx',0o600);try{writeFileSync(fd,identity);fsyncSync(fd);}finally{closeSync(fd);}return ()=>{if(existsSync(file)&&readFileSync(file,'utf8')===identity)unlinkSync(file);};}
  catch(error){if(error.code!=='EEXIST')throw error;const old=readPrivate(file);if(!Number.isInteger(old.pid)||old.pid<1)throw Error('service lock owner invalid');try{process.kill(old.pid,0);throw Error('research data directory already in use');}catch(probe){if(probe.code!=='ESRCH')throw probe;}const current=readPrivate(file);if(current.nonce!==old.nonce||current.pid!==old.pid)throw Error('research data lock changed');unlinkSync(file);}
 }
 throw Error('research data lock unavailable');
}

// A persisted state is usable only when the matching method completion was archived first.
export function createResearchStateStore(dataDir){
 const states=resolve(dataDir,'states'),archives=resolve(dataDir,'archives');privateDirectory(states);privateDirectory(archives);
 return {
  get(user,method){
   const file=resolve(states,sha([user,method])+'.json');if(!existsSync(file))return null;const saved=readPrivate(file);
   if(saved.user_id!==user||saved.method_id!==method||!uuid.test(saved.commit?.run_id)||sha(saved.value)!==saved.commit.state_sha256)throw Error('private state identity invalid');
   const lines=readFileSync(resolve(archives,saved.commit.run_id+'.jsonl'),'utf8').split('\n');lines.pop();
   const committed=lines.some(line=>{let entry;try{entry=JSON.parse(line);}catch{return false;}return entry.event==='method_complete'&&entry.run_id===saved.commit.run_id&&entry.user_id===user&&entry.method_id===method&&entry.state_sha256===saved.commit.state_sha256&&sha(entry.next_state)===saved.commit.state_sha256;});
   if(!committed)throw Error('private state has no archived completion');return saved.value;
  },
  set(user,method,value,commit){if(!methodIds.includes(method)||!uuid.test(commit?.run_id)||sha(value)!==commit.state_sha256)throw Error('private state commit invalid');writePrivate(resolve(states,sha([user,method])+'.json'),{user_id:user,method_id:method,value,commit});}
 };
}
function costs(method){
 const receipts=method.trace?.filter(entry=>entry.receipt).map(entry=>entry.receipt)||[],seen=new Set(),out={model_calls:0,input_tokens:0,output_tokens:0,total_tokens:0,usage_missing_calls:0,reported_cost_usd:null};
 for(const receipt of receipts){if(receipt.attempt_id&&seen.has(receipt.attempt_id))continue;if(receipt.attempt_id)seen.add(receipt.attempt_id);out.model_calls++;const usage=receipt.usage;if(!usage){out.usage_missing_calls++;continue;}const input=usage.prompt_tokens??usage.input_tokens??0,output=usage.completion_tokens??usage.output_tokens??0;out.input_tokens+=input;out.output_tokens+=output;out.total_tokens+=usage.total_tokens??input+output;if(typeof receipt.cost_usd==='number')out.reported_cost_usd=(out.reported_cost_usd||0)+receipt.cost_usd;}
 return out;
}
function summary(result){
 const fields=['data_origin','runtime','network_sources','training','catalog_sha256','catalog_count','active_sources','unavailable_sources','source_sha256','method_state_scope','method_protocols','method_ids','method_scheduling'];
 const methods=result.methods.map(method=>({method_id:method.method_id,status:method.status,method_version:method.method_version,implementation:method.implementation,runtime_source_sha256:method.runtime_source_sha256,protocol:method.protocol,adapter_protocol:method.adapter_protocol,resources:method.resources,...(method.error?{error:method.error}:{}),slate:method.slate.slice(0,5),costs:costs(method)}));
 const total={model_calls:0,input_tokens:0,output_tokens:0,total_tokens:0,usage_missing_calls:0,reported_cost_usd:null};for(const method of methods){for(const key of ['model_calls','input_tokens','output_tokens','total_tokens','usage_missing_calls'])total[key]+=method.costs[key];if(method.costs.reported_cost_usd!==null)total.reported_cost_usd=(total.reported_cost_usd||0)+method.costs.reported_cost_usd;}
 return {run_id:result.run_id,artifact_version:result.artifact_version,data_origin:result.data_origin,methods,environment:Object.fromEntries(fields.filter(key=>result.environment?.[key]!==undefined).map(key=>[key,result.environment[key]])),costs:total};
}
function validateRequest(input){
 if(!input||!uuid.test(input.job_id)||!uuid.test(input.user_id)||!uuid.test(input.session_id)||!['human','synthetic','test_only'].includes(input.data_origin)||!input.snapshot||!Array.isArray(input.history)||input.mode!==undefined&&!['rating','blind'].includes(input.mode)||input.context_hash!==undefined&&!/^[a-f0-9]{64}$/i.test(input.context_hash))throw fail('invalid research job input');
 if(input.method_ids!==undefined&&!validResearchMethods(input.method_ids))throw fail('invalid method roster');
 if(input.data_origin==='human'&&input.snapshot.qa_environment?.data_origin==='test_only')throw fail('research origin mismatch');
 const allowed=['job_id','user_id','session_id','snapshot','history','data_origin','mode','context_hash','method_ids'];if(Object.keys(input).some(key=>!allowed.includes(key)))throw fail('unsupported research job fields');
 return input;
}

export async function createResearchService({dataDir,token,runner,researchRoot,config={},sourceConfig={}}={}){
 if(typeof token!=='string'||token.length<32)throw Error('research service token required');if(!dataDir)throw Error('research service data directory required');
 const root=resolve(dataDir);privateDirectory(root);const jobsDir=resolve(root,'jobs'),archives=resolve(root,'archives');privateDirectory(jobsDir);privateDirectory(archives);
 const stateStore=createResearchStateStore(root),unlock=lockData(root);
 const jobs=new Map(),queue=[];let closed=false,fatal=null,scheduled=false,draining=Promise.resolve();
 const archive=entry=>appendArchive(archives,entry);
 try{runner||=createResearchRunner({researchRoot,config,sourceConfig,archive,stateStore,methodIds:ONLINE_METHODS});}catch(error){unlock();throw error;}
 const file=(id,name)=>resolve(jobsDir,id,name),save=job=>{writePrivate(file(job.job_id,'job.json'),job);jobs.set(job.job_id,job);};
 const orphan=id=>{const input=validateRequest(readPrivate(file(id,'input.json')));if(input.job_id!==id)throw Error('persisted research input identity invalid');const job={job_id:id,user_id:input.user_id,session_id:input.session_id,data_origin:input.data_origin,mode:input.mode,context_hash:input.context_hash,request_hash:sha(canonical(input)),status:'interrupted',error:'incomplete_job_record_no_automatic_retry',updated_at:new Date().toISOString()};save(job);return job;};
 const view=job=>Object.fromEntries(['job_id','user_id','session_id','data_origin','mode','context_hash','status','error','summary','artifact'].filter(key=>job[key]!==undefined).map(key=>[key,job[key]]));
 try{
  for(const name of readdirSync(jobsDir).filter(name=>uuid.test(name))){
   if(!existsSync(file(name,'job.json'))){if(existsSync(file(name,'input.json')))orphan(name);continue;}const job=readPrivate(file(name,'job.json'));if(job.job_id!==name)throw Error('persisted research job identity invalid');
   if(job.status==='running'){job.status='interrupted';job.error='execution_interrupted_no_automatic_retry';job.updated_at=new Date().toISOString();save(job);}else jobs.set(name,job);
   if(job.status==='queued')queue.push(job.job_id);
  }
 }catch(error){unlock();throw error;}
 async function execute(id){
  let job=jobs.get(id);save({...job,status:'running',updated_at:new Date().toISOString()});job=jobs.get(id);
  try{
   const input=readPrivate(file(id,'input.json'));
   const result=await runner({snapshot:input.snapshot,history:input.history,session:{session_id:input.session_id,user_id:input.user_id,record_kind:input.data_origin==='human'?'human':'synthetic',data_origin:input.data_origin},userId:input.user_id,job_id:id,data_origin:input.data_origin});
   if(!result||result.data_origin!==job.data_origin||!Array.isArray(result.methods)||!sameResearchMethods(result.methods.map(method=>method.method_id),input.method_ids||runner.info?.methods||methodIds)||result.methods.some(method=>!methodIds.includes(method.method_id)||!['submitted','failed','not_applicable'].includes(method.status)||!Array.isArray(method.slate)))throw Error('invalid participating-method research result');
   const artifactResult={...result,run_id:result.run_id||id,artifact_version:'awf-research-artifact/1'},compressed=gzipSync(Buffer.from(JSON.stringify(artifactResult))),small=summary(artifactResult);if(Buffer.byteLength(JSON.stringify(small))>750000)throw Error('research summary too large');
   writePrivate(file(id,'artifact.json.gz'),compressed);save({...job,status:'succeeded',summary:small,artifact:{encoding:'gzip',sha256:sha(compressed),size:compressed.length},updated_at:new Date().toISOString()});
  }catch(error){save({...job,status:'failed',error:error.message,updated_at:new Date().toISOString()});if(/research_archive_failed|research_state_failed/.test(error.message))fatal=error;}
 }
 function schedule(){
  if(scheduled||closed||fatal)return;scheduled=true;
  draining=new Promise(accept=>setImmediate(async()=>{let activeJob;try{while(queue.length&&!closed&&!fatal){activeJob=queue.shift();await execute(activeJob);}}catch(error){fatal=error;if(activeJob)jobs.set(activeJob,{...jobs.get(activeJob),status:'failed',error:'research_storage_unavailable'});}finally{scheduled=false;accept();}}));
 }
 const send=(status,value,headers={})=>new Response(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value),{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Type':'application/json; charset=utf-8',...headers}});
 const service={
  archive,stateStore,
  async handler(request){
   if(!timingSafeEqual(Buffer.from(sha(request.headers.get('authorization')||''),'hex'),Buffer.from(sha('Bearer '+token),'hex')))return send(401,{error:'unauthorized'});
   try{
    const path=new URL(request.url).pathname;
    if(request.method==='GET'&&path==='/v1/info')return send(200,{...runner.info,ready:!closed&&!fatal,protocol:'awf-research-compute/1',methods:runner.info?.methods||methodIds,sources:runner.info?.sources||[],model:runner.info?.model||config.model||null,serial_execution:true,artifact_encoding:'gzip',...(fatal?{error:'research_storage_unavailable'}:{})});
    if(request.method==='POST'&&path==='/v1/jobs'){
     if(closed||fatal)throw fail('research service unavailable',503);
     let bytes=0;const chunks=[];const reader=request.body?.getReader();if(!reader)throw fail('request body required');try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2097152)throw fail('research input too large',413);chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
     let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('invalid JSON');}validateRequest(input);const digest=sha(canonical(input)),old=jobs.get(input.job_id)||(existsSync(file(input.job_id,'input.json'))?orphan(input.job_id):null);
     if(old){if(old.request_hash!==digest)throw fail('job identity already bound to another request',409);return send(200,view(old));}
     if(input.method_ids&&!sameResearchMethods(input.method_ids,runner.info?.methods||methodIds))throw fail('method roster changed; prepare again',409);
     privateDirectory(resolve(jobsDir,input.job_id));writePrivate(file(input.job_id,'input.json'),input);
     const job={job_id:input.job_id,user_id:input.user_id,session_id:input.session_id,data_origin:input.data_origin,mode:input.mode,context_hash:input.context_hash,request_hash:digest,status:'queued',created_at:new Date().toISOString()};save(job);queue.push(job.job_id);schedule();return send(202,view(job));
    }
    const match=/^\/v1\/jobs\/([a-f0-9-]+)(\/artifact)?$/i.exec(path);if(!match||!uuid.test(match[1])||request.method!=='GET')throw fail('not found',404);
    const job=jobs.get(match[1]);if(!job)throw fail('not found',404);if(!match[2])return send(200,view(job));
    if(job.status!=='succeeded'||!job.artifact)throw fail('artifact not available',409);
    const compressed=readFileSync(file(job.job_id,'artifact.json.gz'));if(compressed.length!==job.artifact.size||sha(compressed)!==job.artifact.sha256)throw Error('stored artifact checksum mismatch');
    return send(200,compressed,{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="${job.job_id}.json.gz"`,'X-Job-Id':job.job_id,'X-User-Id':job.user_id,'X-Session-Id':job.session_id,'X-Artifact-Sha256':job.artifact.sha256,'X-Artifact-Size':String(job.artifact.size)});
   }catch(error){return send(error.status||500,{error:error.status?error.message:'research service operation failed'});}
  },
  async idle(){do{await draining;}while(scheduled);},
  async close(){if(closed)return;closed=true;await draining;unlock();}
 };
 schedule();return service;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 let service;try{
  const {loadConfig}=await import('../lib/waterfall/server.mjs');const {loadSourceConfig}=await import('../lib/waterfall/sources.mjs');const config=loadConfig(process.env);if(config&&process.env.RESEARCH_PYTHON)config.pythonPath=process.env.RESEARCH_PYTHON;if(!config)throw Error('research service requires configured real model');
  service=await createResearchService({dataDir:process.env.RESEARCH_DATA_DIR,token:process.env.RESEARCH_TOKEN,researchRoot:process.env.WATERFALL_RESEARCH_ROOT,config,sourceConfig:loadSourceConfig(config.sourceConfigPath)});
  const port=Number(process.env.RESEARCH_PORT||4192);if(!Number.isInteger(port)||port<1||port>65535)throw Error('research port invalid');
  const server=createServer(async(req,res)=>{try{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>2097152){res.writeHead(413);res.end();return;}chunks.push(chunk);}const response=await service.handler(new Request(`http://127.0.0.1:${port}${req.url}`,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end();}});
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});console.log(JSON.stringify({port,model:config.model,protocol:'awf-research-compute/1'}));
  const stop=()=>server.close(()=>service.close().catch(()=>{process.exitCode=1;}));process.once('SIGINT',stop);process.once('SIGTERM',stop);
 }catch(error){if(service)await service.close();console.error(error.message);process.exitCode=1;}
}
