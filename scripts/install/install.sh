#!/bin/sh
# Legion installer for macOS and Linux.
#
#   curl -fsSL https://getlegion.xyz | sh
#
# With options: curl -fsSL https://getlegion.xyz | sh -s -- --version <version> --no-launch
#   --version <v>   install this release instead of the latest
#   --dir <path>    install here instead of ~/.local/share/legion (a path starting with - needs: --dir -- <path>)
#   --no-launch     do not start Legion at the end
#
# What it does (no sudo, nothing outside your home folder):
#   1. Checks that git and Node.js 22.12 or newer are installed. It installs neither.
#   2. Finds the latest release from https://github.com/dnh33/legion/releases/latest (or uses --version).
#   3. Fetches the source at that release tag into ~/.local/share/legion. An existing folder is updated in place only if it is a
#      clean clone of dnh33/legion; any other folder is left alone and the script stops. "Clean" allows the changes Legion's own
#      updater makes (the program folders and files at the top of the folder, .update, build-info.json); an edit anywhere else,
#      for example in src/, stops the script. It also stops while Legion is running from that folder or is in the middle of an update.
#   4. Runs npm ci (which downloads Electron) and npm run build in that folder, and checks that Electron is there.
#   5. Writes .legion-install.json in that folder (it tells Legion's updater that this installer manages the folder, so Legion can
#      update itself; if that fails, Legion still works and shows a notice for updates) and the launcher ~/.local/bin/legion. A re-run also clears what an interrupted update left behind.
# There is no prebuilt app for macOS and Linux yet, so this builds from source. It sends nothing anywhere.
#
# The whole script is one function called on the last line, so a download that is cut off runs nothing.

set -eu

cr=$(printf '\r')

main() {
  base=${LEGION_INSTALL_BASE:-https://github.com}
  base=${base%/}
  repo_path=/dnh33/legion
  version=
  dir=
  launch=1

  if [ -n "${LEGION_INSTALL_BASE:-}" ]; then
    say "Note: LEGION_INSTALL_BASE is set. Downloads come from $base, not from github.com."
  fi

  while [ $# -gt 0 ]; do
    case $1 in
      --) shift; break ;;
      --no-launch) launch=0 ;;
      --version)
        [ $# -ge 2 ] || fail "--version needs a value."
        version=$2
        shift ;;
      --dir)
        [ $# -ge 2 ] || fail "--dir needs a value."
        if [ "$2" = -- ]; then
          [ $# -ge 3 ] || fail "--dir -- needs a path after it."
          dir=$3
          shift 2
        else
          case $2 in -*) fail "--dir value $2 starts with a dash. To use such a folder, write: --dir -- $2" ;; esac
          dir=$2
          shift
        fi ;;
      -h|--help) say "Usage: install.sh [--version <v>] [--dir <path>] [--no-launch]"; return 0 ;;
      *) fail "Unknown option: $1" ;;
    esac
    shift
  done

  [ -n "${HOME:-}" ] || fail "HOME is not set."
  [ $# -eq 0 ] || fail "Unexpected argument: $1"
  [ -n "$dir" ] || dir=$HOME/.local/share/legion
  bindir=$HOME/.local/bin
  case $dir in *"
"*) fail "The install folder name must not contain a line break." ;; esac
  # An absolute, symlink-free path from here on (the launcher needs it, and it can no longer be read as an option).
  case $dir in /*) ;; *) dir=$PWD/$dir ;; esac
  [ -d "$dir" ] || made_dir=$dir
  mkdir -p -- "$dir" || fail "Could not create $dir."
  dir=$(cd -- "$dir" && pwd -P) || fail "Could not enter $dir."
  [ -z "${made_dir:-}" ] || made_dir=$dir

  say "Legion installer"

  # 1) tools
  git --version >/dev/null 2>&1 || fail "git is not installed. Get it from https://git-scm.com/downloads (macOS: run: xcode-select --install), then run this again."
  command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Get version 22.12 or newer from https://nodejs.org (or use nvm or your package manager), then run this again."
  command -v npm >/dev/null 2>&1 || fail "npm was not found. It comes with Node.js: reinstall Node.js from https://nodejs.org, then run this again."
  node_version_ok "$(node -p 'process.versions.node')" \
    || fail "Node.js $(node -v) is too old. Legion needs 22.12 or newer (Electron and the build tools need it): https://nodejs.org"
  # A running update swaps files in this folder; npm ci would delete node_modules under it.
  if update_in_progress "$dir"; then
    fail "an update is in progress in $dir. Wait for it to finish (about a minute), or close Legion, then run this again."
  fi

  # The build below deletes node_modules (the Electron the open app runs from) and rewrites dist/ under it. Stop while Legion runs from here.
  if legion_running "$dir"; then
    fail "Legion is running from $dir. Close it (quit it from its window or tray), then run this again."
  fi

  # 2) which version
  if [ -z "$version" ]; then
    command -v curl >/dev/null 2>&1 || fail "curl is not installed. Install curl, then run this again."
    headers=$(curl -sSI --connect-timeout 15 --max-time 30 "$base$repo_path/releases/latest") || fail "Could not reach $base."
    location=$(printf '%s\n' "$headers" | tr -d '\r' | awk 'tolower($1)=="location:" {print $2}' | tail -n 1)
    case $location in
      */releases/tag/v*) version=${location##*/releases/tag/v} ;;
      *) fail "Could not find the latest release (no redirect from the releases page)." ;;
    esac
  fi
  version=${version#v}
  # Whole-string match: no line breaks allowed (grep works line by line), then the pattern on the single line.
  case $version in *"
"*|*"$cr"*) fail "That is not a version number." ;; esac
  printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || fail "That is not a version number: $version"
  say "Version: $version"
  tag=v$version

  # 3) the source at that tag
  if [ ! -d "$dir/.git" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    fail "$dir is not empty and is not a Legion install. Pass --dir with another folder."
  fi
  if [ -d "$dir/.git" ]; then
    # Only a clean clone of Legion itself is reused. Anything else (a dev clone with edits, another repository) is left alone.
    expected_origin=$base$repo_path.git
    origin=$(git -C "$dir" remote get-url origin 2>/dev/null) || origin=
    [ "$origin" = "$expected_origin" ] || fail "$dir is a git folder, but its origin is '${origin:-none}', not $expected_origin. It was not touched. Pass --dir with another folder."
    # A folder this installer set up earlier (it has the marker) may differ from the tag only where Legion's updater writes.
    # Any other change, and any change in a folder without the marker, stops the script.
    managed=0
    if [ -f "$dir/.legion-install.json" ] && grep -q '"manager":"install.sh"' "$dir/.legion-install.json" 2>/dev/null; then managed=1; fi
    git -C "$dir" status --porcelain >/dev/null 2>&1 || fail "Could not read the git status of $dir. It was not touched."
    [ -z "$(git -C "$dir" status --porcelain -z | outside_dirt "$managed")" ] || fail "$dir has local changes. It was not touched. Commit or discard them, or pass --dir with another folder."
    say "Updating $dir to $tag ..."
    git -C "$dir" fetch --quiet --depth 1 origin tag "$tag" || fail "Could not fetch $tag. Does that release exist?"
    git -C "$dir" checkout --quiet --force "tags/$tag" || fail "Could not switch to $tag."
  else
    say "Fetching Legion $tag into $dir ..."
    # GIT_DEFAULT_REF_FORMAT=files: with the reftable format (a git setting, and the default from Git 3.0) .git/HEAD is not the commit sha,
    # which Legion's updater reads to recognise this folder. Git versions that do not know the variable ignore it.
    GIT_DEFAULT_REF_FORMAT=files git clone --quiet --depth 1 --branch "$tag" "$base$repo_path.git" "$dir" || fail "Could not fetch $tag. Does that release exist?"
  fi
  # The updater's files must not show up as changes. This goes in .git/info/exclude because a .gitignore change would not reach clones that exist.
  add_excludes "$dir"

  # 4) build
  cd "$dir"
  say "Installing dependencies (npm ci) ..."
  npm ci --no-audit --no-fund || fail "npm ci failed. The messages above say why."
  # The Electron binary is downloaded by a postinstall step that is skipped when CI or ELECTRON_SKIP_BINARY_DOWNLOAD is set, and
  # that never fails the install. Without the binary the launcher below cannot start Legion, so check it here.
  electron=$(node -e 'process.stdout.write(require("electron"))' 2>/dev/null) || electron=
  if [ -z "$electron" ] || [ ! -x "$electron" ]; then
    fail "The Electron binary is missing after npm ci, so Legion could not start. If CI or ELECTRON_SKIP_BINARY_DOWNLOAD is set in your shell, unset it and run this again; otherwise run: cd \"$dir\" && npx install-electron --no"
  fi
  say "Building (npm run build) ..."
  npm run build || fail "The build failed. The messages above say why."
  [ -f dist/src/electron/main.js ] && [ -f dist-ui/index.html ] || fail "The build finished but its output is missing."

  # The build is good. Drop what an interrupted update left behind (it would roll this fresh build back to old files), then mark the
  # folder as managed by this installer.
  clear_stale_update "$dir"
  # A folder that cannot be marked still works; Legion then shows a notice for updates instead of applying them.
  write_marker "$dir" || :

  # 5) launcher (~/.local/bin does not exist by default on macOS)
  mkdir -p "$bindir"
  launcher=$bindir/legion
  write_launcher "$dir" "$launcher"
  chmod 755 "$launcher"
  say "Launcher: $launcher"
  case ":${PATH:-}:" in
    *":$bindir:"*) ;;
    *) say "Note: $bindir is not on your PATH. Add this line to your shell profile (~/.profile, ~/.zshrc or ~/.bashrc):"
       say "  export PATH=\"$bindir:\$PATH\"" ;;
  esac

  say "Legion $version is installed in $dir. Start it with: legion"
  if [ "$launch" = 1 ]; then
    say "Starting Legion ..."
    "$launcher" >/dev/null 2>&1 &
  fi
}

# The folder goes into the launcher inside single quotes, with each ' written as '\'' , so no character in a path can run code.
write_launcher() {
  _rest=$1
  _q=
  while :; do
    case $_rest in
      *\'*) _q=$_q${_rest%%\'*}"'\''"; _rest=${_rest#*\'} ;;
      *) _q=$_q$_rest; break ;;
    esac
  done
  {
    printf '#!/bin/sh\n'
    printf "dir='%s'\n" "$_q"
    printf 'exec "$dir/node_modules/.bin/electron" "$dir" "$@"\n'
  } > "$2"
}

# Reads `git status --porcelain -z` on stdin; $1 is 1 for a folder this installer manages. Prints the first path that is not allowed
# to differ (nothing if all are allowed). Allowed: the names Legion's updater replaces (apply.ts CODE_SET), .update and the marker,
# judged by the first path segment. A rename or copy lists two paths and both are judged. $1=0 allows nothing.
outside_dirt() {
  tr '\0' '\n' | awk -v managed="$1" '
    BEGIN {
      n = split(".update .legion-install.json dist dist-ui assets scripts licenses package.json package-lock.json build-info.json NOTICE LICENSE README.md SECURITY.md CHANGELOG.md setup.cmd setup-yes.cmd start-legion.cmd", names, " ")
      for (i = 1; i <= n; i++) ok[names[i]] = 1
      skip = 0
    }
    function check(p,   s) {
      s = p
      sub(/\/.*/, "", s)
      if (managed != 1 || !(s in ok)) { print p; exit }
    }
    {
      if (skip) { skip = 0; check($0); next }
      if ($0 == "") next
      x = substr($0, 1, 1); y = substr($0, 2, 1)
      if (x == "R" || x == "C" || y == "R" || y == "C") skip = 1
      check(substr($0, 4))
    }'
}

# Keeps the updater's own files out of `git status`, without touching the tracked .gitignore. Safe to run again.
add_excludes() {
  _ex=$1/.git/info/exclude
  mkdir -p -- "$1/.git/info" || fail "Could not write $_ex."
  if [ -s "$_ex" ] && [ -n "$(tail -c 1 "$_ex")" ]; then printf '\n' >> "$_ex" || fail "Could not write $_ex."; fi
  for _n in /.update/ /build-info.json /.legion-install.json; do
    grep -qxF -e "$_n" "$_ex" 2>/dev/null || printf '%s\n' "$_n" >> "$_ex" || fail "Could not write $_ex."
  done
}

# True while Legion's update helper holds its marker (a lease: fresh heartbeat, or an owner process that still lives, for at most 20 minutes).
# Same rule as markerLeaseState and fileMarker in src/core/updater/apply.ts. A file that cannot be read does not block.
update_in_progress() {
  [ -f "$1/.update/update-in-progress.json" ] || return 1
  node -e 'var fs=require("fs"),m;try{m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(e){process.exit(1)}
if(!m||!Number.isInteger(m.pid)||typeof m.startedAt!=="number"||typeof m.toVersion!=="string"||typeof m.fromVersion!=="string")process.exit(1)
var n=Date.now();if(n-m.startedAt>1200000)process.exit(1)
if(typeof m.heartbeat==="number"&&n-m.heartbeat<=120000)process.exit(0)
try{process.kill(m.pid,0);process.exit(0)}catch(e){process.exit(e.code==="EPERM"?0:1)}' "$1/.update/update-in-progress.json"
}

# After a good build: remove the files of an earlier update that never finished (journal, previous build, failed record) and a stale
# build-info.json. Only files the updater owns inside this folder; outcome.json and everything under ~/.legion stay.
clear_stale_update() {
  rm -f -- "$1/.update/journal.json" "$1/build-info.json"
  rm -rf -- "$1/.update/prev" "$1/.update/failed"
}

# Writes <dir>/.legion-install.json, the sign for Legion's updater that this installer manages the folder. HEAD must be the bare
# commit sha (a detached checkout in the files ref format); anything else would make the updater treat the folder as a plain
# checkout. Then the marker is removed and this returns 1 with a warning: Legion is installed and works, so the caller goes on.
write_marker() {
  _mf=$1/.legion-install.json
  _warn="Legion is installed, but it could not mark this folder for self-update; updates will show a notice instead."
  _head=$(git -C "$1" rev-parse HEAD 2>/dev/null) || _head=
  _file=$(cat "$1/.git/HEAD" 2>/dev/null) || _file=
  if ! printf '%s' "$_head" | grep -Eq '^[0-9a-f]{40}$' || [ "$_file" != "$_head" ]; then
    rm -f -- "$_mf"
    printf 'Warning: %s (.git/HEAD is not a commit sha: the folder is not a detached checkout in the files ref format. Run this installer again with a new --dir to fix it.)\n' "$_warn" >&2
    return 1
  fi
  _real=$(cd -- "$1" && pwd -P) || { printf 'Warning: %s (could not enter %s.)\n' "$_warn" "$1" >&2; return 1; }
  node -e 'var fs=require("fs"),a=process.argv,t=a[1]+".tmp";fs.writeFileSync(t,JSON.stringify({schema:1,manager:"install.sh",dir:a[2],head:a[3]})+"\n");fs.renameSync(t,a[1])' "$_mf" "$_real" "$_head" \
    || { rm -f -- "$_mf" "$_mf.tmp"; printf 'Warning: %s (could not write %s.)\n' "$_warn" "$_mf" >&2; return 1; }
}

# True while a process runs Electron from <dir>/node_modules/electron/dist (the app, its helpers). Looks at every process's command line
# with POSIX ps (macOS, Linux). The path counts only at the start of the line or after a space, so /a/b does not match /x/a/b. Where
# ps is missing or fails, nothing is detected and the install goes on.
legion_running() {
  ps -A -o args= 2>/dev/null | LEGION_RUN_PAT="$1/node_modules/electron/dist/" awk '
    BEGIN { p = ENVIRON["LEGION_RUN_PAT"] }
    { s = $0; while ((i = index(s, p)) > 0) { if (i == 1 || substr(s, i - 1, 1) == " ") { found = 1; exit } s = substr(s, i + 1) } }
    END { exit found ? 0 : 1 }'
}

# Electron 44 needs Node 22.12 or newer, and so do vite 7 and plugin-react 5 on the 22 line (they also allow 20.19+, but Electron does not).
node_version_ok() {
  node -e 'var v=process.argv[1].split(".").map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=12)?0:1)' "$1"
}

say() { printf '%s\n' "$*"; }
# A folder this run created and left empty is removed again, so a failed run leaves nothing behind.
fail() {
  printf 'Legion was not installed: %s\n' "$*" >&2
  if [ -n "${made_dir:-}" ]; then rmdir -- "$made_dir" 2>/dev/null || :; fi
  exit 1
}

main "$@"
