#!/usr/bin/env python3
"""Verify the full synthetic snapshot and recompute the reported recommendation scores."""
from collections import Counter
import gzip
import hashlib
import json
from math import isclose
from pathlib import Path
from statistics import mean
import sys

DATASET = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(DATASET / 'tools'))
from common import load, read_json  # noqa: E402
from evaluate import evaluate  # noqa: E402


def verify(root):
    data = load(root / 'main')
    manifest, tables = data['manifest'], data['tables']
    expected = read_json(root / 'metrics.json')
    assert manifest['data_origin'] == 'synthetic' and not manifest['eligible_for_analysis']
    for card in tables['contents']:
        assert not (card['title'] or card['summary'] or card['text'])
    assert all(row['request'] == {} and 'raw_response' not in row for row in tables['model_calls'])
    assert all('request' not in row and 'raw_result' not in row for row in tables['tool_calls'])

    catalog = manifest['evaluation_candidate_pool']
    pool = root / 'main' / catalog['path']
    assert hashlib.sha256(pool.read_bytes()).hexdigest() == catalog['sha256']
    with gzip.open(pool, 'rt', encoding='utf-8') as f:
        assert sum(1 for _ in f) == catalog['cards_count'] == 1000

    with gzip.open(root / 'cohort.jsonl.gz', 'rt', encoding='utf-8') as f:
        people = {row['participant_id']: row for row in map(json.loads, f)}
    assert len(people) == len(tables['participants']) == 50
    assert sum(row['rounds'] for row in people.values()) == 837
    assert {row['participant_id'] for row in tables['participants']} == set(people)
    for subset in ('behavior_ambiguity', 'interactive_revision'):
        index = read_json(root / 'subsets' / (subset + '.json'))
        assert {m['participant_id'] for m in index['members']} == {
            key for key, row in people.items() if row['subset'] == subset
        }

    studies = {row['study_id']: row for row in tables['studies']}
    ratings = {row['question_id']: row for row in tables['ratings']}
    choices = {row['question_id']: row['choice'] for row in tables['blind_choices']}
    slates = {row['slate_id']: row for row in tables['slates']}
    links = read_json(root / 'rating-links.json')
    assert len(links) == 3
    for link in links:
        slate = slates[link['slate_id']]
        item = next(row for row in slate['items'] if row['rank'] == link['rank'])
        label = ratings[link['question_id']]
        assert item.get('question_id') is None and item['label_link_status'] == 'question_material_mismatch'
        assert slate['study_id'] == label['study_id']
        assert link['material_sha256'] == label['raw_record']['material_sha256']
        item['question_id'] = link['question_id']
    scores = evaluate(data)['methods']
    assert len(ratings) == 5852 and len(choices) == 1300
    assert sum(row.get('study_id') is not None for row in tables['runs']) == 1500
    for subset, group in expected['by_subset'].items():
        ids = {key for key, row in studies.items()
               if subset == 'all' or row['source_metadata']['collection_subset'] == subset}
        assert len(ids) == group['checkpoints'] * 2
        votes = Counter()
        ballots = [q for q in tables['questions'] if q['study_id'] in ids and q['kind'] == 'blind_choice']
        assert sum(q['unavailable'] for q in ballots) == group['blind']['unavailable_choices']
        assert sum(q['question_id'] in choices for q in ballots) == group['blind']['answered_choices']
        for q in ballots:
            choice = choices.get(q['question_id'])
            shown = q['displayed_material']
            if choice not in shown:
                continue
            assert not q['unavailable'] and shown[choice]
            selected = [q['options'][letter]['method_id'] for letter, fingerprint in shown.items()
                        if fingerprint == shown[choice]]
            for method in selected:
                votes[method] += 1 / len(selected)

        for method, metrics in group['methods'].items():
            reports = [s for s in scores if s['study_id'] in ids and s['method_id'] == method]
            complete = [s for s in reports if s['delivered'] == 5]
            ranks = [s['dcg'] for s in complete if s['dcg'] is not None]
            grades = [ratings[item['question_id']]['rating_value'] for s in reports
                      for item in slates[s['slate_id']]['items']
                      if (ratings.get(item.get('question_id')) or {}).get('grade_status') == 'rated']
            assert len(complete) == metrics['complete_lists'], (subset, method, 'complete lists')
            assert len(ranks) == metrics['dcg_at_5_denominator'], (subset, method, 'rank denominator')
            assert len(grades) == metrics['rated_cards'], (subset, method, 'card denominator')
            assert isclose(mean(ranks), metrics['mean_dcg_at_5']), (subset, method, 'ranking')
            assert isclose(mean(grades), metrics['mean_card_interest']), (subset, method, 'interest')
            assert isclose(votes[method], group['blind']['votes_by_method'][method]), (subset, method, 'blind votes')

            constraints = [(study, card) for study in ids
                           for card in studies[study]['source_metadata'].get('compliance_by_card', [])
                           if card['method'] == method]
            counts = Counter(card['constraint']['status'] for _, card in constraints)
            assert all(counts[k] == v for k, v in metrics['hard_compliance'].items()), (subset, method, 'compliance')
            hard = metrics['hard_relevance']
            relevant = sum(ratings[study + ':' + card['question_id']]['rating_value'] >= hard['minimum_interest']
                           for study, card in constraints if card['constraint']['status'] == 'pass')
            assert relevant == hard['pass_and_relevant'], (subset, method, 'compliant and relevant')

    return {'passed': True, 'people': len(people), 'rounds': 837, 'checkpoints': len(studies) // 2,
            'ratings': len(ratings), 'blind_choices': len(choices), 'groups_verified': len(expected['by_subset'])}


if __name__ == '__main__':
    if not __debug__:
        raise SystemExit('Run verification without Python optimization')
    release = Path(sys.argv[1]) if len(sys.argv) == 2 else DATASET / 'releases/synthetic50-20261107'
    print(json.dumps(verify(release), ensure_ascii=False))
