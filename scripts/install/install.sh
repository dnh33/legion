#!/bin/sh
# Legion installer for macOS and Linux.
#
#   curl -fsSL https://getlegion.xyz | sh
#
# With options: curl -fsSL https://getlegion.xyz | sh -s -- --version 0.2.5-g --no-launch
#   --version <v>   install this release instead of the latest
#   --dir <path>    install here instead of ~/.local/share/legion (a path starting with - needs: --dir -- <path>)
#   --no-launch     do not start Legion at the end
#
# What it does (no sudo, nothing outside your home folder):
#   1. Checks that git and Node.js 22.12 or newer are installed. It installs neither.
#   2. Finds the latest release from https://github.com/dnh33/legion/releases/latest (or uses --version).
#   3. Fetches the source at that release tag into ~/.local/share/legion. An existing folder is updated in place only if it is a
#      clean clone of dnh33/legion; any other folder is left alone and the script stops.
#   4. Runs npm ci (which downloads Electron) and npm run build in that folder, and checks that Electron is there.
#   5. Writes the launcher ~/.local/bin/legion.
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
  mkdir -p -- "$dir" || fail "Could not create $dir."
  dir=$(cd -- "$dir" && pwd -P) || fail "Could not enter $dir."

  say "Legion installer"

  # 1) tools
  git --version >/dev/null 2>&1 || fail "git is not installed. Get it from https://git-scm.com/downloads (macOS: run: xcode-select --install), then run this again."
  command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Get version 22.12 or newer from https://nodejs.org (or use nvm or your package manager), then run this again."
  command -v npm >/dev/null 2>&1 || fail "npm was not found. It comes with Node.js: reinstall Node.js from https://nodejs.org, then run this again."
  node_version_ok "$(node -p 'process.versions.node')" \
    || fail "Node.js $(node -v) is too old. Legion needs 22.12 or newer (Electron and the build tools need it): https://nodejs.org"

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
    [ -z "$(git -C "$dir" status --porcelain 2>/dev/null)" ] || fail "$dir has local changes. It was not touched. Commit or discard them, or pass --dir with another folder."
    say "Updating $dir to $tag ..."
    git -C "$dir" fetch --quiet --depth 1 origin tag "$tag" || fail "Could not fetch $tag. Does that release exist?"
    git -C "$dir" checkout --quiet --force "tags/$tag" || fail "Could not switch to $tag."
  else
    say "Fetching Legion $tag into $dir ..."
    git clone --quiet --depth 1 --branch "$tag" "$base$repo_path.git" "$dir" || fail "Could not fetch $tag. Does that release exist?"
  fi

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

# Electron 44 needs Node 22.12 or newer, and so do vite 7 and plugin-react 5 on the 22 line (they also allow 20.19+, but Electron does not).
node_version_ok() {
  node -e 'var v=process.argv[1].split(".").map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=12)?0:1)' "$1"
}

say() { printf '%s\n' "$*"; }
fail() { printf 'Legion was not installed: %s\n' "$*" >&2; exit 1; }

main "$@"
