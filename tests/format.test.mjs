import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
let api;try{api=await import('../src/format.mjs');}catch{}
const content={id:'post-1',source:'example',url:'https://example.org/a?utm_source=qa',title:'Stored title',summary:'actual excerpt',text:'actual text'};
test('content versions ignore observation counters, change when stored text changes',()=>{
 assert.ok(api,'formatter exists'); const a=api.normalizeContent(content),b=api.normalizeContent({...content,captured_at:'tomorrow',views:45,rank:7});
 assert.equal(a.content_id,b.content_id);assert.equal(a.content_version_id,b.content_version_id);
 assert.notEqual(a.content_version_id,api.normalizeContent({...content,text:'changed'}).content_version_id);
 assert.equal(a.canonical_url,'https://example.org/a');
 assert.equal(a.content_id,'content:'+createHash('sha256').update('example\u0000post-1').digest('hex'));
 assert.throws(()=>api.normalizeContent({title:'no identity'}),/identity/);
});
test('capture corpus includes all returned results and retains failed attempts without dependency invention',()=>{
 assert.ok(api);const e=JSON.parse(readFileSync(new URL('../fixtures/tiny/episode.json',import.meta.url)));
 const d=api.buildDataset(e,{captureRecords:[{capture_id:'cap-1',run_id:'run-1',source:'example',request:{query:'q',headers:{Authorization:'Bearer SECRET','X-Api-Key':'SECRET'}},results:[content,{id:'never-shown',source:'example',title:'unshown'}],status:'completed',source_record_id:'capture-row'}]});
 assert.equal(d.schema_version,'awf-dataset/1.0');assert.equal(d.tables.contents.length,2);
 assert.equal(d.tables.ratings.length,2);assert.equal(d.tables.ratings[0].rating_value,0);
 assert.equal(d.tables.ratings[1].rating_value,null);assert.equal(d.tables.questions.length,3);
 assert.equal(d.tables.model_calls.find(x=>x.model_call_id==='decision-fail').status,'failed');
 assert.equal(d.tables.model_calls.find(x=>x.model_call_id==='decision-fail').retry_of,null);
 assert.equal(d.tables.contexts[0].cutoff_at,'2026-01-01T00:00:03Z');
 assert.equal(d.tables.participants[0].data_origin,'test_only');assert.equal(d.manifest.eligible_for_analysis,false);
 assert.ok(!JSON.stringify(d).includes('SECRET'));
 assert.equal(d.tables.tool_calls.find(x=>x.tool_call_id==='cap-1').results.length,2);
});
test('legacy episode missing artifacts remains explicit, never fabricated as a completed trace',()=>{
 assert.ok(api);const d=api.buildDataset({metadata:{episode_id:'legacy',user_id:'p',data_origin:'human'},decisions:[{decision_id:'interrupted',phase:'incomplete',status:'interrupted_or_in_progress',input:{id:'i',captured_at:'2026-01-01T00:00:00Z',state:{profile:'provided',memory:'inferred secret'}}}]});
 assert.equal(d.tables.runs[0].status,'interrupted_or_in_progress');assert.equal(d.tables.model_calls.length,0);
 assert.equal(d.tables.profiles.find(x=>x.profile_id===d.tables.contexts[0].provided_profile_id).profile.profile,'provided');
 assert.ok(!JSON.stringify(d.tables.profiles.find(x=>x.profile_id===d.tables.contexts[0].provided_profile_id)).includes('inferred secret'));
 assert.equal(d.manifest.history_completeness,'referenced_snapshots_only');
});
test('normalized capture rows survive storage without changing identity or truncation provenance',()=>{
 const a=api.normalizeContent({...content,source_item_id:'native-1',text:'x'.repeat(100003),views:99,topic:'query one',author:'writer'});
 assert.deepEqual(api.normalizeContent(a),a);
 assert.equal(a.text_status,'truncated');assert.equal(a.text_original_length,100003);
 assert.equal(a.content_version_id,api.normalizeContent({...content,source_item_id:'native-1',text:'x'.repeat(100003),topic:'query two',author:'writer'}).content_version_id);
});
test('slates and questions reference the exact stored version despite later captures',()=>{
 const first={...content,source_item_id:'native'},second={...first,summary:'later material'};
 const d=api.buildDataset({metadata:{session_id:'v',user_id:'p',data_origin:'human'},environment_snapshot:{corpus:[first]},slates:[{slate_id:'r',item_ids:['post-1'],content_snapshot:{items:[first]}}]}, {captureRecords:[{capture_id:'new',run_id:'r',source:'example',results:[second]}]});
 assert.equal(d.tables.contents.length,2);
 assert.equal(d.tables.slates[0].items[0].content_version_id,api.normalizeContent(first).content_version_id);
});
test('exposed content version resolves recorded content_hash and evaluator events stay evaluator-only',()=>{
 const a={...content,content_hash:'first'},b={...content,text:'updated',content_hash:'second'};
 const d=api.buildDataset({metadata:{session_id:'v',user_id:'p',data_origin:'human'},environment_snapshot:{corpus:[a,b]},event_log:[{id:'event',type:'exposure',item_id:'post-1',payload:{content_hash:'first'}},{id:'eval',type:'evaluation',payload:{label_type:'content_rating'}}]});
 assert.equal(d.tables.events[0].content_version_id,api.normalizeContent(a).content_version_id);
 assert.equal(d.tables.events[1].annotation_policy,'evaluation_only');
});
test('evaluation methods share one common context while private inferred state stays separate',()=>{
 const snapshot={id:'common',captured_at:'2026-01-01T00:00:00Z',state:{profile:'declared'}};
 const d=api.buildDataset({metadata:{session_id:'shared',user_id:'p',data_origin:'test_only'},source_records:[{id:'huge',kind:'run',result:{trace:['NO_DUPLICATE_AUDIT']}}],research_studies:[{id:'s',mode:'rating',input_snapshot:snapshot,items:[{id:'q',item:content}],mappings:[{method_id:'a',rank:1,question_id:'q',item_id:'post-1'},{method_id:'b',rank:1,question_id:'q',item_id:'post-1'}],result:{methods:[{method_id:'a',slate:[content],input_snapshot:{...snapshot,state:{profile:'declared',memory:'a private'}}},{method_id:'b',slate:[content],input_snapshot:{...snapshot,state:{profile:'declared',memory:'b private'}}}]}}],content_ratings:[{id:'answer',study_id:'s',question_id:'q',content_id:'post-1',rating_value:3,grade_status:'rated',origin:'test_only'}]});
 assert.equal(d.tables.runs[0].context_id,d.tables.runs[1].context_id);
 assert.equal(d.tables.runs[0].context_id,d.tables.studies[0].context_id);
 assert.notEqual(d.tables.runs[0].inferred_profile_id,d.tables.runs[1].inferred_profile_id);
 assert.equal(d.tables.participants[0].data_origin,'test_only');
 assert.equal(d.tables.slates[0].items[0].question_id,d.tables.slates[1].items[0].question_id);
 assert.equal(d.tables.slates[0].items[0].content_version_id,d.tables.slates[1].items[0].content_version_id);
 assert.ok(!JSON.stringify(d).includes('NO_DUPLICATE_AUDIT'));assert.equal(d.manifest.source_record_counts.run,1);
});
test('executed state and rejected state remain separate from common provided profile',()=>{
 const d=api.buildDataset({metadata:{session_id:'state',user_id:'p',data_origin:'human'},decisions:[{decision_id:'dec',run_id:'run',phase:'rank',input:{captured_at:'2026-01-01T00:00:00Z',state:{profile:'declared',memory:'before'}},model_call:{messages:[{role:'user',content:'actual request'}]},raw_output:'out',validation:{valid:true},state_after:{memory:'executed'},proposed_state_after:{memory:'proposed'}}]});
 assert.equal(d.tables.runs[0].state_after.memory,'executed');
 assert.equal(d.tables.model_calls[0].proposed_state_after.memory,'proposed');
 assert.equal(d.tables.contexts[0].source_input_snapshot.state.memory,'before');
});
test('a question does not label another method version of the same URL',()=>{
 const changed={...content,summary:'different returned material'};
 const d=api.buildDataset({metadata:{session_id:'version-label',user_id:'p',data_origin:'human'},research_studies:[{id:'study',mode:'rating',input_snapshot:{captured_at:'2026-01-01T00:00:00Z'},items:[{id:'q',item:content}],mappings:[{method_id:'a',rank:1,question_id:'q',item_id:'post-1'},{method_id:'b',rank:1,question_id:'q',item_id:'post-1'}],result:{methods:[{method_id:'a',slate:[content]},{method_id:'b',slate:[changed]}]}}]});
 assert.equal(d.tables.slates[0].items[0].question_id,'study:q');
 assert.equal(d.tables.slates[1].items[0].question_id,null);
 assert.equal(d.tables.slates[1].items[0].content_version_id,api.normalizeContent(changed).content_version_id);
 assert.equal(d.tables.slates[1].items[0].label_link_status,'question_material_mismatch');
});
test('public question projections and ratings bind the original corpus version, not a later capture',()=>{
 const full={...content,source_item_id:'native-id',author:'writer',content_hash:'original'},later={...full,summary:'later',content_hash:'later'};
 const {source_item_id,author,...visible}=full;
 const d=api.buildDataset({metadata:{session_id:'s',user_id:'p',data_origin:'human'},environment_snapshot:{corpus:[full]},research_studies:[{id:'study',mode:'rating',items:[{id:'q',item:visible}],mappings:[{method_id:'a',rank:1,question_id:'q',item_id:'post-1'}],result:{methods:[{method_id:'a',slate:[full]}]}}],research_presentations:[{id:'present',study_id:'study',question_id:'q',content_id:'post-1'}],content_ratings:[{id:'rate',study_id:'study',question_id:'q',content_id:'post-1',grade_status:'rated',rating_value:0,origin:'human'}]}, {captureRecords:[{capture_id:'later',results:[later]}]});
 const expected=api.normalizeContent(full).content_version_id;
 assert.equal(d.tables.questions[0].content_version_id,expected);
 assert.equal(d.tables.slates[0].items[0].content_version_id,expected);
 assert.equal(d.tables.slates[0].items[0].question_id,'study:q');
 assert.equal(d.tables.ratings[0].content_version_id,expected);
 assert.equal(d.tables.presentations[0].content_version_id,expected);
});
test('legacy exposure without a content hash can resolve its recorded slate snapshot',()=>{
 const d=api.buildDataset({metadata:{session_id:'s',user_id:'p',data_origin:'human'},environment_snapshot:{corpus:[content]},slates:[{slate_id:'r',item_ids:['post-1'],content_snapshot:{items:[content]}}],event_log:[{id:'exposure',type:'exposure',item_id:'post-1',payload:{reference_id:'r'}}]}, {captureRecords:[{capture_id:'later',results:[{...content,summary:'more full text'}]}]});
 assert.equal(d.tables.events[0].content_version_id,api.normalizeContent(content).content_version_id);
});
test('URL-deduplicated question never grants one source item grade to another source item',()=>{
 const a={id:'x',source:'example',source_item_id:'native-a',title:'first',url:'https://example.org/shared'},b={...a,id:'y',source_item_id:'native-b',title:'second'};
 const d=api.buildDataset({metadata:{session_id:'s',user_id:'p',data_origin:'human'},research_studies:[{id:'study',mode:'rating',items:[{id:'q',item:a}],mappings:[{method_id:'a',rank:1,question_id:'q',item_id:'x'},{method_id:'b',rank:1,question_id:'q',item_id:'y'}],result:{methods:[{method_id:'a',slate:[a]},{method_id:'b',slate:[b]}]}}],content_ratings:[{id:'r',study_id:'study',question_id:'q',content_id:'x',rating_value:3,grade_status:'rated',origin:'human'}]});
 assert.equal(d.tables.slates[0].items[0].question_id,'study:q');
 assert.equal(d.tables.slates[1].items[0].question_id,null);
 assert.equal(d.tables.slates[1].items[0].content_version_id,api.normalizeContent(b).content_version_id);
 assert.equal(d.tables.slates[1].items[0].label_link_status,'question_material_mismatch');
 assert.equal(d.tables.ratings[0].content_version_id,api.normalizeContent(a).content_version_id);
});
test('failed acquisition receipts retain request and explicit dependencies from the recorded action',()=>{
 const d=api.buildDataset({metadata:{session_id:'s',user_id:'p',data_origin:'human'},decisions:[{decision_id:'dec',failure_id:'failure',normalized_output:{actions:[{action_id:'acquire-1',kind:'acquire',arguments:{query:'issued query',source_ids:['one','two'],limit:4},depends_on:['recorded-parent']}]},execution_results:[{action_id:'acquire-1',status:'failed',error:'provider_timeout'}]}]});
 assert.equal(d.tables.tool_calls.length,1);const call=d.tables.tool_calls[0];
 assert.equal(call.request.query,'issued query');assert.deepEqual(call.request.source_ids,['one','two']);
 assert.deepEqual(call.source,['one','two']);assert.deepEqual(call.depends_on,['recorded-parent']);
 assert.equal(call.dependency_origin,'recorded');assert.equal(call.status,'failed');
 const legacy=api.buildDataset({metadata:{session_id:'legacy',user_id:'p',data_origin:'human'},decisions:[{decision_id:'old',failure_id:'f',execution_results:[{action_id:'unknown',status:'failed',error:'timeout'}]}]});
 assert.equal(legacy.tables.tool_calls[0].request,null);assert.equal(legacy.tables.tool_calls[0].depends_on,null);assert.equal(legacy.tables.tool_calls[0].dependency_origin,'not_recorded');
});
test('canonical core provider source_id never becomes a native document identity',()=>{
 const a=api.normalizeContent({source_id:'hackernews',id:'hashed-a',url:'https://news.example/item?id=101',title:'a',abstract:'canonical excerpt a'}),b=api.normalizeContent({source_id:'hackernews',id:'hashed-b',url:'https://news.example/item?id=202',title:'b',abstract:'canonical excerpt b'});
 assert.equal(a.source,'hackernews');assert.equal(a.source_item_id,'hashed-a');assert.notEqual(a.content_id,b.content_id);assert.equal(a.summary,'canonical excerpt a');
});
test('raw capture feed item and canonical core item share native logical identity without discarding material versions',()=>{
 const raw={source:'hackernews',source_item_id:'101',id:'hashed-a',url:'https://news.example/item?id=101',title:'First',summary:'full provider summary',author:'author'};
 const feed={...raw,summary:'feed summary'},canonical={source_id:'hackernews',id:'hashed-a',url:raw.url,title:'First',abstract:'canonical summary',content_type:'text'};
 const raw2={source:'hackernews',source_item_id:'202',id:'hashed-b',url:'https://news.example/item?id=202',title:'Second',summary:'second'};
 const canonical2={source_id:'hackernews',id:'hashed-b',url:raw2.url,title:'Second',abstract:'canonical second'};
 const d=api.buildDataset({metadata:{session_id:'source-shape',user_id:'p',data_origin:'test_only'},environment_snapshot:{corpus:[canonical,canonical2]},slates:[{slate_id:'r',item_ids:['hashed-a'],content_snapshot:{items:[feed]}}],decisions:[{decision_id:'dec',run_id:'r',execution_results:[{status:'completed',source:'hackernews',result:{items:[canonical,canonical2]}}]}]}, {captureRecords:[{capture_id:'cap',results:[raw,raw2]}]});
 assert.equal(new Set(d.tables.contents.map(row=>row.content_id)).size,2);
 assert.ok(d.tables.contents.every(row=>row.source==='hackernews'));
 assert.deepEqual(new Set(d.tables.contents.filter(row=>row.source_item_id==='101').map(row=>row.summary)),new Set(['full provider summary','feed summary','canonical summary']));
 const expected=api.normalizeContent(raw).content_id;
 assert.ok(d.tables.contents.filter(row=>row.canonical_url===raw.url).every(row=>row.content_id===expected));
 assert.equal(d.tables.slates[0].items[0].content_version_id,api.normalizeContent(feed).content_version_id);
 // A missing feed alias can use an unambiguous recorded source URL.
 const viaUrl=api.buildDataset({metadata:{session_id:'url-only-alias',user_id:'p'},environment_snapshot:{corpus:[{...canonical,id:'another-recorded-alias'}]}},{captureRecords:[{capture_id:'cap',results:[raw]}]});
 assert.equal(new Set(viaUrl.tables.contents.map(row=>row.content_id)).size,1);
});
