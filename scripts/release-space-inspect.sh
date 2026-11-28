#!/usr/bin/env bash
set -euo pipefail
df -h / /var/lib/docker
cd /root/loong-jump-v17
du -sh backups data release-images /var/lib/docker /var/log 2>/dev/null || true
docker system df
docker ps --format '{{.Names}} {{.Status}} {{.Image}}'
bash scripts/cleanup-images.sh
python3 - <<'INFO'
from pathlib import Path
p=Path('/root/loong-jump-v17/backups')
for f in sorted(p.glob('*')):
 if f.is_file():print(f.name, f.stat().st_size)
INFO
