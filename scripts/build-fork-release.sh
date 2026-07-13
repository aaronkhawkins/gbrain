#!/usr/bin/env bash
# Build and select immutable, identifiable managed-fork releases.
# All tests and dry runs should point --prefix at an isolated directory.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/build-fork-release.sh build --prefix DIR --tag TAG [options]
  scripts/build-fork-release.sh rollback --prefix DIR [--smoke-command FILE]

Build options:
  --channel NAME         Managed build channel (default: private-research-fork)
  --upstream-ref REF     Upstream base ref to record (default: origin/master)
  --bun FILE             Bun executable (default: bun from PATH)
  --smoke-command FILE   Additional smoke program; receives BINARY MANIFEST

The build command requires a clean checkout whose HEAD is exactly TAG. It
builds below DIR/releases/TAG-SHA, verifies the embedded identity and checksums,
then atomically selects it through DIR/current while retaining DIR/previous.
Rollback verifies and smoke-tests DIR/previous before atomically selecting it.
EOF
}

die() {
  printf 'build-fork-release: %s\n' "$*" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

atomic_link() {
  local target="$1" link="$2" temporary
  temporary="${link}.tmp.$$"
  rm -f "$temporary"
  ln -s "$target" "$temporary"
  # GNU mv needs -T and BSD/macOS mv needs -h to replace a symlink-to-directory
  # instead of following it. In both cases rename(2) makes current atomic.
  if mv -f -T "$temporary" "$link" 2>/dev/null; then
    return
  fi
  mv -f -h "$temporary" "$link"
}

verify_release() {
  local release_dir="$1" smoke_command="${2:-}"
  local binary="$release_dir/gbrain" manifest="$release_dir/release-manifest.json"
  local checksum_file="$release_dir/release-manifest.sha256" expected actual identity

  [ -x "$binary" ] && [ ! -L "$binary" ] || die "release binary is missing, linked, or not executable"
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || die "release manifest is missing or linked"
  [ -f "$checksum_file" ] && [ ! -L "$checksum_file" ] || die "release manifest checksum is missing or linked"

  expected=$(awk 'NR == 1 {print $1}' "$checksum_file")
  actual=$(sha256_file "$manifest")
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || die "release manifest checksum mismatch"

  identity=$("$binary" version --json) || die "compiled identity smoke failed"
  RELEASE_MANIFEST="$manifest" RELEASE_IDENTITY="$identity" "$bun_bin" -e '
    import { readFileSync } from "fs";
    const manifest = JSON.parse(readFileSync(process.env.RELEASE_MANIFEST, "utf8"));
    const identity = JSON.parse(process.env.RELEASE_IDENTITY);
    const build = identity.build;
    const mismatch =
      build.channel !== manifest.channel ||
      build.tag !== manifest.tag ||
      build.sha !== manifest.sha ||
      build.upstream_base !== manifest.upstream_base ||
      build.clean !== true || build.managed_fork !== true ||
      build.upgrade_posture !== "fork-managed" || build.artifact !== "compiled";
    if (mismatch) process.exit(1);
  ' || die "compiled identity does not match release manifest"

  actual=$(sha256_file "$binary")
  expected=$(RELEASE_MANIFEST="$manifest" "$bun_bin" -e '
    import { readFileSync } from "fs";
    console.log(JSON.parse(readFileSync(process.env.RELEASE_MANIFEST, "utf8")).binary_sha256);
  ')
  [ "$expected" = "$actual" ] || die "release binary checksum mismatch"

  if [ -n "$smoke_command" ]; then
    [ -x "$smoke_command" ] || die "smoke command is not executable: $smoke_command"
    "$smoke_command" "$binary" "$manifest" || die "release smoke command failed"
  fi
}

select_release() {
  local prefix="$1" release_id="$2" old_target=""
  local new_target="releases/$release_id"
  if [ -L "$prefix/current" ]; then
    old_target=$(readlink "$prefix/current")
  fi
  if [ -n "$old_target" ] && [ "$old_target" != "$new_target" ]; then
    atomic_link "$old_target" "$prefix/previous"
  fi
  atomic_link "$new_target" "$prefix/current"
}

command_name="${1:-}"
[ -n "$command_name" ] || { usage >&2; exit 2; }
shift

prefix=""
tag=""
channel="private-research-fork"
upstream_ref="origin/master"
bun_bin="bun"
smoke_command=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] || die "--prefix requires a value"; prefix="$2"; shift 2 ;;
    --tag) [ "$#" -ge 2 ] || die "--tag requires a value"; tag="$2"; shift 2 ;;
    --channel) [ "$#" -ge 2 ] || die "--channel requires a value"; channel="$2"; shift 2 ;;
    --upstream-ref) [ "$#" -ge 2 ] || die "--upstream-ref requires a value"; upstream_ref="$2"; shift 2 ;;
    --bun) [ "$#" -ge 2 ] || die "--bun requires a value"; bun_bin="$2"; shift 2 ;;
    --smoke-command) [ "$#" -ge 2 ] || die "--smoke-command requires a value"; smoke_command="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$prefix" ] || die "--prefix is required"
prefix_parent=$(dirname "$prefix")
mkdir -p "$prefix_parent"
prefix_parent=$(cd "$prefix_parent" && pwd -P)
prefix="$prefix_parent/$(basename "$prefix")"
[ ! -L "$prefix" ] || die "release prefix must not be a symlink"

case "$command_name" in
  build)
    [ -n "$tag" ] || die "--tag is required"
    [[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] || die "tag contains unsafe characters"
    [[ "$channel" =~ ^[A-Za-z0-9._/-]+$ ]] || die "channel contains unsafe characters"
    [[ "$upstream_ref" =~ ^[A-Za-z0-9._/-]+$ ]] || die "upstream ref contains unsafe characters"

    repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git checkout"
    repo_root=$(cd "$repo_root" && pwd -P)
    case "$prefix/" in "$repo_root/"*) die "release prefix must be outside the source checkout" ;; esac
    [ -z "$(git -C "$repo_root" status --porcelain --untracked-files=all)" ] || die "source checkout is dirty"
    mkdir -p "$prefix/releases"
    [ ! -L "$prefix/releases" ] || die "release directory must not be a symlink"

    sha=$(git -C "$repo_root" rev-parse HEAD)
    tag_sha=$(git -C "$repo_root" rev-list -n 1 "refs/tags/$tag" 2>/dev/null) || die "tag does not exist: $tag"
    [ "$tag_sha" = "$sha" ] || die "tag/SHA mismatch: $tag does not identify HEAD"
    upstream_sha=$(git -C "$repo_root" rev-parse "$upstream_ref^{commit}" 2>/dev/null) || die "cannot resolve upstream ref: $upstream_ref"
    upstream_base="${upstream_ref}@${upstream_sha}"
    short_sha=${sha:0:12}
    release_id="${tag}-${short_sha}"
    final_dir="$prefix/releases/$release_id"
    [ ! -e "$final_dir" ] || die "immutable release already exists: $release_id"

    staging="$prefix/releases/.staging-${release_id}-$$"
    cleanup() { rm -rf "$staging"; }
    trap cleanup EXIT INT TERM
    mkdir -m 0755 "$staging"

    "$bun_bin" build --compile --outfile "$staging/gbrain" \
      --define "__GBRAIN_BUILD_CHANNEL__=\"$channel\"" \
      --define "__GBRAIN_BUILD_TAG__=\"$tag\"" \
      --define "__GBRAIN_BUILD_SHA__=\"$sha\"" \
      --define "__GBRAIN_UPSTREAM_BASE__=\"$upstream_base\"" \
      --define '__GBRAIN_BUILD_CLEAN__=true' \
      "$repo_root/src/cli.ts"
    chmod 0755 "$staging/gbrain"
    binary_sha=$(sha256_file "$staging/gbrain")
    source_epoch=$(git -C "$repo_root" show -s --format=%ct HEAD)
    built_at=$(TZ=UTC date -r "$source_epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d "@$source_epoch" '+%Y-%m-%dT%H:%M:%SZ')

    cat > "$staging/release-manifest.json" <<EOF
{
  "schema_version": 1,
  "release_id": "$release_id",
  "channel": "$channel",
  "tag": "$tag",
  "sha": "$sha",
  "upstream_ref": "$upstream_ref",
  "upstream_base": "$upstream_base",
  "clean": true,
  "built_at": "$built_at",
  "binary_sha256": "$binary_sha"
}
EOF
    manifest_sha=$(sha256_file "$staging/release-manifest.json")
    printf '%s  release-manifest.json\n' "$manifest_sha" > "$staging/release-manifest.sha256"

    verify_release "$staging" "$smoke_command"
    [ "$(git -C "$repo_root" rev-parse HEAD)" = "$sha" ] || die "source HEAD changed during build"
    [ -z "$(git -C "$repo_root" status --porcelain --untracked-files=all)" ] || die "source checkout changed during build"
    mv "$staging" "$final_dir"
    trap - EXIT INT TERM
    select_release "$prefix" "$release_id"
    printf 'selected %s\n' "$release_id"
    ;;

  rollback)
    [ -d "$prefix/releases" ] || die "release prefix does not exist"
    [ ! -L "$prefix/releases" ] || die "release directory must not be a symlink"
    [ -L "$prefix/previous" ] || die "no previous release is available"
    previous_target=$(readlink "$prefix/previous")
    case "$previous_target" in releases/*) ;; *) die "previous release target is invalid" ;; esac
    previous_id=${previous_target#releases/}
    [[ "$previous_id" =~ ^[A-Za-z0-9._-]+$ ]] || die "previous release target is unsafe"
    [ -d "$prefix/$previous_target" ] || die "previous release directory is missing"
    verify_release "$prefix/$previous_target" "$smoke_command"

    current_target=""
    if [ -L "$prefix/current" ]; then current_target=$(readlink "$prefix/current"); fi
    [ -n "$current_target" ] || die "current release is missing"
    case "$current_target" in releases/*) ;; *) die "current release target is invalid" ;; esac
    current_id=${current_target#releases/}
    [[ "$current_id" =~ ^[A-Za-z0-9._-]+$ ]] || die "current release target is unsafe"
    atomic_link "$current_target" "$prefix/previous"
    atomic_link "$previous_target" "$prefix/current"
    printf 'selected %s\n' "$previous_id"
    ;;

  *) usage >&2; exit 2 ;;
esac
