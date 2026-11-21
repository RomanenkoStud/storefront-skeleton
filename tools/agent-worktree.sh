#!/usr/bin/env bash
# Create isolated agent checkouts; never fetch, copy secrets, install, push or delete.
set -euo pipefail

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: tools/agent-worktree.sh list
       tools/agent-worktree.sh create <role> <ticket> [worker-port]

Creates task/<role>-<ticket> from origin/main when available, otherwise main.
Both the calling checkout and the main checkout must be clean. Run an authorized
fetch first to refresh origin/main. Task checkouts live in sibling <repository>-worktrees/.
No secrets, node_modules, databases, installs, commits or network calls are copied/run.
HELP
}
command -v git >/dev/null || fail 'git is required'
current_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'run inside the catalog repository'
main_root=''
record_path=''
while IFS= read -r -d '' field; do
  case "$field" in
    'worktree '*) record_path=${field#worktree } ;;
    'branch refs/heads/main') main_root=$record_path ;;
  esac
done < <(git worktree list --porcelain -z)
[[ -n "$main_root" && -d "$main_root" ]] || fail 'a checkout of the main branch is required; do not switch another agent checkout'
worktrees_root="$(dirname "$main_root")/$(basename "$main_root")-worktrees"

case ${1:-} in
  list)
    [[ $# == 1 ]] || { usage; exit 1; }
    git worktree list
    if [[ -d "$worktrees_root" ]]; then
      while IFS= read -r -d '' manifest; do
        printf '\n%s\n' "${manifest%/.claude/tmp/worktree.env}"
        awk '/^export (WORKER_PORT|VITE_PORT|INSPECTOR_PORT)=/ {print "  " $0}' "$manifest"
      done < <(find "$worktrees_root" -mindepth 4 -maxdepth 4 -type f -path '*/.claude/tmp/worktree.env' -print0)
    fi
    exit 0 ;;
  create) [[ $# -ge 3 && $# -le 4 ]] || { usage; exit 1; } ;;
  -h|--help|'') usage; exit 0 ;;
  *) usage; exit 1 ;;
esac
role=$2 ticket=$3
[[ "$role" =~ ^[a-z][a-z0-9-]*$ ]] || fail 'role must contain lowercase letters, digits or hyphens'
[[ "$ticket" =~ ^[a-z0-9][a-z0-9.-]*$ && "$ticket" != *..* && "$ticket" != *. ]] || fail 'ticket must be a lowercase safe identifier, such as demo-a1b.2'
current_status=$(git -C "$current_root" status --porcelain --untracked-files=normal) || fail 'cannot inspect calling checkout'
[[ -z "$current_status" ]] || fail 'calling checkout is dirty; commit or hand off its owned changes first'
main_status=$(git -C "$main_root" status --porcelain --untracked-files=normal) || fail 'cannot inspect main checkout'
[[ -z "$main_status" ]] || fail 'main checkout is dirty; the orchestrator must resolve it before dispatch'
slug="$role-$ticket"
branch="task/$slug"
destination="$worktrees_root/$slug"
git check-ref-format --branch "$branch" >/dev/null || fail 'invalid task branch name'
[[ ! -e "$destination" ]] || fail "destination already exists: $destination"
if git show-ref --verify --quiet "refs/heads/$branch"; then fail "branch already exists: $branch"; fi
if git show-ref --verify --quiet refs/remotes/origin/main; then base=origin/main; else base=main; fi
git rev-parse --verify "$base^{commit}" >/dev/null || fail 'main has no commit to branch from'
mkdir -p "$worktrees_root"
lock="$worktrees_root/.agent-worktree-create.lock"
mkdir "$lock" 2>/dev/null || fail 'another creation is running; inspect the lock before retrying'
trap 'rmdir "$lock"' EXIT

port_block_free() {
  local wanted=$1 manifest port
  while IFS= read -r -d '' manifest; do
    port=$(awk -F= '/^export WORKER_PORT=[0-9]+$/ {print $2}' "$manifest")
    if [[ -n "$port" ]] && (( wanted <= port + 2 && wanted + 2 >= port )); then return 1; fi
  done < <(find "$worktrees_root" -mindepth 4 -maxdepth 4 -type f -path '*/.claude/tmp/worktree.env' -print0)
  if command -v ss >/dev/null; then
    for port in "$wanted" "$((wanted+1))" "$((wanted+2))"; do
      if ss -H -ltn | awk -v port="$port" '$4 ~ (":" port "$") {found=1} END {exit !found}'; then return 1; fi
    done
  fi
  return 0
}
if [[ $# == 4 ]]; then
  [[ $4 =~ ^[1-9][0-9]{3,4}$ ]] || fail 'worker port must be an integer between 1024 and 65532'
  worker_port=$((10#$4))
  (( worker_port >= 1024 && worker_port <= 65532 )) || fail 'worker port must leave room for Vite and inspector ports'
  port_block_free "$worker_port" || fail 'requested three-port block is already reserved or listening'
else
  checksum=$(printf '%s' "$slug" | cksum | awk '{print $1}')
  worker_port=$((12000 + (checksum % 3500) * 10))
  attempts=0
  until port_block_free "$worker_port"; do
    worker_port=$((12000 + ((worker_port - 12000 + 10) % 35000)))
    attempts=$((attempts+1))
    (( attempts < 3500 )) || fail 'no available task port block'
  done
fi
git worktree add -b "$branch" "$destination" "$base"
mkdir -p "$destination/.claude/tmp/runtime"
manifest="$destination/.claude/tmp/worktree.env"
{
  printf '# Local task runtime only. No credentials. Source this from its own worktree.\n'
  printf 'export WORKER_PORT=%s\nexport VITE_PORT=%s\nexport INSPECTOR_PORT=%s\n' "$worker_port" "$((worker_port+1))" "$((worker_port+2))"
  printf 'export WRANGLER_PERSIST_TO=%q\n' "$destination/.wrangler/task-state"
  printf 'export TMPDIR=%q\n' "$destination/.claude/tmp/runtime"
  printf 'export NODE_COMPILE_CACHE=%q\n' "$destination/.claude/tmp/node-cache"
} > "$manifest"
printf '\nCreated %s\nCheckout: %s\nBase: %s (%s)\nPorts: Worker=%s Vite=%s inspector=%s\nRuntime: %s\n' "$branch" "$destination" "$base" "$(git rev-parse --short "$base")" "$worker_port" "$((worker_port+1))" "$((worker_port+2))" "$manifest"
printf 'Next: cd %q; source .claude/tmp/worktree.env; npm ci\n' "$destination"
