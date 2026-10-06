# Plan: one-line install from getlegion.xyz (2026-10-06)

Goal: one short command per OS installs Legion.

- macOS / Linux: `curl -fsSL https://getlegion.xyz | sh`
- Windows: `irm https://getlegion.xyz | iex`

The maintainer decided: the site moves from Netlify to Cloudflare (Pages for the site, a function on `/` for the scripts); this comes before logging.

## What the scripts do

- **install.ps1 (Windows):** resolve the latest release from the `releases/latest` redirect (not the GitHub API: shared CI IPs hit its rate limit), download `legion-<v>-win-x64.zip` and `SHA256SUMS.txt` over HTTPS, then run the existing `setup.ps1 -PackagePath <zip> -PackageSha256 <hash>` through `powershell -ExecutionPolicy Bypass -File` (an `iex` session skips execution policy; the downloaded file does not). Claim, exactly: "downloaded from GitHub Releases over HTTPS and checked against the release's SHA-256". The installer zip is not signed (the release signature covers the update manifest and `app.zip` only).
- **install.sh (macOS / Linux):** POSIX `sh`, LF only. Check Node 20.10+ and git (say how to get them if missing; install nothing system-wide, no sudo). Fetch the source at the latest release tag into a per-user folder, `npm ci`, `npm run build`, write a launcher. No prebuilt app exists for macOS/Linux.
- Both: the whole body sits in one function called on the last line, so a cut-off download runs nothing. Short, readable, no telemetry. `--no-launch` / `-NoLaunch` for CI.

## Where the scripts live and how they are served

- Source and tests: this repo, `scripts/install/install.sh` and `install.ps1`; `.gitattributes` gets `*.sh text eol=lf`.
- Served copies: attached to each GitHub release as assets, so what users run is a CI-tested release, never a moving branch. The Cloudflare function on `/` fetches `releases/latest/download/install.{sh,ps1}` (cached briefly) and returns it as `text/plain; charset=utf-8`, no BOM.
- Routing on `/`: a request whose user agent carries the `PowerShell`/`WindowsPowerShell` token gets install.ps1; curl/wget get install.sh; everything else (browsers, `Accept: text/html`) gets the website. Confirmed from real request headers logged from PowerShell 5.1, PowerShell 7, curl and wget on the `*.pages.dev` preview before any DNS change. `/install.sh` and `/install.ps1` also work as readable paths.

## Tests (CI, never on the maintainer's PC)

- New CI jobs (coordinated with the session that owns `.github/workflows/ci.yml`): Windows runs `irm <preview>/ | iex` on PowerShell 5.1 and 7 with no launch; Ubuntu and macOS run `curl -fsSL <preview>/ | sh` with no launch; each checks the installed version.
- Unit tests for the routing function (user agents, `Accept`, readable paths, content type).

## Moving the site (zero downtime, in order)

1. Port the site: `_headers` from `netlify.toml`; `SITE_URL=https://getlegion.xyz` for the build (`tools/site-url.mjs` reads Netlify's `URL` today); replace the Netlify Forms bug-report form (`src/components/BugReport.astro`) with a link to GitHub issues, or a Cloudflare function (maintainer's choice).
2. Deploy to a `*.pages.dev` preview; check every page, the headers and the routing with real clients.
3. Create the getlegion.xyz zone on Cloudflare. DNS today has only the apex and www (no MX, TXT, CAA; DNSSEC off), so nothing else needs copying.
4. The maintainer changes the nameservers at Porkbun to the two Cloudflare gives.
5. Attach getlegion.xyz and www to the Pages project; re-test both one-liners on the real domain (watch for Bot Fight Mode or a challenge page reaching curl).
6. Only then retire the Netlify site.

## Who does what

Building, previews and tests: agents. Creating the zone, the Pages project and deploys on the maintainer's Cloudflare account: only with the maintainer's OK per step. Nameservers at Porkbun and retiring Netlify: the maintainer. The README install line ships with the release that carries the scripts.

## Maintainer decisions (2026-10-06)

- The commands use `https://`: `curl -fsSL https://getlegion.xyz | sh` and `irm https://getlegion.xyz | iex`.
- Steps on the Cloudflare account (zone, Pages project, deploys): agents run them with the signed-in `cf` CLI, with the maintainer's OK before each step. Nameservers at Porkbun and retiring Netlify: the maintainer.
- The Netlify Forms bug-report form becomes a link to GitHub issues.
- macOS/Linux install folder: `~/.local/share/legion`, launcher `~/.local/bin/legion`. No sudo.
- Before the first release with the scripts, CI runs them straight from the repo (`sh scripts/install/install.sh --no-launch`, `powershell -File scripts/install/install.ps1 -NoLaunch`); the `irm … | iex` and `curl … | sh` paths are tested against the pages.dev preview once it exists.
