#!/usr/bin/env python3
"""Merge owner-authorized gzip transports without overwriting data."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
from common import TABLES, KEYS, VERSION, main, validate, write_json

def run():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('transports',type=Path,nargs='+');parser.add_argument('output',type=Path);args=parser.parse_args()
    if args.output.exists(): raise ValueError('Output already exists; choose a new directory')
    by_table={name:{} for name in TABLES};manifests={};artifacts={}
    for transport in args.transports:
        with gzip.open(transport,'rb') as file:
            raw=file.read(1024**3+1)
        if len(raw)>1024**3: raise ValueError('Transport exceeds 1 GiB decompressed limit')
        data=json.loads(raw);errors=validate(data)
        if errors: raise ValueError('; '.join(errors))
        for name in TABLES:
            for row in data['tables'][name]:
                key=row[KEYS[name]]
                if key in by_table[name] and by_table[name][key]!=row: raise ValueError('Conflicting '+name+' primary key: '+key)
                by_table[name][key]=row
        key=json.dumps(data['manifest'],sort_keys=True,separators=(',',':'));manifests[key]=data['manifest']
        for artifact in data.get('artifact_refs',[]): artifacts[json.dumps(artifact,sort_keys=True)]=artifact
    sources=list(manifests.values());tables={name:list(rows.values()) for name,rows in by_table.items()}
    if len(sources)==1: manifest=dict(sources[0])
    else:
        origins={source.get('data_origin','unknown') for source in sources}
        manifest={'dataset_id':'merged:'+hashlib.sha256('\n'.join(sorted(source['dataset_id'] for source in sources)).encode()).hexdigest(),'source_schema_version':'multiple','exported_at':max((source.get('exported_at') or '' for source in sources),default='') or None,'data_origin':next(iter(origins)) if len(origins)==1 else 'mixed','eligible_for_analysis':False,'analysis_eligibility_reason':'merged_release_requires_protocol_and_consent_review','history_completeness':'referenced_snapshots_only','data_license':'pending','code_license':'MIT','source_datasets':[{'dataset_id':source['dataset_id'],'exported_at':source.get('exported_at'),'data_origin':source.get('data_origin')} for source in sources],'source_record_provenance':'normalized_available_fields_only_original_episodes_not_duplicated'}
    manifest['table_files']={name:name+'.jsonl.gz' for name in TABLES};manifest['table_counts']={name:len(rows) for name,rows in tables.items()}
    data={'schema_version':VERSION,'manifest':manifest,'tables':tables,'artifact_refs':list(artifacts.values())}
    errors=validate(data)
    if errors: raise ValueError('; '.join(errors))
    args.output.parent.mkdir(parents=True,exist_ok=True)
    temporary=Path(tempfile.mkdtemp(prefix='.awf-import-',dir=args.output.parent))
    try:
        manifest={**data['manifest'],'schema_version':data['schema_version']}
        for name in TABLES:
            with (temporary/(name+'.jsonl.gz')).open('wb') as file:
                with gzip.GzipFile(fileobj=file,mode='wb',mtime=0,filename='') as compressed:
                    for row in data['tables'][name]: compressed.write((json.dumps(row,ensure_ascii=False,separators=(',',':'))+'\n').encode())
        write_json(temporary/'manifest.json',manifest);write_json(temporary/'artifact_refs.json',data.get('artifact_refs',[]))
        temporary.rename(args.output)
    finally:
        if temporary.exists(): shutil.rmtree(temporary)
    print(json.dumps({'directory':str(args.output),'rows':sum(len(data['tables'][name]) for name in TABLES)}))

if __name__=='__main__': main(run)
