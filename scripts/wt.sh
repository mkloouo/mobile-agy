#!/usr/bin/env bash
# Git-worktree helper for the parallel workflow.
# Worktrees live in <main checkout>/.worktrees/<ID> on branch <ID> (ID = MKL-<n>).
# Works from the main checkout or from inside any worktree.
set -euo pipefail

MAIN=""

usage() {
  cat >&2 <<'EOF'
Usage: scripts/wt.sh <command> [args]

  start <ID>        Claim <ID>: branch <ID> + worktree .worktrees/<ID> from main,
                    then bun install --frozen-lockfile (WT_SKIP_INSTALL=1 skips it).
                    Exit 2 if <ID> is already claimed.
  check             In your worktree: bun run check + bun run lint
                    (WT_SKIP_CHECK=1 skips it). Prints CHECK OK.
  finish <ID>       Run from inside .worktrees/<ID>: refuse if dirty, no commits, or no
                    CHANGELOG bullet ending with <ID> (exit 8). Then rebase on main, check,
                    ff-merge into main, remove worktree and branch.
  abort <ID> --yes  Remove worktree and branch <ID> without merging. Never touches main.
                    Without --yes it only prints what it would do.
  list              List worktrees.

  <ID> must match MKL-<number>, e.g. MKL-12.
EOF
}

die() {
  local code="$1"
  shift
  echo "$*" >&2
  exit "$code"
}

resolve_main() {
  local common
  common="$(git rev-parse --path-format=absolute --git-common-dir)"
  MAIN="$(cd "$(dirname "$common")" && pwd -P)"
  if [[ -d "$MAIN/main" && -e "$MAIN/main/.git" ]]; then
    MAIN="$MAIN/main"
  fi
}

current_branch() {
  git -C "$1" symbolic-ref --short -q HEAD || true
}

is_main_checkout() {
  [[ "$(git rev-parse --show-toplevel 2>/dev/null)" == "$MAIN" ]]
}

require_id() {
  if ! [[ "${1:-}" =~ ^MKL-[0-9]+$ ]]; then
    die 64 "BAD ID: '${1:-}' (expected MKL-<number>, e.g. MKL-12)"
  fi
}

run_check() {
  if [[ "${WT_SKIP_CHECK:-}" == 1 ]]; then
    echo "CHECK SKIPPED (WT_SKIP_CHECK=1)"
    return 0
  fi
  bun run check || return 1
  bun run lint || return 1
}

cmd_start() {
  local id="${1:-}"
  require_id "$id"
  resolve_main
  if [[ "$(current_branch "$MAIN")" != main ]]; then
    die 1 "MAIN CHECKOUT NOT ON main: $MAIN is on '$(current_branch "$MAIN")'. Switch it to main first."
  fi
  if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$id"; then
    echo "ALREADY CLAIMED: $id"
    exit 2
  fi
  local wt="$MAIN/.worktrees/$id"
  git -C "$MAIN" worktree add -b "$id" "$wt" main
  # ponytail: temporary until expo-release is published to npm. package.json has file:../release,
  # which from .worktrees/<ID> resolves to .worktrees/release, so link it to the sibling checkout.
  if [[ -d "$MAIN/../release" && ! -e "$MAIN/.worktrees/release" && ! -L "$MAIN/.worktrees/release" ]]; then
    ln -s ../../release "$MAIN/.worktrees/release"
  fi
  if [[ "${WT_SKIP_INSTALL:-}" != 1 ]]; then
    if ! (cd "$wt" && bun install --frozen-lockfile); then
      die 1 "INSTALL FAILED in $wt. Worktree kept. Fix the cause, then rerun: (cd $wt && bun install --frozen-lockfile)"
    fi
  fi
  echo "WORKTREE: $wt"
}

cmd_check() {
  resolve_main
  if is_main_checkout; then
    die 65 "RUN FROM A WORKTREE: 'check' runs inside .worktrees/<ID>, not the main checkout ($MAIN)."
  fi
  if ! run_check; then
    die 1 "CHECK FAILED: fix the errors above, commit, then run check again."
  fi
  echo "CHECK OK"
}

cmd_finish() {
  local id="${1:-}"
  require_id "$id"
  resolve_main
  local wt="$MAIN/.worktrees/$id"
  if [[ ! -d "$wt" && -d "$(dirname "$MAIN")/.worktrees/$id" ]]; then
    wt="$(dirname "$MAIN")/.worktrees/$id"
  fi
  local top
  top="$(git rev-parse --show-toplevel)"
  if [[ "$top" != "$wt" || "$(current_branch .)" != "$id" ]]; then
    die 65 "RUN FROM THE WORKTREE: cd $wt (branch $id). You are in '$top' on branch '$(current_branch .)'."
  fi

  local dirty
  dirty="$(git status --porcelain)"
  if [[ -n "$dirty" ]]; then
    printf '%s\n' "$dirty" >&2
    die 3 "UNCOMMITTED CHANGES in $id: commit or discard the files listed above, then rerun finish."
  fi

  if [[ "$(git rev-list --count main..HEAD)" == 0 ]]; then
    die 4 "NOTHING TO MERGE: $id has no commits ahead of main. Commit your work first."
  fi

  local changelog_diff
  changelog_diff="$(git diff main...HEAD -- CHANGELOG.md)"
  if ! grep -qE '^\+[^+].*\('"$id"'\)' <<<"$changelog_diff"; then
    die 8 "MISSING CHANGELOG: add a bullet ending with ($id) under ## [Unreleased]. Then commit and rerun finish."
  fi

  local merged=0
  local attempt
  for attempt in 1 2 3; do
    cd "$wt"
    if ! git rebase main; then
      local conflicts
      conflicts="$(git diff --name-only --diff-filter=U)"
      git rebase --abort || true
      if [[ -z "$conflicts" ]]; then
        die 1 "REBASE FAILED for $id (not a content conflict). See the git error above. Nothing merged."
      fi
      printf '%s\n' "$conflicts" | sed 's/^/  /' >&2
      die 5 "REBASE CONFLICT: $id conflicts with main in the files above. Nothing merged. Resolve with: git rebase main, fix files, git add, git rebase --continue, then rerun finish"
    fi

    if ! run_check; then
      die 1 "CHECK FAILED on $id: nothing merged. Fix, commit, then rerun finish."
    fi

    if [[ "$(current_branch "$MAIN")" != main || -n "$(git -C "$MAIN" status --porcelain)" ]]; then
      git -C "$MAIN" status --porcelain >&2 || true
      die 6 "MAIN CHECKOUT DIRTY: $MAIN must be on main with a clean git status (currently on '$(current_branch "$MAIN")'). Clean it up, then rerun finish."
    fi

    if git -C "$MAIN" merge --ff-only "$id"; then
      merged=1
      break
    fi
    if ! git -C "$MAIN" merge-base --is-ancestor main "$id"; then
      echo "main moved while finishing; rebasing again (attempt $attempt of 3)" >&2
      continue
    fi
    die 1 "MERGE FAILED for $id: fast-forward refused for another reason. See the git error above."
  done

  if [[ "$merged" != 1 ]]; then
    die 7 "MAIN KEPT MOVING: main changed on every attempt. Nothing merged. Rerun finish."
  fi

  cd "$MAIN"
  git -C "$MAIN" worktree remove "$wt"
  git -C "$MAIN" branch -d "$id"
  echo "MERGED: $id -> main ($(git -C "$MAIN" rev-parse --short HEAD))"
  echo "NOW RUN: cd $MAIN"
}

cmd_abort() {
  local id="${1:-}"
  require_id "$id"
  resolve_main
  local wt="$MAIN/.worktrees/$id"
  if [[ ! -d "$wt" && -d "$(dirname "$MAIN")/.worktrees/$id" ]]; then
    wt="$(dirname "$MAIN")/.worktrees/$id"
  fi
  if [[ "${2:-}" != --yes ]]; then
    echo "DRY RUN, nothing changed. Would run:"
    echo "  git -C $MAIN worktree remove --force $wt"
    echo "  git -C $MAIN branch -D $id"
    echo "Re-run with --yes to do it."
    exit 1
  fi
  cd "$MAIN"
  if [[ -d "$wt" ]]; then
    git -C "$MAIN" worktree remove --force "$wt"
  fi
  git -C "$MAIN" worktree prune
  if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$id"; then
    git -C "$MAIN" branch -D "$id"
  fi
  echo "ABORTED: $id (main untouched)"
}

cmd_list() {
  resolve_main
  git -C "$MAIN" worktree list
}

cmd="${1:-}"
if [[ $# -gt 0 ]]; then
  shift
fi
case "$cmd" in
  start) cmd_start "$@" ;;
  check) cmd_check ;;
  finish) cmd_finish "$@" ;;
  abort) cmd_abort "$@" ;;
  list) cmd_list ;;
  *)
    usage
    exit 64
    ;;
esac
