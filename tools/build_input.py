#!/usr/bin/env python3
"""Project provided profile and cutoff-safe natural history; no evaluator labels."""
import argparse
from datetime import datetime, timezone
import json
from common import load, main, validate

FIELDS=('id','value','text','content_id','content_hash','reference_id','exposure_id','position','session_id','title','topic','source','visible_ms','event_time','available_at')

def timestamp(value):
    if not isinstance(value,str): raise ValueError('Missing or invalid cutoff/event timestamp')
    value=datetime.fromisoformat(value.replace('Z','+00:00'))
    if value.tzinfo is None: raise ValueError('Timestamp must include timezone')
    return value.astimezone(timezone.utc)

def build(data, context_id):
    errors=validate(data)
    if errors: raise ValueError('; '.join(errors))
    context=next((row for row in data['tables']['contexts'] if row['context_id']==context_id),None)
    if context is None: raise ValueError('Unknown context')
    cutoff=timestamp(context['cutoff_at']);snapshot=context['source_input_snapshot'];events={}
    profile=next(row['profile'] for row in data['tables']['profiles'] if row['profile_id']==context['provided_profile_id'])
    candidates=list(snapshot.get('behavior',[]))
    candidates += [{**row,'kind':'command','text':row.get('command',row.get('text',''))} for row in snapshot.get('recent_commands',[])]
    if snapshot.get('command'): candidates.append({'id':snapshot.get('command_event_id',snapshot.get('id')),'kind':'command','text':snapshot['command'],'available_at':context['cutoff_at']})
    # Source snapshot is the exact supplied context; do not add unrelated export history.
    for row in candidates:
        kind=row.get('kind',row.get('type'))
        if row.get('track','feed')!='feed' or row.get('annotation_policy')=='evaluation_only': continue
        if row.get('user_id',context['participant_id'])!=context['participant_id']:continue
        if kind not in ('command','feedback','open','return','exposure'):continue
        if kind=='exposure' and row.get('phase') not in (None,'end'):continue
        if kind=='feedback' and row.get('value') not in ('like','dislike','save','unsave','comment'):continue
        times=[row[key] for key in ('available_at','event_time') if row.get(key)]
        if not times or any(timestamp(value)>cutoff for value in times):continue
        event={'type':kind,**{key:row[key] for key in FIELDS if key in row}}
        events[row.get('id') or json.dumps(event,sort_keys=True)]=event
    evidence=sorted(events.values(),key=lambda row:timestamp(row.get('available_at',row.get('event_time'))))
    return {'provided_profile':profile,'evidence':evidence}

def run():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directory');parser.add_argument('--context',required=True);args=parser.parse_args()
    print(json.dumps(build(load(args.directory),args.context),ensure_ascii=False))

if __name__=='__main__': main(run)
