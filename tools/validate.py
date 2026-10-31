#!/usr/bin/env python3
"""Check IDs, references, sparse grades, origin and storage boundaries."""
import argparse
import json
from common import load, main, validate

def run():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directory');args=parser.parse_args()
    data=load(args.directory);errors=validate(data)
    print(json.dumps({'valid':not errors,'errors':errors,'table_counts':data['manifest'].get('table_counts')}))
    if errors: raise SystemExit(1)

if __name__=='__main__': main(run)
