#!/usr/bin/env bash
# 清理 loongjump-release / loongjump-rollback 旧版本镜像,保留最近 KEEP 个。
#
# 安全保证:
#   - 只删除 loongjump-release:* 和 loongjump-rollback:* 两个标签前缀,
#     绝不碰 loong-jump-v17-app、loongjump-website*、node/caddy 等其它镜像
#   - 运行中容器正在使用的镜像 ID 永远跳过
#   - 默认仅打印计划(--dry-run),加 --apply 才真正删除
#   - 删除失败(镜像仍被引用等)只记录不中断
#
# 用法: bash scripts/cleanup-images.sh [--apply] [--keep N]

set -euo pipefail

KEEP=3
APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --keep)  KEEP="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ "$KEEP" =~ ^[0-9]+$ ]] && [[ "$KEEP" -ge 1 ]] || { echo "KEEP 必须是 >=1 的整数" >&2; exit 2; }

docker info >/dev/null 2>&1 || { echo "docker 不可用" >&2; exit 1; }

# 运行中 app 容器的镜像 ID(永不删除)
RUNNING_IMG=$(docker inspect loong-jump-v17-app-1 --format '{{.Image}}' 2>/dev/null || true)

image_created() {
  docker image inspect --format '{{.Created}}' "$1" 2>/dev/null || echo ""
}

# 输出 "created<TAB>名称:标签" 列表,仅匹配指定前缀
list_versions() {
  local prefix="$1" img created
  docker images --format '{{.Repository}}:{{.Tag}}' \
    | grep -E "^${prefix}:[^[:space:]]+$" \
    | while read -r img; do
        created=$(image_created "$img")
        [[ -n "$created" ]] && printf '%s\t%s\n' "$created" "$img"
      done
}

# 按创建时间新→旧,保留前 KEEP 个(运行中的镜像不计入、也不删除)
clean_prefix() {
  local prefix="$1" sorted total kept img id
  sorted=$(list_versions "$prefix" | sort -r)
  [[ -z "$sorted" ]] && { echo "[无] $prefix:* 镜像不存在"; return 0; }
  total=$(printf '%s\n' "$sorted" | wc -l | tr -d ' ')
  kept=0
  echo "== $prefix:* 共 $total 个,保留最近 $KEEP 个 =="
  while IFS=$'\t' read -r _ img; do
    [[ -n "$img" ]] || continue
    id=$(docker image inspect --format '{{.Id}}' "$img" 2>/dev/null || echo "")
    if [[ -n "$RUNNING_IMG" && "$id" == "$RUNNING_IMG" ]]; then
      echo "[跳过] $img (运行中容器正在使用)"
      continue
    fi
    kept=$((kept + 1))
    if [[ "$kept" -le "$KEEP" ]]; then
      echo "[保留] $img"
    elif [[ "$APPLY" -eq 1 ]]; then
      if docker rmi "$img" 2>&1; then
        echo "[已删] $img"
      else
        echo "[失败] $img 删除失败(可能仍被引用,已跳过)" >&2
      fi
    else
      echo "[将删] $img"
    fi
  done <<< "$sorted"
}

echo "== 清理策略:各前缀保留最近 $KEEP 个版本(模式: $([[ $APPLY -eq 1 ]] && echo 执行 || echo 演练)) =="
clean_prefix 'loongjump-release'
clean_prefix 'loongjump-rollback'
echo "== 完成 =="
