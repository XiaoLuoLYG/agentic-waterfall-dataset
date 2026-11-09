"""Author i2Agent, ClawRec packets and full hybrid ranking for live-returned items."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    root = Path(sys.argv[1]).resolve()
    request = json.loads(sys.stdin.readline())
    operation = request['operation']
    if operation == 'i2agent':
        sys.path.insert(0, str(root / 'i2agent'))
        from adapter import prepare_task, run_i2agent
        from live_smoke import convert_request
        task, mapping = prepare_task(request['history'], request['candidates'], request['contrast'], request['instruction'])

        def model(source):
            converted = convert_request(source, rank_max_tokens=4096)
            print(json.dumps({'type': 'model_request', 'request': converted, 'json_schema': source['response_format']['json_schema']}, ensure_ascii=False), flush=True)
            response = json.loads(sys.stdin.readline())
            if response.get('type') != 'model_response':
                raise RuntimeError(response.get('error', 'Node model transport failed'))
            return response['value']

        result = run_i2agent(task, model)
        value = {**result, 'ordered_item_ids': [mapping[i] for i in result['ordered_indices']]}
    elif operation == 'packets':
        builder = root / 'clawrec/source-snapshot/clawrec-synthesizing-user-state/scripts/build_update_packets.py'
        records = request['records']
        if not isinstance(records, list):
            raise ValueError('packet records must be a list')
        result = subprocess.run([sys.executable, str(builder), '--input', '-'], input='\n'.join(json.dumps(row, ensure_ascii=False) for row in records), capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise ValueError('author packet builder failed: ' + result.stderr[-2000:])
        value = {'packets': result.stdout, 'record_count': len(records)}
    elif operation == 'fixed':
        sys.path.insert(0, str(root / 'fixed-retrieval'))
        from retrieval import build_index, search, validate_catalog
        if request.get('index_path'):
            # Existing offline QA callers keep their separate explicit frozen-index contract.
            index = Path(request['index_path']).resolve()
            metadata = json.loads((index / 'index.json').read_text())
            known = {str(item['id']): item['text'] for item in metadata['catalog']}
            for item in request['catalog']:
                if known.get(item['id']) != item['title'] + '\n' + item['text']:
                    raise ValueError('fixed index does not match shared frozen catalog')
            value = search(index, request['query'], request['eligible_ids'], request['exclude_ids'], None)
        else:
            catalog = validate_catalog(request['catalog'])
            with tempfile.TemporaryDirectory(prefix='awf-live-hybrid-') as temporary:
                path = Path(temporary)
                catalog_file = path / 'catalog.json'
                catalog_file.write_text(json.dumps(catalog, ensure_ascii=False))
                build_index(catalog_file, path / 'index')
                value = search(path / 'index', request['query'])
                value['catalog_sha256'] = json.loads((path / 'index/index.json').read_text())['catalog_sha256']
                value['catalog_count'] = len(catalog)
    elif operation == 'search':
        # Retained for isolated offline tests; the live runner never requests this operation.
        sys.path.insert(0, str(root / 'simbench'))
        from catalog import FrozenCatalog
        value = FrozenCatalog(request['catalog']).search(request['source'], request['query'], request['limit'], request['as_of_ms'])
    else:
        raise ValueError('unsupported research Python operation')
    print(json.dumps({'type': 'result', 'value': value}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'type': 'error', 'error': f'{type(error).__name__}: {error}'}, ensure_ascii=False), flush=True)
        raise SystemExit(1)
