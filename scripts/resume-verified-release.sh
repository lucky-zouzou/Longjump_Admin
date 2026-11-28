#!/usr/bin/env bash
set -euo pipefail
cd /root/loong-jump-v17
release=5b599ac251f3fa4083ddb858ddc01f89897b0173
previous=743e75a7a6accf3ffa60f8b5d5180b31b02c8912
current=$(curl -fsS --max-time 20 https://admin.loongjump.com/healthz | python3 -c 'import json,sys;print(json.load(sys.stdin)["release"])')
[[ "$current" == "$previous" ]] || { echo 'Production changed; refusing activation'; exit 1; }
printf '%s\n' '79f3a088100c1281473acec520edbd2787489e326e507793345ed2dfa709b79f  scripts/activate-release.sh' 'cc36069789f68ffd38b13e2fe563164818325da4a7a404f7f12e997feb52d59e  scripts/configure-inquiry-sync.py' | sha256sum -c -
docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "loongjump-release:$release" | grep -Fxq "LOONGJUMP_RELEASE=$release"
backup="/root/loong-jump-v17/backups/pre-$release-2.tar"
if [[ -f "$backup" ]]; then
  python3 -c 'import os,time,sys; assert time.time()-os.stat(sys.argv[1]).st_mtime < 900, "Backup too old to reuse"' "$backup"
  docker compose exec -T app node server/cli.mjs verify --input "/backups/pre-$release-2.tar" </dev/null
else
  python3 -c 'import shutil; assert shutil.disk_usage("/root/loong-jump-v17/backups").free > 2*1024**3, "Need 2 GiB free before backup"'
  docker compose exec -T app node server/cli.mjs backup --output "/backups/pre-$release-2.tar" </dev/null
fi
echo 'Pre-migration backup created and integrity verified'
python3 scripts/configure-inquiry-sync.py </dev/null
bash scripts/activate-release.sh "$release" 2 </dev/null
for i in $(seq 1 30); do
  status=$(docker inspect loong-jump-v17-app-1 --format '{{.State.Health.Status}}')
  if [[ "$status" == healthy ]]; then
    actual=$(curl -fsS --max-time 20 https://admin.loongjump.com/healthz | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["ok"];print(d["release"])')
    if [[ "$actual" == "$release" ]]; then
      printf 'Healthy production release: %s\n' "$actual"
      df -h /
      exit 0
    fi
  fi
  sleep 5
done
echo 'Health verification failed' >&2
exit 1
