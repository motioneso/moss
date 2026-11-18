#!/usr/bin/env python3
"""Freeze reviewed migration identities into this host release; never run on installation."""
from pathlib import Path
import re,json,hashlib
root=Path(__file__).resolve().parents[3]
rows=[]; ownership={}
for parent,ledger in [('packages','core-legacy'),('external-modules','module-legacy')]:
    for module in sorted((root/parent).iterdir()):
        if module.name in ('food','workshop') or not (module/'sql').is_dir(): continue
        sources=list(module.glob('src/manifest.ts'))+list(module.glob('*module.json'))
        tables=[]
        for source in sources:
            text=source.read_text()
            match=re.search(r'ownedTables["\s]*:\s*\[([^]]*)\]',text,re.S)
            if not match:
                # `ownedTables: name` refers to an array constant in the same file.
                ref=re.search(r'ownedTables\s*:\s*(\w+)\s*[,}\n]',text)
                if ref: match=re.search(r'const\s+'+ref[1]+r'\s*=\s*\[([^]]*)\]',text,re.S)
            if match: tables+=re.findall(r'["\'](app\.[a-z0-9_]+)["\']',match[1])
        # The original manifest predates the Calendar-owned day-plan aggregate.
        # Freeze these reviewed identities explicitly; do not infer arbitrary SQL ownership.
        # The Goals manifest predates the database field. Its two tables are frozen here.
        if module.name == 'goals':
            tables += ['app.moss_goals', 'app.moss_goal_evidence']
        if module.name == 'calendar':
            tables += ['app.day_plans', 'app.day_plan_blocks',
                       'app.day_plan_operations', 'app.day_plan_operation_items']
        ownership[module.name]=sorted(set(tables))
        for path in sorted((module/'sql').glob('*.sql')):
            data=path.read_bytes(); raw=hashlib.sha256(data).hexdigest()
            checksum=raw
            sidecar=re.search(rb'-- moss:backfill ([^\r\n]+)',data)
            if sidecar:
                extra=(path.parent/sidecar[1].decode()).read_bytes()
                checksum=hashlib.sha256(b'moss:sql-migration+backfill:v1\0'+str(len(data)).encode()+b':'+data+str(len(extra)).encode()+b':'+extra).hexdigest()
            elif ledger=='module-legacy':checksum=hashlib.sha256(data.decode('utf-8',errors='replace').encode()).hexdigest()
            rows.append(dict(module=module.name,path='sql/'+path.name,raw=raw,checksum=checksum,ledger=ledger))
output=root/'rust-spike/module-host/inventory/legacy.data'
output.write_text(json.dumps({'tables':ownership,'files':rows},sort_keys=True,separators=(',',':'))+'\n')
print(f'Frozen {len(rows)} migration files for {len(ownership)} modules')
