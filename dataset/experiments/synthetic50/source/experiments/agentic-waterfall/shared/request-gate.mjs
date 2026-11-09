import {mkdirSync,readFileSync,writeFileSync,renameSync,rmdirSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const WINDOW_MS=60000,MAX_LIMIT=120;
const validRate=value=>Number.isSafeInteger(value)&&value>=1&&value<=MAX_LIMIT;

export function createRequestGate({endpoint,key},{directory=process.env.WATERFALL_REQUEST_GATE_DIR||join(homedir(),'.cache','agentic-waterfall','request-gates'),now=Date.now,wait=delay}={}){
 if(typeof key!=='string'||!key||!isAbsolute(directory))throw Error('request_gate_invalid_config');
 const id=createHash('sha256').update(JSON.stringify([new URL(endpoint).origin,key])).digest('hex');
 mkdirSync(directory,{recursive:true,mode:0o700});
 const file=join(directory,id+'.json'),lock=file+'.lock';
 async function withState(change){
  for(let attempt=0;;attempt++){
   try{mkdirSync(lock,{mode:0o700});break;}
   catch(error){if(error.code!=='EEXIST')throw error;if(attempt>=200)throw Error('request_gate_locked_manual_inspection_required');await wait(50);}
  }
  try{
   let state;
   try{state=JSON.parse(readFileSync(file,'utf8'));}
   catch(error){if(error.code==='ENOENT')state={version:1,starts:[],cooldown_until:0};else throw Error('request_gate_state_invalid');}
   const timestamp=x=>Number.isSafeInteger(x)&&x>=0;
   if(state?.version!==1||!Array.isArray(state.starts)||state.starts.length>MAX_LIMIT||!state.starts.every((x,i)=>timestamp(x)&&(i===0||x>=state.starts[i-1]))||!timestamp(state.cooldown_until)||(state.requests_per_minute!==undefined&&!validRate(state.requests_per_minute)))throw Error('request_gate_state_invalid');
   const result=change(state);
   if(result.save){
    const temporary=file+'.'+randomUUID()+'.tmp',fd=openSync(temporary,'wx',0o600);
    try{writeFileSync(fd,JSON.stringify(state)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temporary,file);
    const dir=openSync(directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
   }
   return result;
  }finally{rmdirSync(lock);}
 }
 return {
  async admit({deadline:callDeadline=Infinity,deferCooldown=false}={}){
   if(callDeadline!==Infinity&&(!Number.isSafeInteger(callDeadline)||callDeadline<0))throw Error('request_gate_invalid_deadline');
   const started=now(),hardDeadline=started+300000;
   let deadline=started+90000,observedCooldown=started;
   for(;;){
    const result=await withState(state=>{
     const time=now();if(!Number.isSafeInteger(time)||time<0)throw Error('request_gate_clock_invalid');
     if(deferCooldown===true&&state.cooldown_until>time)return {cooldownUntil:state.cooldown_until};
     state.starts=state.starts.filter(x=>x>time-WINDOW_MS);
     const limit=state.requests_per_minute??45,spacing=Math.ceil(WINDOW_MS/limit);
     const ready=Math.max(state.cooldown_until,state.starts.length?state.starts.at(-1)+spacing:0,state.starts.length>=limit?state.starts[state.starts.length-limit]+WINDOW_MS:0);
     // Provider-requested backoff is separate from local queue contention.
     if(state.cooldown_until>observedCooldown){
      deadline+=Math.max(0,state.cooldown_until-Math.max(time,observedCooldown));
      observedCooldown=state.cooldown_until;
     }
     if(time>callDeadline||ready>callDeadline)throw Error('request_gate_call_deadline_exceeded');
     if(time>hardDeadline||ready>hardDeadline)throw Error('request_gate_wait_exceeds_300s');
     if(time>deadline||ready>deadline)throw Error('request_gate_wait_exceeds_90s');
     if(ready>time)return {delay:ready-time};
     // Persist before fetch: a crashed caller may consume a slot, never erase its peers' admissions.
     state.starts.push(time);return {save:true,time};
    });
    if(result.save)return result.time;
    if(result.cooldownUntil!==undefined)return result;
    await wait(Math.min(result.delay,1000));
   }
  },
  async setRateLimit(limit){
   if(!validRate(limit))throw Error('request_gate_invalid_rate');
   await withState(state=>{state.requests_per_minute=limit;return {save:true};});
  },
  async cooldown(seconds=60){
   const until=now()+Math.ceil(Math.max(60,seconds)*1000);
   if(!Number.isSafeInteger(until)||until<0)throw Error('request_gate_invalid_cooldown');
   const result=await withState(state=>{state.cooldown_until=Math.max(state.cooldown_until,until);return {save:true,cooldownUntil:state.cooldown_until};});
   return result.cooldownUntil;
  }
 };
}
