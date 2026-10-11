#!/usr/bin/env bash
# Run after the prebuilt image and a verified current-data backup are ready.
set -euo pipefail
release=${1:?Expected release SHA}
attempt=${2:?Expected run attempt}
[[ "$release" =~ ^[0-9a-f]{40}$ && "$attempt" =~ ^[0-9]+$ ]] || { echo 'Invalid release identity' >&2; exit 1; }
source_image="loongjump-release:$release"
docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$source_image" | grep -Fxq "LOONGJUMP_RELEASE=$release"
app_image=$(docker compose config --images app)
[[ -n "$app_image" && "$app_image" != *$'\n'* && "$app_image" != *' '* && "$app_image" != *@* ]] || { echo 'Expected one mutable application image tag' >&2; exit 1; }
container=$(docker compose ps -q app)
[[ -n "$container" && "$container" != *$'\n'* ]] || { echo 'Expected one running application container' >&2; exit 1; }
previous_image=$(docker inspect --format '{{.Image}}' "$container")
docker tag "$previous_image" "loongjump-rollback:$release-$attempt"
docker tag "$source_image" "$app_image"
docker compose up -d --no-build --pull never app
