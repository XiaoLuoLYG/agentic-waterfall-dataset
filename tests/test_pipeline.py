import gzip
import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]

class Pipeline(unittest.TestCase):
    def run_tool(self, name, *args, ok=True, env=None):
        p = subprocess.run(['python3', str(ROOT/'tools'/name), *map(str,args)], text=True, capture_output=True, env=env)
        if ok:
            self.assertEqual(p.returncode, 0, p.stderr)
        else:
            self.assertNotEqual(p.returncode, 0, p.stdout)
        return p

    def make_transport(self, directory):
        code = "import {readFileSync} from 'node:fs';import {buildDataset} from './src/format.mjs';console.log(JSON.stringify(buildDataset(JSON.parse(readFileSync('./fixtures/tiny/episode.json')))));"
        p = subprocess.run(['node','--input-type=module','-e',code],cwd=ROOT,text=True,capture_output=True,check=True)
        path = directory/'transport.json.gz'
        path.write_bytes(gzip.compress(p.stdout.encode(),mtime=0))
        return path

    def test_end_to_end_preserves_sparse_labels_and_common_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp=Path(tmp);transport=self.make_transport(tmp);out=tmp/'dataset'
            self.run_tool('import_demo.py',transport,out)
            result=json.loads(self.run_tool('validate.py',out).stdout)
            self.assertTrue(result['valid'])
            ctx = json.loads(gzip.decompress((out/'contexts.jsonl.gz').read_bytes()).splitlines()[0])['context_id']
            public=json.loads(self.run_tool('build_input.py',out,'--context',ctx).stdout)
            self.assertEqual(public['provided_profile']['profile'],'A fictional tester')
            self.assertEqual([x['id'] for x in public['evidence']],['command-1'])
            self.assertNotIn('future secret',json.dumps(public));self.assertNotIn('evaluator secret',json.dumps(public));self.assertNotIn('inferred private memory',json.dumps(public))
            scores=json.loads(self.run_tool('evaluate.py',out).stdout)
            method=scores['methods'][0]
            self.assertEqual(method['rated'],1);self.assertEqual(method['unknown'],1);self.assertEqual(method['unanswered'],1)
            self.assertIsNone(method['dcg']);self.assertEqual(method['dcg_lower'],0)
            self.assertNotIn('ndcg',method)
            self.run_tool('import_demo.py',transport,out,ok=False)
            table=out/'ratings.jsonl.gz';rows=[json.loads(x) for x in gzip.decompress(table.read_bytes()).splitlines()]
            rows[0]['question_id']='missing';table.write_bytes(gzip.compress(('\n'.join(json.dumps(x) for x in rows)+'\n').encode()))
            self.run_tool('validate.py',out,ok=False)

    def test_validator_rejects_synthetic_claimed_as_eligible(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp=Path(tmp);path=self.make_transport(tmp);data=json.loads(gzip.decompress(path.read_bytes()));data['manifest']['eligible_for_analysis']=True
            path.write_bytes(gzip.compress(json.dumps(data).encode()))
            self.run_tool('import_demo.py',path,tmp/'invalid',ok=False)
            self.assertFalse((tmp/'invalid').exists())

    def test_stopped_legacy_blind_receipt_survives_import_and_validation(self):
        episode={'metadata':{'session_id':'legacy-stop','user_id':'p','data_origin':'human'},'blind_trials':[{'comparison':{'id':'old-study','study_protocol':'blind-next-v1'},'choice':None}],'research_stops':[{'id':'stop','study_id':'old-study','reason':'explicit_stop','available_at':'2026-01-01T00:00:02Z'}]}
        code="import {buildDataset} from './src/format.mjs';console.log(JSON.stringify(buildDataset(JSON.parse(process.argv[1]))));"
        result=subprocess.run(['node','--input-type=module','-e',code,json.dumps(episode)],cwd=ROOT,text=True,capture_output=True,check=True)
        with tempfile.TemporaryDirectory() as tmp:
            tmp=Path(tmp);transport=tmp/'stopped.gz';transport.write_bytes(gzip.compress(result.stdout.encode()));out=tmp/'dataset'
            self.run_tool('import_demo.py',transport,out)
            self.assertTrue(json.loads(self.run_tool('validate.py',out).stdout)['valid'])
            study=json.loads(gzip.decompress((out/'studies.jsonl.gz').read_bytes()).splitlines()[0])
            self.assertEqual(study['status'],'stopped')
            self.assertEqual(study['source_metadata']['research_stops'],episode['research_stops'])
            self.assertEqual(study['raw_record'],episode['blind_trials'][0])
            self.assertEqual(gzip.decompress((out/'blind_choices.jsonl.gz').read_bytes()),b'')

    def test_same_human_question_scores_two_methods_with_shared_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp=Path(tmp)
            code="import {buildDataset} from './src/format.mjs';const item={id:'x',source:'example',title:'fictional'};const input={captured_at:'2026-01-01T00:00:00Z',state:{profile:'declared'}};console.log(JSON.stringify(buildDataset({metadata:{session_id:'s',user_id:'p',data_origin:'human'},research_studies:[{id:'study',mode:'rating',input_snapshot:input,items:[{id:'q',item}],mappings:[{method_id:'a',rank:1,question_id:'q',item_id:'x'},{method_id:'b',rank:1,question_id:'q',item_id:'x'}],result:{methods:[{method_id:'a',slate:[item],input_snapshot:{...input,state:{memory:'private a'}}},{method_id:'b',slate:[item],input_snapshot:{...input,state:{memory:'private b'}}}]}}],content_ratings:[{id:'rating',study_id:'study',question_id:'q',content_id:'x',rating_value:3,grade_status:'rated',origin:'human'}]})));"
            p=subprocess.run(['node','--input-type=module','-e',code],cwd=ROOT,text=True,capture_output=True,check=True)
            path=tmp/'human-test.gz';path.write_bytes(gzip.compress(p.stdout.encode()));out=tmp/'dataset'
            self.run_tool('import_demo.py',path,out)
            scores=json.loads(self.run_tool('evaluate.py',out).stdout)
            self.assertEqual([row['dcg'] for row in scores['methods']],[3,3])
            self.assertFalse(scores['eligible_for_analysis'])

    def test_input_rejects_future_and_evaluator_events_inside_supplied_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp=Path(tmp);path=self.make_transport(tmp);data=json.loads(gzip.decompress(path.read_bytes()));context=data['tables']['contexts'][0]
            context['source_input_snapshot']['behavior']=[{'id':'future','kind':'command','track':'feed','text':'future secret','available_at':'2026-01-01T00:00:05Z'},{'id':'eval','kind':'command','track':'evaluation','text':'evaluator secret','available_at':'2026-01-01T00:00:01Z'},{'id':'wrong-user','kind':'command','track':'feed','user_id':'someone-else','text':'another private user','available_at':'2026-01-01T00:00:01Z'}]
            path.write_bytes(gzip.compress(json.dumps(data).encode()));out=tmp/'dataset';self.run_tool('import_demo.py',path,out)
            projected=json.loads(self.run_tool('build_input.py',out,'--context',context['context_id']).stdout)
            self.assertEqual([row['id'] for row in projected['evidence']],['command-1'])

    def test_multiple_participants_and_repeat_transport_merge_without_profile_collision(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp=Path(tmp)
            code="import {buildDataset} from './src/format.mjs';let id=process.argv[1];console.log(JSON.stringify(buildDataset({metadata:{session_id:'session-'+id,user_id:'participant-'+id,data_origin:'test_only'},initial_snapshot:{user_state:{profile:'same declared profile'}}})));"
            paths=[]
            for id in ('a','b'):
                p=subprocess.run(['node','--input-type=module','-e',code,id],cwd=ROOT,text=True,capture_output=True,check=True)
                path=tmp/(id+'.gz');path.write_bytes(gzip.compress(p.stdout.encode()));paths.append(path)
            out=tmp/'merged';self.run_tool('import_demo.py',*paths,paths[0],out)
            result=json.loads(self.run_tool('validate.py',out).stdout)
            self.assertEqual(result['table_counts']['participants'],2)
            self.assertEqual(result['table_counts']['profiles'],2)
            self.assertEqual(result['table_counts']['sessions'],2)
            changed=json.loads(gzip.decompress(paths[0].read_bytes()));changed['tables']['participants'][0]['identity_scope']='conflicting'
            conflict=tmp/'conflict.gz';conflict.write_bytes(gzip.compress(json.dumps(changed).encode()))
            self.run_tool('import_demo.py',paths[0],conflict,tmp/'conflict-out',ok=False)
            self.assertFalse((tmp/'conflict-out').exists())

    def test_download_checks_hash_and_keeps_existing_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp=Path(tmp);transport=self.make_transport(tmp)
            class Handler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    body=transport.read_bytes();self.send_response(200);self.end_headers();self.wfile.write(body)
                def log_message(self,*args): pass
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                url=f'http://127.0.0.1:{server.server_port}/export';out=tmp/'download.gz'
                self.run_tool('download.py',url,out,'--sha256',hashlib.sha256(transport.read_bytes()).hexdigest())
                self.assertEqual(out.read_bytes(),transport.read_bytes())
                self.run_tool('download.py',url,tmp/'bad.gz','--sha256','0'*64,ok=False)
                self.assertFalse((tmp/'bad.gz').exists());self.run_tool('download.py',url,out,ok=False)
            finally: server.shutdown();server.server_close();thread.join()

    def test_live_input_and_provenance_survive_import_without_evaluator_leakage(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp=Path(tmp)
            code="import {buildDataset} from './src/format.mjs';import {liveEpisode} from './tests/live-fixture.mjs';console.log(JSON.stringify(buildDataset(liveEpisode())));"
            result=subprocess.run(['node','--input-type=module','-e',code],cwd=ROOT,text=True,capture_output=True,check=True)
            data=json.loads(result.stdout);context=data['tables']['contexts'][0]
            transport=tmp/'live.gz';transport.write_bytes(gzip.compress(result.stdout.encode()))
            out=tmp/'dataset';self.run_tool('import_demo.py',transport,out)
            self.assertTrue(json.loads(self.run_tool('validate.py',out).stdout)['valid'])
            projected=json.loads(self.run_tool('build_input.py',out,'--context',context['context_id']).stdout)
            self.assertEqual(projected,context['environment']['public_input'])
            evidence=context['environment']['public_input']['evidence']
            evidence.extend([{'id':'label','type':'command','annotation_policy':'evaluation_only','text':'evaluator secret','available_at':'2026-01-01T00:00:01Z'}, {'id':'future','type':'command','text':'future secret','available_at':'2026-01-01T00:00:05Z'}])
            transport=tmp/'tampered.gz';transport.write_bytes(gzip.compress(json.dumps(data).encode()))
            out=tmp/'filtered';self.run_tool('import_demo.py',transport,out)
            filtered=json.loads(self.run_tool('build_input.py',out,'--context',context['context_id']).stdout)
            self.assertEqual([row['id'] for row in filtered['evidence']],['prior-command'])

if __name__=='__main__':unittest.main()
