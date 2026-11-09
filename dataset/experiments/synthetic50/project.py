"""Build a metadata-only archive from the reviewed local synthetic run."""
from collections import Counter
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

read = lambda path: json.loads(path.read_text())
write = lambda path, value: path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as f:
        for data in iter(lambda: f.read(1024 * 1024), b''):
            sha.update(data)
    return sha.hexdigest()

def rows(path):
    with gzip.open(path, 'rt', encoding='utf-8') as f:
        yield from map(json.loads, f)

def emit(path, records):
    count = 0
    with path.open('xb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as stream:
        with io.TextIOWrapper(stream, encoding='utf-8') as output:
            for row in records:
                output.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
                count += 1
    return count

def pick(row, names):
    return {key: row[key] for key in names.split() if key in row}

def material_hash(value):
    if value is None:
        return None
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()

# shortcut: this snapshot uses a fixed source roster; review new hosts before another export.
safe_hosts = {
    'www.bilibili.com': {'p': r'\d+'},
    'www.youtube.com': {'v': r'[\w-]{11}'},
    'news.ycombinator.com': {'id': r'\d+'},
    'podcasts.apple.com': {'i': r'\d+'},
    **dict.fromkeys('zhuanlan.zhihu.com www.zhihu.com www.reddit.com github.com x.com www.chinanews.com.cn www.ithome.com prtimes.jp zh.wikipedia.org www.ifanr.com www.twitch.tv sspai.com nwknews.jp movie.douban.com news4vip.livedoor.biz itaishinja.com michaelsan.livedoor.biz'.split(), {}),
}

def public_url(value):
    url = urlsplit(value)
    assert url.scheme in ('http', 'https') and url.hostname in safe_hosts
    assert url.username is None and url.password is None and url.netloc == url.hostname
    allow = safe_hosts[url.hostname]
    query = [(key, val) for key, val in parse_qsl(url.query) if key in allow and re.fullmatch(allow[key], val, re.ASCII)]
    return urlunsplit((url.scheme, url.hostname, url.path, urlencode(query), ''))

ref = 'content_id content_version_id original_item_id material_status'
evidence = 'type id value content_id content_hash reference_id exposure_id position session_id source modality visible_ms event_time available_at'
allow = {
    'participants': 'participant_id data_origin identity_scope',
    'profiles': 'profile_id participant_id session_id profile_origin method_id',
    'sessions': 'session_id participant_id data_origin started_at ended_at provided_profile_id',
    'events': 'event_id session_id participant_id type occurred_at available_at annotation_policy ' + ref,
    'contexts': 'context_id session_id participant_id owner_ref cutoff_at provided_profile_id inferred_profile_id history_completeness annotation_policy',
    'runs': 'run_id session_id participant_id method_id status context_id inferred_profile_id study_id artifact_status',
    'slates': 'slate_id run_id session_id study_id method_id available_at',
    'studies': 'study_id session_id mode context_id context_hash protocol status annotation_policy source_record_id unmaterialized_fields',
    'questions': 'question_id original_question_id study_id kind rank mapping material_sha256 unavailable same_content annotation_policy ' + ref,
    'presentations': 'presentation_id session_id study_id question_id available_at annotation_policy ' + ref,
    'ratings': 'rating_id session_id study_id question_id rating_value grade_status data_origin available_at annotation_policy ' + ref,
    'blind_choices': 'blind_choice_id session_id study_id question_id choice data_origin available_at annotation_policy',
    'model_calls': 'model_call_id run_id context_id source_call_id phase status retry_of started_at completed_at',
    'tool_calls': 'tool_call_id session_id run_id context_id kind source_call_id operation source status retry_of depends_on dependency_origin started_at completed_at',
}

def profile(row):
    return pick(row, 'profile interests')

def project(table, row):
    if table == 'contents':
        card = pick(row, 'content_id content_version_id source capture_scope')
        card['canonical_url'] = public_url(row['canonical_url'])
        card['metadata'] = pick(row['metadata'], 'modality content_type language published_at duration')
        return dict(card, title='', summary='', text='', text_status='not_returned',
                    text_original_length=0, summary_original_length=0)
    out = pick(row, allow[table])
    if table == 'profiles':
        out['profile'] = profile(row['profile']) if row['profile_origin'] == 'provided' else {}
    if table == 'events':
        payload = row.get('payload') or {}
        out['payload'] = pick(payload, 'pilot_round sequence phase value reference_id exposure_id content_hash source position simulated visible_ms')
        if row['type'] == 'command':
            assert payload['simulated'] is True
            out['payload']['text'] = payload['text']
    if table == 'contexts':
        out['source_input_snapshot'] = pick(row['source_input_snapshot'], 'id captured_at hash command')
        public = row['environment']['public_input']
        out['environment'] = {
            'public_input': {
                'provided_profile': profile(public['provided_profile']),
                'evidence': [pick(event, evidence + (' text' if event['type'] == 'command' else ''))
                             for event in public['evidence']],
            }
        }
    if table == 'runs' and row.get('metadata'):
        out['metadata'] = pick(row['metadata'], 'method_version runtime_source_sha256 original_ordered_item_ids resources source_run_id source_run_sha256')
    if table == 'slates':
        out['items'] = [pick(item, 'rank question_id label_link_status ' + ref) for item in row['items']]
    if table == 'studies':
        out['source_metadata'] = pick(row['source_metadata'], 'collection_subset checkpoint_round blind_study_id rating_study_id')
        if 'compliance_by_card' in row['source_metadata']:
            out['source_metadata']['compliance_by_card'] = [
                dict(pick(card, 'method rank question_id'),
                     constraint=pick(card['constraint'], 'status requirements source modality duration_seconds'))
                for card in row['source_metadata']['compliance_by_card']
            ]
    if table == 'questions' and row['kind'] == 'blind_choice':
        out['options'] = {key: pick(option, 'method_id slate_id ' + ref) for key, option in row['options'].items()}
        out['displayed_material'] = {key: material_hash(value) for key, value in row['displayed_material'].items()}
    if table in ('ratings', 'blind_choices'):
        out['raw_record'] = pick(row['raw_record'], 'material_sha256 origin provider_model evaluated_at rubric_version annotation_source')
    if table == 'model_calls':
        out['request'] = {}
    if table == 'tool_calls':
        out['results'] = [pick(result, 'rank ' + ref) for result in row['results']]
    return out

def build(root, release):
    dataset = root / 'dataset'
    original = dataset / 'main'
    main = release / 'main'
    main.mkdir(parents=True)
    archive_manifest = read(original / 'manifest.json')
    assert archive_manifest['data_origin'] == 'synthetic'
    assert archive_manifest['data_license'] == 'pending'
    actual = {}
    for table, filename in archive_manifest['table_files'].items():
        assert filename == table + '.jsonl.gz'
        actual[table] = emit(main / filename, (project(table, row) for row in rows(original / filename)))
    assert actual == archive_manifest['table_counts']
    manifest = pick(archive_manifest, 'dataset_id source_schema_version exported_at data_origin eligible_for_analysis analysis_eligibility_reason history_completeness data_license code_license source_record_provenance table_files table_counts schema_version collection_protocol trajectory_source collection_stage evaluation_coverage')
    manifest['projection'] = {
        'kind': 'metadata_only_synthetic_snapshot',
        'source_manifest_sha256': digest(original / 'manifest.json'),
        'content_version_ids_and_snapshot_hashes': 'refer_to_original_private_payloads',
        'synthetic_personas': '../cohort.jsonl.gz',
    }
    manifest['content_pool'] = {
        'file': 'contents.jsonl.gz', 'sha256': digest(main / 'contents.jsonl.gz'),
        'content_versions': actual['contents'],
    }
    frozen = archive_manifest['evaluation_candidate_pool']
    pool = (original / frozen['path']).resolve()
    assert digest(pool) == frozen['cards_sha256']
    pool_path = release / 'evaluation-candidates.jsonl.gz'
    pool_count = emit(pool_path, (project('contents', row) for row in rows(pool)))
    assert pool_count == frozen['cards_count'] == 1000
    manifest['evaluation_candidate_pool'] = dict(
        pick(frozen, 'cards_count selected_sources selection_sha256 candidate_policy'),
        path='../' + pool_path.name, sha256=digest(pool_path), original_archive_sha256=frozen['cards_sha256'],
    )
    write(main / 'manifest.json', manifest)
    write(main / 'artifact_refs.json', [])

    (release / 'subsets').mkdir()
    for subset in ('behavior_ambiguity', 'interactive_revision'):
        index = read(dataset / 'subsets' / (subset + '.json'))
        assert len(index['members']) == 20 and index['main'] == '../main'
        write(release / 'subsets' / (subset + '.json'), index)

    def cohort():
        for user in sorted((root / 'users').iterdir()):
            persona = read(user / 'persona.json')
            assert persona['id'] == user.name and persona['origin'] == 'synthetic'
            with (user / 'events.jsonl').open() as events:
                start = json.loads(next(events))
            with (user / 'trajectory.jsonl').open() as trajectory:
                rounds = sum(1 for _ in trajectory)
            yield dict(pick(persona, 'id subset pair origin public_profile public_interests hidden_profile phases'),
                       participant_id=start['participant_id'], session_id=start['session_id'], rounds=rounds)

    personas = list(cohort())
    assert len(personas) == actual['participants'] == 50
    assert sum(p['rounds'] for p in personas) == 837
    assert Counter(p['subset'] for p in personas) == {'general': 10, 'behavior_ambiguity': 20, 'interactive_revision': 20}
    emit(release / 'cohort.jsonl.gz', personas)

    analysis = read(root / 'comparison' / 'analysis.json')
    progress = read(root / 'progress.json')
    assert analysis['status'] == progress['status'] == 'completed'
    assert analysis['coverage']['done'] == 1500 and analysis['coverage']['contexts_done'] == 300
    assert analysis['integrity']['passed'] and not analysis['failures']
    write(release / 'metrics.json', pick(analysis, 'status data_origin method_ids config_sha256 coverage integrity by_subset'))

    # The standard formatter withheld three direct links on version mismatches.
    # Preserve the original grading assignments separately for paper metrics.
    sessions = {row['id']: row['session_id'] for row in personas}
    cutoffs = {(row['session_id'], row['source_metadata']['checkpoint_round']): row['study_id']
               for row in rows(main / 'studies.jsonl.gz') if row['mode'] == 'rating'}
    ratings = {row['question_id']: row for row in rows(main / 'ratings.jsonl.gz')}
    slates = {row['slate_id']: row for row in rows(main / 'slates.jsonl.gz') if row.get('study_id')}
    links = []
    for cutoff in analysis['checkpoints']:
        user, round_ = cutoff['user'], cutoff['round']
        study = cutoffs[sessions[user], round_]
        for method, results in cutoff['methods'].items():
            slate = slates[study + ':' + method]
            assert len(slate['items']) == len(results['cards'])
            for item, card in zip(slate['items'], results['cards']):
                assert item['rank'] == card['rank'] and item['original_item_id'] == card['material']['id']
                question = study + ':' + card['question_id']
                assert ratings[question]['rating_value'] == card['interest']['rating']
                if item.get('question_id') != question:
                    assert item.get('question_id') is None and item['label_link_status'] == 'question_material_mismatch'
                    directory = root / 'comparison' / 'studies' / user / str(round_)
                    match = next(row for row in read(directory / 'mapping.json')['cards']
                                 if row['method'] == method and row['rank'] == card['rank'])
                    assert match['item_id'] == card['material']['id'] and match['question_id'] == card['question_id']
                    assert match['material_sha256'] == ratings[question]['raw_record']['material_sha256']
                    links.append(dict(slate_id=slate['slate_id'], rank=card['rank'], question_id=question,
                                      material_sha256=match['material_sha256']))
    assert len(links) == 3
    write(release / 'rating-links.json', links)


if __name__ == '__main__':
    if len(sys.argv) != 3 or not __debug__:
        raise SystemExit('Usage: python3 project.py PRIVATE_RUN NEW_OUTPUT_DIR (without -O)')
    private_run, output = [Path(p).resolve() for p in sys.argv[1:]]
    if output.exists():
        raise SystemExit('Output already exists')
    with TemporaryDirectory(prefix='.synthetic-projection-', dir=output.parent) as temp:
        prepared = Path(temp) / 'release'
        build(private_run, prepared)
        if output.exists():
            raise SystemExit('Output already exists')
        prepared.rename(output)
