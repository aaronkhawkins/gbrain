#!/usr/bin/env bash
set -euo pipefail

umask 077

usage() {
  cat <<'EOF'
Usage: scripts/run-isolated-research-pilot.sh \
  --cohort synthetic-bookmarks.jsonl \
  --work-root /private/owner-only/pilot \
  --scorecard-input scorecard.json \
  --evaluation-input evaluation.json \
  [--gbrain-bin /path/to/gbrain] [--chat-model opencode-server:gpt-5.5] [--synthetic]

Replays an already-collected immutable cohort into a dedicated PGLite brain.
It never contacts X and never reads the default GBrain home or DATABASE_URL.
EOF
}

cohort=
work_root=
scorecard_input=
evaluation_input=
gbrain_bin="${GBRAIN_PILOT_BIN:-gbrain}"
chat_model="${GBRAIN_PILOT_CHAT_MODEL:-opencode-server:gpt-5.5}"
synthetic=false

while (($#)); do
  case "$1" in
    --cohort) cohort=${2:?}; shift 2 ;;
    --work-root) work_root=${2:?}; shift 2 ;;
    --scorecard-input) scorecard_input=${2:?}; shift 2 ;;
    --evaluation-input) evaluation_input=${2:?}; shift 2 ;;
    --gbrain-bin) gbrain_bin=${2:?}; shift 2 ;;
    --chat-model) chat_model=${2:?}; shift 2 ;;
    --synthetic) synthetic=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "[pilot] unknown argument" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$cohort" && -n "$work_root" && -n "$scorecard_input" && -n "$evaluation_input" ]] || { usage >&2; exit 2; }
[[ ! -L "$work_root" ]] || { echo "[pilot] refusing symlink work root" >&2; exit 2; }
mkdir -p -m 700 "$work_root"
chmod 700 "$work_root"
work_root=$(cd "$work_root" && pwd -P)

ensure_private_dir() {
  local path=$1
  [[ ! -L "$path" ]] || { echo "[pilot] refusing symlink private directory" >&2; exit 2; }
  mkdir -p -m 700 "$path"
  [[ -d "$path" && ! -L "$path" ]] || { echo "[pilot] private directory is unsafe" >&2; exit 2; }
  chmod 700 "$path"
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
helper="$script_dir/lib/isolated-research-pilot.ts"
source_dir="$work_root/collector-replay"
gbrain_home="$work_root/gbrain-home"
private_dir="$work_root/private"
ensure_private_dir "$source_dir"
ensure_private_dir "$gbrain_home"
ensure_private_dir "$private_dir"

prepare_args=(prepare "$cohort" "$source_dir" "$private_dir/cohort-manifest.json")
if [[ "$synthetic" != true ]]; then prepare_args+=(private); fi
bun "$helper" "${prepare_args[@]}"

# GBrain sync requires every source checkout to be a Git repository. The
# replay is committed locally with a synthetic identity and never receives a
# remote, so sync exercises its normal commit-watermark path without egress.
if [[ ! -d "$source_dir/.git" ]]; then
  git -C "$source_dir" init -q -b main
  git -C "$source_dir" -c user.name='GBrain Pilot' -c user.email='pilot@invalid' add bookmarks
  git -C "$source_dir" -c user.name='GBrain Pilot' -c user.email='pilot@invalid' commit -q -m 'seed immutable collector replay'
elif ! git -C "$source_dir" rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "[pilot] refusing source checkout without a valid commit" >&2
  exit 2
fi

state="$private_dir/initialized"
run_gbrain() {
  env \
    -u DATABASE_URL -u GBRAIN_DATABASE_URL \
    -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u ZEROENTROPY_API_KEY \
    GBRAIN_HOME="$gbrain_home" \
    GBRAIN_CHAT_MODEL="$chat_model" \
    PILOT_SOURCE_DIR="$source_dir" \
    PILOT_PRIVATE_DIR="$private_dir" \
    "$gbrain_bin" "$@"
}

if [[ ! -e "$state" ]]; then
  run_gbrain init --pglite --no-embedding
  run_gbrain sources add research-pilot --path "$source_dir" --name "Isolated research pilot" --no-federated
  run_gbrain schema use gbrain-creator
  (umask 077; : > "$state")
  chmod 600 "$state"
elif [[ -L "$state" || ! -f "$state" ]]; then
  echo "[pilot] refusing invalid initialization marker" >&2
  exit 2
fi

run_pass() {
  local pass=$1
  local export_dir="$private_dir/export-pass-$pass"
  rm -rf "$export_dir"
  mkdir -m 700 "$export_dir"
  # This is the scheduled production command shape: collector replay, source
  # sync, bounded atom drain, concept synthesis, then the ordinary dream pass.
  run_gbrain sync --source research-pilot
  run_gbrain dream --source research-pilot --phase extract_atoms --drain --window 300
  run_gbrain dream --source research-pilot --phase synthesize_concepts
  run_gbrain dream --source research-pilot
  run_gbrain export --dir "$export_dir"
  bun "$helper" tree-digest "$export_dir" "$private_dir/export-pass-$pass-manifest.json"
}

run_pass 1
run_pass 2

digest1=$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).digest)' "$private_dir/export-pass-1-manifest.json")
digest2=$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).digest)' "$private_dir/export-pass-2-manifest.json")
if [[ "$digest1" != "$digest2" ]]; then
  echo "[pilot] idempotency failed; cleanup and backlog release remain blocked" >&2
  exit 3
fi

bun "$helper" "${prepare_args[@]}" >/dev/null
bun "$helper" score "$scorecard_input" "$evaluation_input" "$private_dir/decision.json"
echo "[pilot] isolated passes=2 idempotent=true export_hash_prefix=${digest1:0:12}"
echo "[pilot] private artifacts retained under the owner-only work root"
