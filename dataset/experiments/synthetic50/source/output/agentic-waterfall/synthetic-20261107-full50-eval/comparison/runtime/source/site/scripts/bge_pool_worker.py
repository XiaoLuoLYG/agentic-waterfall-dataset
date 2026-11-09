"""Serial JSONL BM25+BGE worker; same fp32/CLS/512/batch-8/RRF(60) ranking as retrieval.py."""
import json
import os
import resource
import sys
import time

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

from retrieval import ROOT, validate_catalog, tokenize, reciprocal_rank_fusion, models


class PersistentHybridRanker:
    def __init__(self):
        import numpy as np
        from rank_bm25 import BM25Okapi
        started = time.perf_counter()
        self.np, self.BM25Okapi = np, BM25Okapi
        self.torch, tokenizer_cls, encoder_cls, reranker_cls, self.device = models()
        self.encoder_tokenizer = tokenizer_cls.from_pretrained(ROOT / 'weights/bge-m3', local_files_only=True)
        self.encoder = encoder_cls.from_pretrained(ROOT / 'weights/bge-m3', local_files_only=True).to(self.device).eval()
        self.reranker_tokenizer = tokenizer_cls.from_pretrained(ROOT / 'weights/bge-reranker-v2-m3', local_files_only=True)
        self.reranker = reranker_cls.from_pretrained(ROOT / 'weights/bge-reranker-v2-m3', local_files_only=True).to(self.device).eval()
        self.document_cache = None
        self.model_loads, self.requests = 2, 0
        self.load_ms = 1000 * (time.perf_counter() - started)

    def vectors(self, texts):
        vectors = []
        with self.torch.inference_mode():
            for start in range(0, len(texts), 8):
                batch = self.encoder_tokenizer(texts[start:start + 8], padding=True, truncation=True, max_length=512, return_tensors='pt').to(self.device)
                value = self.encoder(**batch).last_hidden_state[:, 0, :].float()
                vectors.append(self.torch.nn.functional.normalize(value, p=2, dim=1).cpu().numpy())
        return self.np.concatenate(vectors, axis=0)

    def document_vectors(self, catalog, pool=None):
        build_ms = None
        if pool is not None:
            if self.document_cache is not None:
                raise ValueError('frozen BGE document cache already initialized')
            started = time.perf_counter()
            full = validate_catalog(pool)
            matrix = self.vectors([item['text'] for item in full])
            if matrix.shape[0] != len(full) or not self.np.isfinite(matrix).all():
                raise ValueError('invalid frozen BGE document vectors')
            self.document_cache = matrix, {item['id']: (i, item['text']) for i, item in enumerate(full)}
            build_ms = 1000 * (time.perf_counter() - started)
        if self.document_cache is None:
            return self.vectors([item['text'] for item in catalog]), {'status': 'cold', 'encoded_documents': len(catalog)}
        matrix, items = self.document_cache
        indices = []
        for item in catalog:
            found = items.get(item['id'])
            if found is None or found[1] != item['text']:
                raise ValueError('eligible BGE item differs from frozen document cache')
            indices.append(found[0])
        return matrix[indices], {'status': 'built' if build_ms is not None else 'hit',
                                 'pool_count': len(items), 'encoded_documents': len(items) if build_ms is not None else 0,
                                 'build_ms': build_ms}

    def rank(self, request):
        started = time.perf_counter()
        catalog, query = validate_catalog(request['catalog']), request['query']
        if not isinstance(query, str) or not query.strip():
            raise ValueError('live fixed retrieval requires a nonempty visible query')
        vectors, document_cache = self.document_vectors(catalog, request.get('pool_catalog'))
        query_vector = self.vectors([query])[0]
        lexical = self.BM25Okapi([tokenize(item['text']) for item in catalog]).get_scores(tokenize(query))
        dense = vectors @ query_vector
        lexical_ids = [catalog[i]['id'] for i in self.np.argsort(-lexical, kind='stable')[:100]]
        dense_ids = [catalog[i]['id'] for i in self.np.argsort(-dense, kind='stable')[:100]]
        acquired = reciprocal_rank_fusion(lexical_ids, dense_ids, 100)
        items, scores = {item['id']: item for item in catalog}, []
        with self.torch.inference_mode():
            for start in range(0, len(acquired), 8):
                batch = acquired[start:start + 8]
                encoded = self.reranker_tokenizer([query] * len(batch), [items[item_id]['text'] for item_id in batch], padding=True, truncation=True, max_length=512, return_tensors='pt').to(self.device)
                scores.extend(self.reranker(**encoded).logits.view(-1).float().cpu().tolist())
        if not self.np.isfinite(vectors).all() or not self.np.isfinite(scores).all():
            raise ValueError('invalid embedding or reranker scores')
        ordered = sorted(zip(acquired, scores), key=lambda item: (-item[1], item[0]))
        self.requests += 1
        result = {'query': query, 'acquired_ids': acquired, 'ordered_item_ids': [item[0] for item in ordered], 'scores': dict(ordered), 'retrieval': 'BM25+BGE-M3 RRF(60)', 'reranker': 'BAAI/bge-reranker-v2-m3@953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e', 'max_length': 512, 'catalog_count': len(catalog)}
        result['worker_resources'] = {'document_cache': document_cache, 'device': self.device, 'dtype': 'float32', 'batch_size': 8, 'rank_ms': 1000 * (time.perf_counter() - started), 'initial_model_load_ms': self.load_ms, 'model_loads_total': self.model_loads, 'request_number': self.requests, 'peak_rss_bytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024)}
        return result


def main():
    ranker = PersistentHybridRanker()
    print(json.dumps({'type': 'ready', 'device': ranker.device, 'model_loads': ranker.model_loads, 'load_ms': ranker.load_ms}), flush=True)
    # One stdin loop is one global GPU lane; callers queue concurrent contexts on this process.
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get('request_id')
            if request.get('operation', 'fixed') != 'fixed':
                raise ValueError('worker accepts only fixed ranking')
            value = ranker.rank(request)
            print(json.dumps({'type': 'result', 'request_id': request_id, 'value': value}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({'type': 'error', 'request_id': request_id, 'error': f'{type(error).__name__}: {error}'}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
