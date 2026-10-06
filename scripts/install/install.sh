#!/bin/sh
# Legion installer for macOS and Linux.
#
#   curl -fsSL https://getlegion.xyz | sh
#
# With options: curl -fsSL https://getlegion.xyz | sh -s -- --version 0.2.5-g --no-launch
#   --version <v>   install this release instead of the latest
#   --dir <path>    install here instead of ~/.local/share/legion
#   --no-launch     do not start Legion at the end
#
# What it does (no sudo, nothing outside your home folder):
#   1. Checks that git and Node.js 20.10 or newer are installed. It installs neither.
#   2. Finds the latest release from https://github.com/dnh33/legion/releases/latest (or uses --version).
#   3. Fetches the source at that release tag into ~/.local/share/legion (updates it in place if it is there).
#   4. Runs npm ci and npm run build in that folder.
#   5. Writes the launcher ~/.local/bin/legion.
# There is no prebuilt app for macOS and Linux yet, so this builds from source. It sends nothing anywhere.
#
# The whole script is one function called on the last line, so a download that is cut off runs nothing.

set -eu

main() {
  base=${LEGION_INSTALL_BASE:-https://github.com}
  base=${base%/}
  repo_path=/dnh33/legion
  version=
  dir=
  launch=1

  while [ $# -gt 0 ]; do
    case $1 in
      --no-launch) launch=0 ;;
      --version)
        [ $# -ge 2 ] || fail "--version needs a value."
        version=$2
        shift ;;
      --dir)
        [ $# -ge 2 ] || fail "--dir needs a value."
        dir=$2
        shift ;;
      -h|--help) say "Usage: install.sh [--version <v>] [--dir <path>] [--no-launch]"; return 0 ;;
      *) fail "Unknown option: $1" ;;
    esac
    shift
  done

  [ -n "${HOME:-}" ] || fail "HOME is not set."
  [ -n "$dir" ] || dir=$HOME/.local/share/legion
  bindir=$HOME/.local/bin

  say "Legion installer"

  # 1) tools
  command -v git >/dev/null 2>&1 || fail "git is not installed. Get it from https://git-scm.com/downloads (macOS: run: xcode-select --install), then run this again."
  command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Get version 20.10 or newer from https://nodejs.org (or use nvm or your package manager), then run this again."
  command -v npm >/dev/null 2>&1 || fail "npm was not found. It comes with Node.js: reinstall Node.js from https://nodejs.org, then run this again."
  node -e 'var v=process.versions.node.split(".").map(Number);process.exit(v[0]>20||(v[0]===20&&v[1]>=10)?0:1)' \
    || fail "Node.js $(node -v) is too old. Legion needs 20.10 or newer: https://nodejs.org"

  # 2) which version
  if [ -z "$version" ]; then
    command -v curl >/dev/null 2>&1 || fail "curl is not installed. Install curl, then run this again."
    headers=$(curl -sSI "$base$repo_path/releases/latest") || fail "Could not reach $base."
    location=$(printf '%s\n' "$headers" | tr -d '\r' | awk 'tolower($1)=="location:" {print $2}' | tail -n 1)
    case $location in
      */releases/tag/v*) version=${location##*/releases/tag/v} ;;
      *) fail "Could not find the latest release (no redirect from the releases page)." ;;
    esac
  fi
  version=${version#v}
  printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || fail "That is not a version number: $version"
  say "Version: $version"
  tag=v$version

  # 3) the source at that tag
  if [ -e "$dir" ] && [ ! -d "$dir/.git" ]; then
    if [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
      fail "$dir exists and is not a Legion install. Pass --dir with another folder."
    fi
  fi
  if [ -d "$dir/.git" ]; then
    say "Updating $dir to $tag ..."
    git -C "$dir" fetch --quiet --depth 1 origin tag "$tag" || fail "Could not fetch $tag. Does that release exist?"
    git -C "$dir" checkout --quiet --force "tags/$tag" || fail "Could not switch to $tag."
  else
    say "Fetching Legion $tag into $dir ..."
    mkdir -p "$(dirname "$dir")"
    git clone --quiet --depth 1 --branch "$tag" "$base$repo_path.git" "$dir" || fail "Could not fetch $tag. Does that release exist?"
  fi

  # 4) build
  cd "$dir"
  say "Installing dependencies (npm ci) ..."
  npm ci --no-audit --no-fund || fail "npm ci failed. The messages above say why."
  say "Building (npm run build) ..."
  npm run build || fail "The build failed. The messages above say why."
  [ -f dist/src/electron/main.js ] && [ -f dist-ui/index.html ] || fail "The build finished but its output is missing."

  # 5) launcher
  mkdir -p "$bindir"
  launcher=$bindir/legion
  {
    printf '#!/bin/sh\n'
    printf '# Starts Legion from %s\n' "$dir"
    printf 'exec "%s/node_modules/.bin/electron" "%s" "$@"\n' "$dir" "$dir"
  } > "$launcher"
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

say() { printf '%s\n' "$*"; }
fail() { printf 'Legion was not installed: %s\n' "$*" >&2; exit 1; }

main "$@"
