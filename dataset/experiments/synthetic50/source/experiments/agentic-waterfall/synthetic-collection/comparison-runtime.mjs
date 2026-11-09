import assert from 'node:assert/strict';

export function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, 'unexpected frozen source boundary: ' + before.slice(0, 100));
  return source.replace(before, () => after);
}

export function patchedHybridWorker(source) {
  source = replaceOnce(source, '        self.model_loads, self.requests = 2, 0',
    '        self.document_cache = None\n        self.model_loads, self.requests = 2, 0');
  source = replaceOnce(source, '    def rank(self, request):', `    def document_vectors(self, catalog, pool=None):
        build_ms = None
        if pool is not None:
            if self.document_cache is not None:
                raise ValueError('frozen BGE document cache already initialized')
            started = time.perf_counter()
            full = validate_catalog(pool)
            matrix = self.vectors([item['text'] for item in full])
            if matrix.shape[0] != len(full) or not self.np.isfinite(matrix).all():
                raise ValueError('invalid frozen BGE document vectors')
            self.document_cache = matrix, {item['id']: (i, item['text']) for i, item in enumerate(full)}
            build_ms = 1000 * (time.perf_counter() - started)
        if self.document_cache is None:
            return self.vectors([item['text'] for item in catalog]), {'status': 'cold', 'encoded_documents': len(catalog)}
        matrix, items = self.document_cache
        indices = []
        for item in catalog:
            found = items.get(item['id'])
            if found is None or found[1] != item['text']:
                raise ValueError('eligible BGE item differs from frozen document cache')
            indices.append(found[0])
        return matrix[indices], {'status': 'built' if build_ms is not None else 'hit',
                                 'pool_count': len(items), 'encoded_documents': len(items) if build_ms is not None else 0,
                                 'build_ms': build_ms}

    def rank(self, request):`);
  source = replaceOnce(source, "        vectors, query_vector = self.vectors([item['text'] for item in catalog]), self.vectors([query])[0]",
    "        vectors, document_cache = self.document_vectors(catalog, request.get('pool_catalog'))\n        query_vector = self.vectors([query])[0]");
  return replaceOnce(source, "result['worker_resources'] = {'device':", "result['worker_resources'] = {'document_cache': document_cache, 'device':");
}

export function patchedPoolRunner(source) {
  const patch = (before, after) => { source = replaceOnce(source, before, after); };
  patch('job_id,data_origin})', 'job_id,data_origin,frozen_pool})');
  patch("const key=JSON.stringify([user,method]),prior=states.get(key)||stateStore?.get(user,method)||null,trace=[],acquired=new Map(),pages=new Map();",
    "const key=JSON.stringify([user,method]),prior=states.get(key)||stateStore?.get(user,method)||null,trace=[],acquired=new Map(),pages=new Map();" +
    "\n   const previous=new Set(prior?.event_ids||[]),delta=evidence.filter(row=>!previous.has(row.id));" +
    "\n   const consume=state=>({state,event_ids:[...new Set([...previous,...delta.map(row=>row.id)])]});");
  patch("method_version:'online-method-v4'", "method_version:'synthetic-pool-v1'");
  patch("method==='generic-agent'?'Autonomous generic tool Agent with independent state and repeated live acquisition'",
    "method==='recagent'?'AgentRecBench RecAgent author workflow, candidate append correction and own evolving public profile on frozen candidates'");
  patch("independent live-source acquisition':method==='fixed-retrieval'?'Independent live-source acquisition then full",
    "fixed public candidate shortlist':method==='fixed-retrieval'?'Frozen public multi-source pool then full");
  patch("candidate_selection:'independent live acquisition arrival order',contrast:'independently acquired unobserved neutral alternative'",
    "candidate_selection:'shared public-evidence lexical shortlist',contrast:'held-out unobserved frozen card'");
  patch("initial_history:'normal demo snapshot window; complete natural prefix remains available through lookup_history'",
    "initial_history:'one-time public seed; own canonical state and unseen public operations, with unseen prefix available through lookup_history'");
  patch("    let ordered=[];", `    let ordered=[];
    const pooled=['recagent','i2agent','fixed-retrieval'].includes(method);
    if(pooled){
     if(!frozen_pool||frozen_pool.cards.length>protocol.max_acquired_items)throw Error('frozen pool missing or out of budget');
     for(const item of frozen_pool.cards)acquired.set(item.id,structuredClone(item));
     result.adapter_protocol={...result.adapter_protocol,candidate_source:'frozen_multisource_pool',pool_sha256:frozen_pool.pool_sha256,eligible_pool_count:acquired.size};
     const pool_trace={phase:'frozen_pool',pool_sha256:frozen_pool.pool_sha256,eligible_count:acquired.size};
     trace.push(pool_trace);persist('frozen_pool',method,{pool:pool_trace});
    }`);
  patch("const state=structuredClone(prior?.state||{version:1,profile:'',interests:[],memory:'',context:'',entries:[]});state.profile=provided_profile.profile;state.interests=provided_profile.interests;state.entries=[...(state.entries||[]).filter(x=>x.origin!=='user_edit'),...provided_profile.entries];",
    "const state=prior?.state?{version:prior.state.version,profile:'',interests:[],memory:'',context:'',entries:[]}:" +
    "{version:1,profile:provided_profile.profile,interests:provided_profile.interests,memory:'',context:'',entries:provided_profile.entries};");
  patch("behavior:evidence.filter(x=>x.type!=='command'&&(snapshot.behavior||[]).some(row=>row.id===x.id)),recent_commands:evidence.filter(x=>x.type==='command').slice(-8)",
    "behavior:delta.filter(x=>x.type!=='command'&&(snapshot.behavior||[]).some(row=>row.id===x.id)),recent_commands:delta.filter(x=>x.type==='command')");
  patch("sessionId,topK:5,modelCall", "sessionId,topK:5,canonicalState:prior?.state,modelCall");
  patch("const all=evidence.filter(x=>!query", "const all=delta.filter(x=>!query");
  patch("nextState={state:runtime.state_after}", "nextState=consume(runtime.runtime.state_after)");
  patch("     const processed=new Set(prior?.event_ids||[]);\n     const records=evidence.filter(row=>!processed.has(row.id)&&(row.type==='command'||row.content_id&&row.title)).map(row=>{",
    "     const records=delta.filter(row=>row.type==='command'||row.content_id&&row.title).map(row=>{");
  patch("{provided_profile,packets:packets.packets,prior_state:prior?.state||null,output_contract:",
    "{...(!prior?.state?{provided_profile}:{}),packets:packets.packets,prior_state:prior?.state||null,output_contract:");
  patch("     let instructions;", "     nextState=consume(state);\n     let instructions;");
  patch("     nextState={state,event_ids:evidence.map(x=>x.id)};\n", "");

  const start = source.indexOf("    }else if(method==='generic-agent'){");
  const end = source.indexOf("    }else if(method==='i2agent'){");
  assert(start >= 0 && end > start, 'unexpected frozen generic method boundary');
  source = source.slice(0, start) + `    }else if(method==='recagent'){
     const candidates=frozen_pool.candidate_ids.map(id=>acquired.get(id));
     if(candidates.length!==20||candidates.some(item=>!item))throw Error('RecAgent requires twenty eligible frozen candidates');
     result.adapter_protocol={...result.adapter_protocol,selected_candidate_ids:candidates.map(item=>item.id),profile_adapter:'prior own profile plus unseen evidence and one-time public seed'};
     const state=await model('recagent_state',{...(!prior?.state?{provided_profile}:{}),prior_state:prior?.state||null,new_evidence:delta,output_contract:{profile:'updated current user profile'}},
      'Evolve the prior profile using observed activity and explicit user instructions. Separate persistent tastes from the current task and retain still-active constraints. Later instructions supersede earlier conflicts. Preserve unresolved uncertainty. Return only a profile string in the requested JSON object.',value=>{
       if(!value||Object.keys(value).length!==1||typeof value.profile!=='string'||!value.profile.trim()||value.profile.length>6000)throw Error('invalid RecAgent profile');
       return value;
      });
     nextState=consume(state);
     const ranking=await tool('recagent',{user_id:user,profile:state.profile,candidates},async request=>(await metered(request,'recagent_ranking')).content);
     ordered=ranking.ordered_item_ids;
     if(!Array.isArray(ordered)||ordered.length!==candidates.length||new Set(ordered).size!==ordered.length||ordered.some(id=>!frozen_pool.candidate_ids.includes(id)))throw Error('invalid RecAgent full ranking');
     result.runtime_source_sha256=ranking.source_sha256;
     result.adapter_protocol.author_adapter_sha256=ranking.adapter_source_sha256;
` + source.slice(end);

  patch("      await publicAcquire();const pool=[...acquired.values()].filter(x=>!chosen.has(x.id));if(pool.length<2)throw Error('i2agent_requires_live_candidates_and_independent_contrast');\n      const contrast=pool.at(-1),candidates=pool.slice(0,-1).slice(0,result.adapter_protocol.candidate_cap).map(x=>({id:x.id,title:x.title,description:x.summary||''}));",
    `      const contrast=acquired.get(frozen_pool.contrast_id);
      const project=x=>({id:x.id,title:x.title,description:JSON.stringify({summary:x.summary,source:x.source,modality:x.modality,duration:x.duration})});
      const pool=frozen_pool.candidate_ids.map(id=>acquired.get(id));
      if(!contrast||pool.length!==20||pool.some(item=>!item))throw Error('i2agent requires twenty frozen candidates and a neutral contrast');
      const candidates=pool.map(project);`);
  patch("eligible_pool_count:pool.length,selected_candidate_count:", "eligible_pool_count:acquired.size,selected_candidate_count:");
  patch("      const ranking=await tool('i2agent',{history:[...chosen.values()].slice(-result.adapter_protocol.chosen_history_cap),candidates,contrast:{id:contrast.id,title:contrast.title,description:contrast.summary||''},instruction:JSON.stringify({provided_profile,evidence})+' The contrast is an unobserved neutral alternative, not a dislike.'},(request,metadata)=>validatedModel(request,'i2agent_model',i2PublicValidator(metadata,candidates.length)));",
    `      const profiles={};
      const ranking=await tool('i2agent',{history:[...chosen.values()].slice(-result.adapter_protocol.chosen_history_cap),candidates,contrast:project(contrast),instruction:JSON.stringify({provided_profile,evidence})+' The contrast is an unobserved neutral alternative, not a dislike.'},async(request,metadata)=>{
       const fields=metadata.json_schema.schema.required;
       if(fields.includes('rerank_list')){
        request={...request,messages:[request.messages[0],{role:'user',content:JSON.stringify({task:'Rank every candidate index once using your own derived profiles.',candidates:candidates.map(({title,description},index)=>({index:index+1,title,description})),profiles})}]};
       }
       const response=await validatedModel(request,'i2agent_model',i2PublicValidator(metadata,candidates.length));
       for(const field of ['profile','knowledge','dynamic_interest','dynamic_profile'])if(Object.hasOwn(response,field))profiles[field]=response[field];
       return response;
      });
      nextState={state:profiles};`);
  patch("     await publicAcquire();if(!query||!acquired.size)throw Error('fixed retrieval requires visible query and live results');",
    "     if(!query||!acquired.size)throw Error('fixed retrieval requires visible query and frozen results');");
  patch("network_sources:true,training:false,active_sources:", "network_sources:!frozen_pool,training:false,active_sources:");
  return source;
}

export function patchedResearchPython(source) {
  return replaceOnce(source, "    elif operation == 'packets':", `    elif operation == 'recagent':
        from recagent_pool import rank_recagent

        def model(request):
            print(json.dumps({'type': 'model_request', 'request': request}, ensure_ascii=True), flush=True)
            response = json.loads(sys.stdin.readline())
            if response.get('type') != 'model_response':
                raise RuntimeError(response.get('error', 'Node model transport failed'))
            return response['value']

        value = rank_recagent(request, model)
    elif operation == 'packets':`);
}
