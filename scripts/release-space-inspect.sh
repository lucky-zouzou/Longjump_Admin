#!/usr/bin/env bash
set -euo pipefail
df -h / /var/lib/docker
cd /root/loong-jump-v17
du -sh backups data release-images /var/lib/docker /var/log 2>/dev/null || true
docker system df
docker ps --format '{{.Names}} {{.Status}} {{.Image}}'
bash scripts/cleanup-images.sh --apply --keep 1
df -h /
du -xhm --max-depth=1 /root /var /opt 2>/dev/null | sort -nr | head -22
python3 - <<'SIZE'
from pathlib import Path
import subprocess
p=Path('/root/loong-jump-v17/backups/LOONGJUMP-2026-11-01.tar')
g=subprocess.Popen(['gzip','-1','-c',str(p)],stdout=subprocess.PIPE)
n=0
while True:
 b=g.stdout.read(1024*1024)
 if not b:break
 n+=len(b)
if g.wait()!=0:raise SystemExit('compression probe failed')
print('archive_probe_bytes',p.stat().st_size,n)
SIZE
python3 - <<'INFO'
from pathlib import Path
p=Path('/root/loong-jump-v17/backups')
for f in sorted(p.glob('*')):
 if f.is_file():print(f.name, f.stat().st_size)
INFO
