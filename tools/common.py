"""Shared on-disk contract; standard library only."""
import gzip
import json
from pathlib import Path
import re
import sys

TABLES = ('contents','participants','profiles','sessions','events','contexts','runs','slates','studies','questions','presentations','ratings','blind_choices','model_calls','tool_calls')
KEYS = dict(zip(TABLES, ('content_version_id','participant_id','profile_id','session_id','event_id','context_id','run_id','slate_id','study_id','question_id','presentation_id','rating_id','blind_choice_id','model_call_id','tool_call_id')))
VERSION = 'awf-dataset/1.0'
SECRET = re.compile(r'^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credentials)$', re.I)

def read_json(path):
    with Path(path).open(encoding='utf-8') as file:
        return json.load(file)

def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

def load(directory):
    directory = Path(directory)
    manifest = read_json(directory/'manifest.json')
    tables = {}
    for name in TABLES:
        if manifest.get('table_files', {}).get(name) != name+'.jsonl.gz':
            raise ValueError('Unexpected table filename: '+name)
        with gzip.open(directory/(name+'.jsonl.gz'), 'rt', encoding='utf-8') as file:
            tables[name] = [json.loads(line) for line in file if line.strip()]
    return {'schema_version': manifest.get('schema_version'), 'manifest': manifest, 'tables': tables, 'artifact_refs': read_json(directory/'artifact_refs.json')}

def validate(data):
    errors = []
    if data.get('schema_version') != VERSION:
        errors.append('Unsupported schema_version')
    tables, manifest = data.get('tables', {}), data.get('manifest', {})
    if set(tables) != set(TABLES):
        errors.append('Tables must match awf-dataset/1.0')
        return errors
    indices = {}
    for name in TABLES:
        rows = tables[name]
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            errors.append('Rows must be objects: '+name)
            return errors
        ids = [row.get(KEYS[name]) for row in rows]
        if any(not isinstance(key, str) or not key for key in ids) or len(set(ids)) != len(ids):
            errors.append('Missing or duplicate primary key: '+name)
        indices[name] = set(ids)
        if manifest.get('table_counts', {}).get(name) != len(rows):
            errors.append('Count mismatch: '+name)
    refs = {'participant_id':'participants','provided_profile_id':'profiles','inferred_profile_id':'profiles','context_id':'contexts','run_id':'runs','study_id':'studies','question_id':'questions','content_version_id':'contents'}
    # Prior-session evidence can reference an external session; its source row remains explicit.
    for name in TABLES:
        def walk(value, primary=False):
            if isinstance(value, dict):
                for key, item in value.items():
                    if SECRET.fullmatch(key): errors.append('Credential field in '+name)
                    if key in refs and not (primary and key == KEYS[name]) and item is not None and item not in indices[refs[key]]:
                        errors.append('Dangling '+key+' in '+name+': '+str(item))
                    if key not in ('raw_record','source_input_snapshot','request','raw_result','payload','profile','normalized_output','parsed_output','metadata','environment','source_metadata','receipt','raw_response'):
                        walk(item)
            elif isinstance(value, list):
                for item in value: walk(item)
        for row in tables[name]: walk(row, True)
    def secrets(value):
        if isinstance(value, dict):
            return any(SECRET.fullmatch(key) or secrets(item) for key,item in value.items())
        if isinstance(value, list): return any(secrets(item) for item in value)
        return False
    if secrets(data): errors.append('Credential fields are forbidden')
    for row in tables['contents']:
        if not row.get('content_id') or not row.get('source') or row.get('text_status') not in ('stored','truncated','not_returned'):
            errors.append('Invalid content material identity/status')
        if len(row.get('text','')) > 100000 or len(row.get('summary','')) > 100000:
            errors.append('Content text exceeds capture limit')
    for row in tables['ratings']:
        value = row.get('rating_value')
        if row.get('grade_status') == 'rated':
            if type(value) is not int or not 0 <= value <= 3: errors.append('Rated label must be integer 0..3')
        elif value is not None: errors.append('Unknown/unable labels must retain null grade')
        if row.get('annotation_policy') != 'evaluation_only': errors.append('Labels must be evaluation_only')
    origins = {row.get('data_origin') for row in tables['participants']}
    if not origins <= {'human','synthetic','test_only','unknown'}: errors.append('Invalid participant origin')
    if manifest.get('eligible_for_analysis') and (origins != {'human'} or manifest.get('data_origin') != 'human'):
        errors.append('Synthetic/test/unknown origin cannot be eligible for human analysis')
    return sorted(set(errors))

def main(action):
    try:
        action()
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
