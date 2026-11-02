#!/usr/bin/env python3
"""Report sparse label coverage and DCG; never substitute zero for an unjudged item."""
import argparse
import json
import math
from common import load, main, validate

def evaluate(data):
    errors=validate(data)
    if errors: raise ValueError('; '.join(errors))
    ratings={}
    for row in data['tables']['ratings']:
        if row['question_id'] in ratings: raise ValueError('Duplicate rating for question')
        ratings[row['question_id']]=row
    reports=[]
    for slate in data['tables']['slates']:
        if not slate.get('study_id'):continue
        rated=unknown=unanswered=0;lower=upper=0;seen=set()
        for item in slate['items']:
            rank=item.get('rank')
            if type(rank) is not int or rank<1 or rank in seen:raise ValueError('Invalid or duplicate slate rank')
            seen.add(rank);answer=ratings.get(item.get('question_id'));discount=math.log2(rank+1)
            if answer and answer.get('grade_status')=='rated':
                rated+=1;gain=answer['rating_value']/discount;lower+=gain;upper+=gain
            else:
                unknown+=int(answer is not None);unanswered+=int(answer is None);upper+=3/discount
        total=len(slate['items']);complete=total>0 and not unknown and not unanswered
        reports.append({'study_id':slate['study_id'],'method_id':slate['method_id'],'slate_id':slate['slate_id'],'delivered':total,'rated':rated,'unknown':unknown,'unanswered':unanswered,'coverage':rated/total if total else None,'dcg':lower if complete else None,'dcg_lower':lower,'dcg_upper':upper,'gain':'rating_value (linear 0..3)','status':'fully_judged' if complete else 'insufficient_labels'})
    choices=data['tables']['blind_choices'];counts={}
    for row in choices:counts[row.get('choice','unknown')]=counts.get(row.get('choice','unknown'),0)+1
    return {'schema_version':'awf-evaluation/1.0','data_origin':data['manifest'].get('data_origin'),'eligible_for_analysis':data['manifest'].get('eligible_for_analysis',False),'methods':reports,'blind_choice_counts':counts,'normalization':'No NDCG: no shared fully judged candidate pool is provided.'}

def run():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directory');args=parser.parse_args();print(json.dumps(evaluate(load(args.directory)),ensure_ascii=False))

if __name__=='__main__': main(run)
