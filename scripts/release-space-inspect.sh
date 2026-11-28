#!/usr/bin/env bash
set -euo pipefail
cd /root/loong-jump-v17
python3 - <<'ARCHIVE'
import os,re,gzip,hashlib,shutil,json
from pathlib import Path
root=Path('/root/loong-jump-v17/backups')
files=sorted((p for p in root.iterdir() if re.fullmatch(r'pre-[0-9a-f]{40}-[0-9]+\.tar',p.name) and p.is_file() and not p.is_symlink()),key=lambda p:p.stat().st_mtime,reverse=True)
for source in files[3:]:
 original=source.stat();target=Path(str(source)+'.gz');temp=Path(str(target)+'.partial')
 if target.exists() or temp.exists():raise RuntimeError('Archive destination already exists')
 if shutil.disk_usage(root).free < original.st_size+64*1024*1024:raise RuntimeError('Insufficient compression headroom')
 digest=hashlib.sha256()
 try:
  with source.open('rb') as inp,os.fdopen(os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600),'wb') as raw:
   with gzip.GzipFile(filename='',mode='wb',fileobj=raw,compresslevel=1,mtime=0) as out:
    for block in iter(lambda:inp.read(1024*1024),b''):digest.update(block);out.write(block)
   raw.flush();os.fsync(raw.fileno())
  restored=hashlib.sha256();count=0
  with gzip.open(temp,'rb') as inp:
   for block in iter(lambda:inp.read(1024*1024),b''):restored.update(block);count+=len(block)
  current=source.stat()
  if digest.digest()!=restored.digest() or count!=original.st_size or (current.st_size,current.st_mtime_ns)!=(original.st_size,original.st_mtime_ns):raise RuntimeError('Archive verification failed')
  os.replace(temp,target)
  source.unlink()
  print(json.dumps({'archived':source.name,'originalBytes':count,'archiveBytes':target.stat().st_size,'restoredSha256':restored.hexdigest(),'freeBytes':shutil.disk_usage(root).free}))
 except BaseException:
  if temp.exists():temp.unlink()
  raise
print('All selected archives verified; latest three release backups and all daily backups unchanged')
ARCHIVE
df -h /
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}'
du -xhm --max-depth=1 /var/lib 2>/dev/null | sort -nr | head -12
