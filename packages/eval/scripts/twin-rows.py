"""Twin-2K-500's wave_split as JSON Lines, paged from the Hugging Face datasets-server API (docs/CURVES.md §3).

The `datasets` library downloads parquet through Hugging Face's CDN, which some sandboxes can't reach; this needs only
datasets-server.huggingface.co. Usage: python3 packages/eval/scripts/twin-rows.py data/twin-full.jsonl
"""
import json
import os
import sys
import time
import urllib.request

OUT = sys.argv[1] if len(sys.argv) > 1 else 'twin-full.jsonl'

URL = ('https://datasets-server.huggingface.co/rows?dataset=LLM-Digital-Twin/Twin-2K-500'
       '&config=wave_split&split=data&offset={o}&length={n}')
KEEP = ['pid', 'wave1_3_persona_json', 'wave4_Q_wave4_A', 'wave4_Q_wave1_3_A']
total, step, seen = 2058, 20, set()
with open(OUT + '.part', 'w') as out:
    for o in range(0, total, step):
        for attempt in range(7):
            try:
                with urllib.request.urlopen(URL.format(o=o, n=step), timeout=180) as r:
                    d = json.load(r)
                break
            except Exception as e:  # noqa: BLE001
                print('retry', o, attempt, e, flush=True)
                time.sleep(2 ** attempt)
        else:
            sys.exit(f'failed at offset {o}')
        for row in d['rows']:
            if row.get('truncated_cells'):
                sys.exit(f"truncated at row {row['row_idx']}: {row['truncated_cells']}")
            r = row['row']
            if r['pid'] in seen:
                continue
            seen.add(r['pid'])
            out.write(json.dumps({k: r.get(k) for k in KEEP}) + '\n')
        print('offset', o, 'rows', len(seen), flush=True)
os.replace(OUT + '.part', OUT)
print('done', len(seen), '->', OUT)
