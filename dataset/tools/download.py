#!/usr/bin/env python3
"""Download an authorized export; optional credentials come only from environment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from common import main

class SameOriginRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(req.full_url)[:2] != urlsplit(newurl)[:2]:
            raise ValueError('Cross-origin redirect refused to protect authentication')
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def run():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('url');parser.add_argument('output',type=Path);parser.add_argument('--sha256');args=parser.parse_args()
    url=urlsplit(args.url)
    if url.scheme!='https' and not (url.scheme=='http' and url.hostname in ('127.0.0.1','localhost','::1')): raise ValueError('Use HTTPS (HTTP allowed only for local QA)')
    if url.username or url.password: raise ValueError('URL credentials are forbidden')
    if args.output.exists(): raise ValueError('Output already exists')
    headers={'Accept':'application/gzip'}
    if os.environ.get('AWF_SESSION_COOKIE'): headers['Cookie']=os.environ['AWF_SESSION_COOKIE']
    if os.environ.get('AWF_BEARER_TOKEN'): headers['Authorization']='Bearer '+os.environ['AWF_BEARER_TOKEN']
    args.output.parent.mkdir(parents=True,exist_ok=True);temporary=None;digest=hashlib.sha256();size=0
    try:
        with tempfile.NamedTemporaryFile(prefix='.awf-download-',dir=args.output.parent,delete=False) as file:
            temporary=Path(file.name)
            with build_opener(SameOriginRedirect()).open(Request(args.url,headers=headers),timeout=60) as response:
                while True:
                    block=response.read(1024*1024)
                    if not block: break
                    size+=len(block)
                    if size>256*1024*1024: raise ValueError('Download exceeds 256 MiB compressed limit')
                    digest.update(block);file.write(block)
        if args.sha256 and digest.hexdigest()!=args.sha256.lower(): raise ValueError('SHA-256 mismatch')
        # Hard-link creation refuses an output created while the request was running.
        os.link(temporary,args.output)
    finally:
        if temporary is not None: temporary.unlink(missing_ok=True)
    print(json.dumps({'output':str(args.output),'bytes':size,'sha256':digest.hexdigest()}))

if __name__=='__main__': main(run)
