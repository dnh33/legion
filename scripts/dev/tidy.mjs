// npm run tidy: finds leftovers of dev work (stray processes, merged worktrees, merged local branches).
// Default is a report and nothing is touched. `--apply` acts. Node only, no dependencies. Windows first, must not crash on macOS/Linux.
//
//   node scripts/dev/tidy.mjs [--apply] [--min-age=60] [--remote=cloud]
//
// Safety rules (do not weaken):
//  - Processes: only node/pwsh/powershell/electron whose command line matches a dev pattern, is older than --min-age and is not
//    protected (installed app, MCP servers, Claude Code). The tidy process tree is never listed. A process that names an ACTIVE
//    worktree (not merged + clean) is never listed. --apply re-reads the command line and stops the PID only if it still matches.
//  - Worktrees: removable only when merged into the remote main AND clean. Never --force. A node_modules junction is removed by
//    link only, and the target is verified afterwards.
//  - Branches: local `git branch -d` only (never -D). Remote branches are reported, never deleted.
//
// "Merged" means: the commit is in the remote main and is NOT on its first-parent chain, i.e. it came in through a merge commit.
// A branch that is still at a main commit (fresh, nothing committed) or was fast-forwarded cannot be told apart from new work, so it
// counts as not merged. Squash-merged branches also count as not merged. All of these are left alone.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------------------------------------------------------
// Pure classification (exported, tested in test/dev-guardrails.test.ts)
// ---------------------------------------------------------------------------------------------------------------------------

const PROTECTED = [
  /\\Programs\\Legion(\\|$|["\s])/i, // the installed app: its electron and legion-core
  /\/Programs\/Legion(\/|$|["\s])/i,
  /\bmcp\b/i, // MCP servers (mcp, @playwright/mcp, legion-mcp-stdio, ...)
  /@playwright[\\/]mcp/i,
  /chrome-devtools-mcp/i,
  /sequential-thinking/i,
  /npx-cli\.js/i,
  /(^|[\\/\s"'])claude(\.exe)?(["'\s]|$)/i, // Claude Code itself
  /@anthropic-ai[\\/]claude-code/i,
  /shell-snapshots/i,
];

/** True for command lines tidy must never list or touch. */
export function isProtected(cmdline) {
  const c = String(cmdline || '');
  return PROTECTED.some((re) => re.test(c));
}

const hasTestGlob = (c) => /dist[\\/]test[\\/]\*\.test\.js/.test(c);

const DEV_PATTERNS = [
  // a full suite: node --test over the whole dist/test glob, not narrowed by --test-name-pattern
  { name: 'full test suite', test: (c) => /(^|[\s"'])--test(\s|=|$)/.test(c) && hasTestGlob(c) && !/--test-name-pattern/.test(c) },
  { name: 'serve -s dist', test: (c) => /\bserve(\.js|\.cmd)?["']?\s+-s\s+["']?dist/.test(c) },
  { name: 'UI harness / shots rig', test: (c) => /scripts[\\/]harness[\\/]|shots-rig|ui[\\/]dev[\\/][^\s"']*serve\.mjs|[\\/]serve\.mjs\b/.test(c) },
  { name: 'vite dev/preview', test: (c) => /(^|[\\/\s"'])vite(\.js|\.cmd)?["']?(\s|$)/.test(c) && !/(^|\s)build(\s|$)/.test(c) },
  { name: 'playwright install', test: (c) => /playwright(-core)?[\\/][^\s"']*cli[^\s"']*["']?\s+install\b|playwright["']?\s+install\b/i.test(c) },
  { name: 'script under Temp legion-', test: (c) => /[\\/]Temp[\\/]legion-|^\/tmp\/legion-|[\s"']\/tmp\/legion-|\/var\/folders\/[^\s"']*\/legion-/i.test(c) },
  { name: 'Claude scratchpad script', test: (c) => /[\\/]Temp[\\/]claude[\\/][^\s"']*scratchpad|[\\/]scratchpad[\\/][^\s"']*\.(m?js|ps1|py|sh)\b/i.test(c) },
];

/** Name of the dev pattern a command line matches, or null. Does not consider protection: callers check isProtected first. */
export function devPattern(cmdline) {
  const c = String(cmdline || '');
  for (const p of DEV_PATTERNS) if (p.test(c)) return p.name;
  return null;
}

/** True when the command line looks like a dev leftover and is not protected. */
export function isDevProcess(cmdline) {
  return !isProtected(cmdline) && devPattern(cmdline) !== null;
}

export const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** The registered worktree whose folder the command line names (longest match), or null. */
export function worktreeOfCmdline(cmdline, worktrees) {
  const c = normPath(cmdline.replace(/["']/g, ''));
  let best = null;
  for (const w of worktrees) {
    const p = normPath(w.path);
    if (!p) continue;
    if (c.includes(p + '/') || c.endsWith(p)) {
      if (!best || p.length > normPath(best.path).length) best = w;
    }
  }
  return best;
}

/**
 * Decides whether one process may be listed.
 * proc: { pid, name, cmdline, ageMin }. ctx: { minAge, worktrees: [{path, isMain, removable}] }.
 * Returns { listed: boolean, why: string }.
 */
export function classifyProcess(proc, ctx) {
  const name = String(proc.name || '').toLowerCase().replace(/\.exe$/, '');
  if (!['node', 'pwsh', 'powershell', 'electron'].includes(name)) return { listed: false, why: 'not a dev runtime' };
  const cmd = String(proc.cmdline || '');
  if (!cmd) return { listed: false, why: 'no command line' };
  if (isProtected(cmd)) return { listed: false, why: 'protected' };
  if (proc.ageMin !== null && proc.ageMin !== undefined && proc.ageMin < ctx.minAge) return { listed: false, why: 'too young' };
  const wt = worktreeOfCmdline(cmd, ctx.worktrees || []);
  if (wt && wt.isMain) {
    // The main checkout's own running app stays. Its dev servers still match by pattern below.
    if (/legion-core\.js|electron/i.test(cmd) && devPattern(cmd) === null) return { listed: false, why: 'main checkout app' };
  } else if (wt) {
    if (!wt.removable) return { listed: false, why: 'active worktree' };
    return { listed: true, why: 'process in a merged, clean worktree' };
  }
  const pat = devPattern(cmd);
  if (pat) return { listed: true, why: pat };
  return { listed: false, why: 'no dev pattern' };
}

/** Parses `git worktree list --porcelain` into [{path, head, branch, detached, bare, locked, prunable}]. First entry is the main one. */
export function parseWorktreePorcelain(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === '') { if (cur) out.push(cur); cur = null; continue; }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') { if (cur) out.push(cur); cur = { path: val, head: '', branch: null, detached: false, bare: false, locked: false, prunable: false }; continue; }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

const IGNORABLE_UNTRACKED = /^\?\? (dist|dist-ui|node_modules)\/?$/;

/** Counts of dirty entries in `git status --porcelain` lines, ignoring untracked dist/, dist-ui/ and a node_modules link. */
export function dirtyCounts(statusLines) {
  let changed = 0;
  let untracked = 0;
  for (const l of statusLines) {
    if (!l.trim()) continue;
    if (IGNORABLE_UNTRACKED.test(l)) continue;
    if (l.startsWith('??')) untracked++;
    else changed++;
  }
  return { changed, untracked };
}

/** True when `sha` is in the remote main and came in through a merge (not on the first-parent chain). */
export function isMergedSha(sha, allInMain, firstParentOfMain) {
  return !!sha && allInMain.has(sha) && !firstParentOfMain.has(sha);
}

/**
 * Removability of one worktree. wt: parsed porcelain entry. info: { isMain, isCurrent, merged, statusLines }.
 * Returns { removable, reason, changed, untracked }.
 */
export function worktreeRemovability(wt, info) {
  const base = { changed: 0, untracked: 0 };
  if (info.isMain) return { ...base, removable: false, reason: 'main checkout' };
  if (info.isCurrent) return { ...base, removable: false, reason: 'current worktree' };
  if (wt.branch === 'main' || wt.branch === 'master') return { ...base, removable: false, reason: 'default branch checkout' };
  if (wt.bare) return { ...base, removable: false, reason: 'bare' };
  if (wt.locked) return { ...base, removable: false, reason: 'locked' };
  if (wt.prunable) return { ...base, removable: false, reason: 'stale (git worktree prune)' };
  const d = dirtyCounts(info.statusLines || []);
  if (!info.merged) return { ...d, removable: false, reason: d.changed + d.untracked ? 'not merged, dirty' : 'not merged' };
  if (d.changed + d.untracked) return { ...d, removable: false, reason: 'merged but dirty' };
  return { ...d, removable: true, reason: 'merged, clean' };
}

/** Local branches that may be deleted with `git branch -d`. */
export function deletableBranches(branches, { checkedOut, allInMain, firstParentOfMain }) {
  return branches.filter((b) => b.name !== 'main' && b.name !== 'master' && !checkedOut.has(b.name) && isMergedSha(b.sha, allInMain, firstParentOfMain));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Process listing
// ---------------------------------------------------------------------------------------------------------------------------

function parseEtime(s) {
  // [[dd-]hh:]mm:ss -> minutes
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return null;
  return Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3]);
}

function listProcesses() {
  if (IS_WIN) {
    const script =
      "$ErrorActionPreference='SilentlyContinue';" +
      "$n=Get-Date;" +
      "$r=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|pwsh|powershell|electron)(\\.exe)?$' } | " +
      "ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=$_.Name; cmdline=$_.CommandLine; ageMin=[int]($n - $_.CreationDate).TotalMinutes } });" +
      "$a=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId } });" +
      "[pscustomobject]@{ procs=$r; all=$a } | ConvertTo-Json -Compress -Depth 4";
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) return { procs: [], all: [], error: (r.stderr || 'powershell failed').trim().slice(0, 200) };
    try {
      const j = JSON.parse(r.stdout);
      const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
      return { procs: arr(j.procs), all: arr(j.all) };
    } catch (e) {
      return { procs: [], all: [], error: 'could not parse process list' };
    }
  }
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,etime=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { procs: [], all: [], error: 'ps failed' };
  const procs = [];
  const all = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    all.push({ pid, ppid });
    const first = m[4].trim().split(/\s+/)[0];
    procs.push({ pid, ppid, name: basename(first), cmdline: m[4].trim(), ageMin: parseEtime(m[3]) });
  }
  return { procs, all };
}

/** Pids of this process, its ancestors and its descendants. */
function selfTree(all) {
  const parent = new Map(all.map((p) => [p.pid, p.ppid]));
  const keep = new Set([process.pid]);
  let cur = process.pid;
  for (let i = 0; i < 64; i++) {
    const n = parent.get(cur);
    if (!n || keep.has(n)) break;
    keep.add(n);
    cur = n;
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) if (keep.has(p.ppid) && !keep.has(p.pid)) { keep.add(p.pid); grew = true; }
  }
  return keep;
}

function descendants(all, root) {
  const out = [];
  const seen = new Set([root]);
  let frontier = [root];
  while (frontier.length) {
    const next = [];
    for (const p of all) if (frontier.includes(p.ppid) && !seen.has(p.pid)) { seen.add(p.pid); out.push(p.pid); next.push(p.pid); }
    frontier = next;
  }
  return out;
}

function stopPid(pid, all) {
  if (IS_WIN) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
    return r.status === 0;
  }
  for (const c of descendants(all, pid).reverse()) { try { process.kill(c, 'SIGTERM'); } catch { /* gone */ } }
  try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------------------------------------------------------

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\r/g, ''), err: (r.stderr || '').trim() };
}

function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Removes a node_modules junction/symlink by the link only, and verifies the target survived. Returns {ok, note}. */
function removeLinkOnly(link) {
  let target = null;
  try { target = realpathSync(link); } catch { /* dangling */ }
  try {
    if (IS_WIN) rmdirSync(link); // RemoveDirectory on a junction removes the reparse point only, never the contents
    else unlinkSync(link);
  } catch (e) {
    try { unlinkSync(link); } catch (e2) { return { ok: false, note: `could not remove link: ${e2.code || e.code}` }; }
  }
  if (existsSync(link)) return { ok: false, note: 'link still present' };
  if (target && !existsSync(target)) return { ok: false, note: 'TARGET GONE AFTER LINK REMOVAL: stop and investigate' };
  return { ok: true, note: target ? 'link removed, target intact' : 'link removed' };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------------------

function table(headers, rows) {
  if (!rows.length) return '  (none)';
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => '  ' + r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join('\n');
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 3) + '...' : s);

// ---------------------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { apply: false, minAge: 60, remote: 'cloud' };
  for (const a of argv) {
    if (a === '--apply') o.apply = true;
    else if (a.startsWith('--min-age=')) o.minAge = Number(a.slice(10));
    else if (a.startsWith('--remote=')) o.remote = a.slice(9);
  }
  if (!Number.isFinite(o.minAge) || o.minAge < 0) o.minAge = 60;
  return o;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const here = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const summary = { procs: 0, procsStopped: 0, wtRemovable: 0, wtRemoved: 0, wtKept: 0, brDeletable: 0, brDeleted: 0, brRemote: 0 };
  console.log(opts.apply ? 'tidy --apply' : 'tidy (report only; --apply to act)');

  // Worktrees and the merged set come first: process classification needs them.
  const wl = git(['worktree', 'list', '--porcelain'], here);
  const worktrees = wl.ok ? parseWorktreePorcelain(wl.out) : [];
  let remote = opts.remote;
  let mainRef = null;
  for (const r of [remote, 'origin']) {
    for (const b of ['main', 'master']) {
      if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/${r}/${b}`], here).ok) { mainRef = `${r}/${b}`; remote = r; break; }
    }
    if (mainRef) break;
  }
  let allInMain = new Set();
  let firstParent = new Set();
  if (mainRef) {
    allInMain = new Set(git(['rev-list', `refs/remotes/${mainRef}`], here).out.split('\n').filter(Boolean));
    firstParent = new Set(git(['rev-list', '--first-parent', `refs/remotes/${mainRef}`], here).out.split('\n').filter(Boolean));
  }
  const hereN = normPath(here);
  const wtInfo = worktrees.map((w, i) => {
    const isMain = i === 0;
    const isCurrent = normPath(w.path) === hereN;
    let statusLines = [];
    if (!w.prunable && !w.bare && existsSync(w.path)) {
      const st = git(['status', '--porcelain'], w.path);
      statusLines = st.ok ? st.out.split('\n').filter(Boolean) : ['?? (status failed)'];
    }
    const merged = !!mainRef && isMergedSha(w.head, allInMain, firstParent);
    const v = worktreeRemovability(w, { isMain, isCurrent, merged, statusLines });
    return { ...w, isMain, isCurrent, ...v };
  });

  // a. Processes
  console.log('\nProcesses (dev leftovers older than ' + opts.minAge + ' min)');
  const listing = listProcesses();
  let candidates = [];
  if (listing.error) console.log('  could not list processes: ' + listing.error);
  else {
    const mine = selfTree(listing.all);
    const ctx = { minAge: opts.minAge, worktrees: wtInfo.map((w) => ({ path: w.path, isMain: w.isMain, removable: w.removable })) };
    for (const p of listing.procs) {
      if (mine.has(p.pid)) continue;
      const c = classifyProcess(p, ctx);
      if (c.listed) candidates.push({ ...p, why: c.why });
    }
    console.log(table(['pid', 'name', 'age', 'why', 'command'], candidates.map((p) => [p.pid, p.name, (p.ageMin ?? '?') + 'm', p.why, trunc(p.cmdline, 70)])));
  }
  summary.procs = candidates.length;
  if (opts.apply && candidates.length) {
    for (const p of candidates) {
      const fresh = listProcesses();
      const now = fresh.procs.find((q) => q.pid === p.pid);
      const mine = selfTree(fresh.all);
      const ctx = { minAge: opts.minAge, worktrees: wtInfo.map((w) => ({ path: w.path, isMain: w.isMain, removable: w.removable })) };
      if (!now || now.cmdline !== p.cmdline || mine.has(p.pid) || !classifyProcess(now, ctx).listed) {
        console.log(`  skip ${p.pid}: gone or command line changed`);
        continue;
      }
      if (stopPid(p.pid, fresh.all)) { summary.procsStopped++; console.log(`  stopped ${p.pid}`); }
      else console.log(`  could not stop ${p.pid}`);
    }
  }

  // b. Worktrees
  console.log('\nWorktrees' + (mainRef ? ` (merged = in ${mainRef}; fetch first for a current view)` : ''));
  if (!wl.ok) console.log('  not a git repository or git failed');
  else if (!mainRef) console.log(`  no ${opts.remote}/main or origin/main ref: nothing is treated as merged`);
  const rows = wtInfo.filter((w) => !w.isMain).map((w) => [w.path.replace(/\\/g, '/'), w.branch || '(detached)', w.reason, w.changed || w.untracked ? `${w.changed} changed, ${w.untracked} untracked` : '-']);
  console.log(table(['path', 'branch', 'verdict', 'dirty'], rows));
  summary.wtRemovable = wtInfo.filter((w) => w.removable).length;
  summary.wtKept = wtInfo.filter((w) => !w.isMain && !w.removable).length;
  if (opts.apply) {
    for (const w of wtInfo.filter((x) => x.removable)) {
      const nm = resolve(w.path, 'node_modules');
      if (isLink(nm)) {
        const r = removeLinkOnly(nm);
        console.log(`  ${w.path}: node_modules ${r.note}`);
        if (!r.ok) continue;
      }
      const rm = git(['worktree', 'remove', w.path], here);
      if (!rm.ok) { console.log(`  ${w.path}: git worktree remove refused: ${rm.err.split('\n')[0]}`); continue; }
      summary.wtRemoved++;
      console.log(`  removed ${w.path}`);
      try { if (existsSync(w.path) && readdirSync(w.path).length === 0) rmSync(w.path, { recursive: false, force: false }); } catch { /* leave */ }
    }
    const pr = git(['worktree', 'prune'], here);
    console.log(pr.ok ? '  git worktree prune done' : '  git worktree prune failed');
  } else if (wtInfo.some((w) => w.prunable)) {
    console.log('  stale entries exist: --apply runs git worktree prune');
  }

  // c. Branches
  console.log('\nBranches');
  if (mainRef) {
    const refs = git(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], here).out.split('\n').filter(Boolean).map((l) => { const [name, sha] = l.split(' '); return { name, sha }; });
    const checkedOut = new Set(worktrees.map((w) => w.branch).filter(Boolean));
    const del = deletableBranches(refs, { checkedOut, allInMain, firstParentOfMain: firstParent });
    summary.brDeletable = del.length;
    console.log('  local, merged, not checked out:');
    console.log(table(['branch'], del.map((b) => [b.name])));
    if (opts.apply) {
      for (const b of del) {
        const r = git(['branch', '-d', b.name], here);
        if (r.ok) { summary.brDeleted++; console.log(`  deleted ${b.name}`); }
        else console.log(`  kept ${b.name}: ${r.err.split('\n')[0]}`);
      }
    }
    const rem = git(['for-each-ref', '--format=%(refname:short) %(objectname)', `refs/remotes/${remote}`], here).out.split('\n').filter(Boolean)
      .map((l) => { const [name, sha] = l.split(' '); return { name, sha }; })
      .filter((b) => !/\/(HEAD|main|master)$/.test(b.name) && isMergedSha(b.sha, allInMain, firstParent));
    summary.brRemote = rem.length;
    console.log(`  remote ${remote}, merged (report only, never deleted):`);
    console.log(table(['branch'], rem.map((b) => [b.name])));
  } else console.log('  skipped: no main ref');

  console.log(
    `\nSummary: ${summary.procs} process(es) listed${opts.apply ? `, ${summary.procsStopped} stopped` : ''}; ` +
      `${summary.wtRemovable} worktree(s) removable${opts.apply ? `, ${summary.wtRemoved} removed` : ''}, ${summary.wtKept} kept; ` +
      `${summary.brDeletable} local branch(es) deletable${opts.apply ? `, ${summary.brDeleted} deleted` : ''}; ${summary.brRemote} merged remote branch(es) (report only).`,
  );
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { main(); } catch (e) { console.error('tidy failed: ' + (e && e.message ? e.message : e)); }
  process.exitCode = 0;
}
