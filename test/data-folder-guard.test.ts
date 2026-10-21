// test/data-folder-guard.test.ts: a shell command that names Legion's own data folder (gates, key, projects, config, armory, away)
import test from 'node:test';
import assert from 'node:assert/strict';
import { dataFolderHit, dataFolderRead } from '../src/core/exec/data-folder-guard.js';
import { classifySafe } from '../src/shared/consequence.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataFolderTargets } from '../src/core/exec/canonical-path.js';
import { tempDir } from './tmp-cleanup.js';

// The fixtures below are Windows spellings (drive letters, %APPDATA%, Git Bash /c/ and WSL /mnt/c/, case folding): on Linux and macOS
// such a word is a relative path, not the data folder, so those tests run on Windows only. The POSIX tests at the end run everywhere.
const WIN_ONLY = process.platform === 'win32' ? false : 'Windows path spellings (drive letters, %APPDATA%, /c/ and /mnt/c/): the POSIX tests below cover Linux and macOS';
const DATA = 'C:/Users/Fakeuser/AppData/Roaming/legion';
const env = { APPDATA: 'C:\\Users\\Fakeuser\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Fakeuser\\AppData\\Local', USERPROFILE: 'C:\\Users\\Fakeuser', HOME: '/c/Users/Fakeuser' };
const hit = (command: string, kind: 'sh' | 'pwsh' = 'sh', folder = DATA) => dataFolderHit(command, kind, [folder], { cwd: 'C:/work/projA', env });

test('a command that names the data folder is found, in every spelling', { skip: WIN_ONLY }, () => {
  for (const c of [
    'mv C:/Users/Fakeuser/AppData/Roaming/legion/gates/app.json C:/work/projB/x',
    'cp C:/work/projB/old.json C:/Users/Fakeuser/AppData/Roaming/legion/gates/app.json',
    'rm C:\\Users\\Fakeuser\\AppData\\Roaming\\legion\\gates\\app.json',
    'rm c:/users/fakeuser/appdata/roaming/LEGION/gates/APP.JSON',
    'echo {} > "C:\\Users\\Fakeuser\\AppData\\Roaming\\legion\\projects.json"',
    'mv "$APPDATA/legion/gates/app.json" x',
    'mv ${APPDATA}/legion/gates/app.json x',
    'mv %APPDATA%\\legion\\gates\\app.json x',
    'mv ~/AppData/Roaming/legion/gates-key.bin x',
    'mv $HOME/AppData/Roaming/legion/gates-key.bin x',
    'mv /c/Users/Fakeuser/AppData/Roaming/legion/gates/app.json x',
    'mv /mnt/c/Users/Fakeuser/AppData/Roaming/legion/gates/app.json x',
    'mv C:/Users/Fakeuser/AppData/Roaming/legion/../legion/gates/app.json x',
    'mv C:/Users/Fakeuser/AppData/Roaming/./legion//gates/app.json x',
    'cd C:/Users/Fakeuser/AppData/Roaming/legion && mv gates/app.json x',
    'mv C:/Users/Fakeuser/AppData/Roaming/leg*/gates/app.json x',
  ]) assert.equal(hit(c), 'names', c);
  for (const c of [
    'Remove-Item $env:APPDATA\\legion\\gates\\app.json',
    'Remove-Item "$env:APPDATA/legion/gates/app.json"',
    'Move-Item $env:USERPROFILE\\AppData\\Roaming\\legion\\gates\\app.json x',
    'Copy-Item x $env:APPDATA\\legion\\projects.json',
    'ri $env:LOCALAPPDATA\\..\\Roaming\\legion\\gates\\app.json',
  ]) assert.equal(hit(c, 'pwsh'), 'names', c);
});

test('a path hidden behind a variable or a substitution could point there: hidden', () => {
  // the substitution's own text names a folder above the data folder: a card either way
  assert.notEqual(hit('mv "$(echo C:/Users/Fakeuser/AppData/Roaming)/legion/gates/app.json" x'), 'none');
  for (const c of ['mv $D/gates/app.json x', 'mv `pwd`/app.json x', 'cp x %SOMETHING%\\app.json', 'mv ${DIR}app.json x']) assert.equal(hit(c), 'hidden', c);
  assert.equal(hit('Move-Item $dir\\app.json x', 'pwsh'), 'hidden');
  assert.equal(hit('mv C:/Users/FAKEUS~1/AppData/Roaming/legion/gates/app.json x'), 'hidden', 'a short (8.3) name cannot be told');
});

test('commands that do not name the folder are none', () => {
  for (const c of ['ls', 'npm test 2>&1 | tail -5', 'git commit -m "costs $5"', 'mv a.txt b.txt', 'rm -rf node_modules', 'cat C:/Users/Fakeuser/AppData/Roaming/legion2/x', 'echo $HOME', 'cp C:/work/legion/a C:/work/legion/b', 'git status']) assert.equal(hit(c), 'none', c);
  assert.equal(hit('Get-ChildItem | ForEach-Object { $_.Name }', 'pwsh'), 'none');
});

test('the data folder given with ~ or in another spelling still matches', { skip: WIN_ONLY }, () => {
  assert.equal(dataFolderHit('rm ~/.legion/gates/app.json', 'sh', ['C:\\Users\\Fakeuser\\.legion'], { env }), 'names');
  assert.equal(dataFolderHit('rm $HOME/.legion/gates-key.bin', 'sh', ['C:\\Users\\Fakeuser\\.legion\\'], { env }), 'names');
  assert.equal(dataFolderHit('rm ~/.legion-other/x', 'sh', ['C:\\Users\\Fakeuser\\.legion'], { env }), 'none');
});

test('the level decides: the mv and cp probes write outside the project, so they are level 3 and Smart asks on level too (the guard cards them as well)', () => {
  const lvl = (command: string) => classifySafe({ kind: 'approval', toolName: 'Bash', input: { command }, projectFolders: ['C:/work/projB'] }).level;
  assert.equal(lvl('mv C:/Users/Fakeuser/AppData/Roaming/legion/gates/app.json C:/work/projB/x'), 3);
  assert.equal(lvl('cp C:/work/projB/old.json C:/Users/Fakeuser/AppData/Roaming/legion/gates/app.json'), 3);
  assert.ok(lvl('cat C:/Users/Fakeuser/AppData/Roaming/legion/projects.json') <= 2);
});

test('N30: a cd then ordinary work is free; the cd does not hide a path that names the data folder', { skip: WIN_ONLY }, () => {
  for (const kind of ['sh', 'pwsh'] as const) {
    assert.equal(hit('cd x; npm run build', kind), 'none', `${kind}: cd x; npm run build`);
    assert.equal(hit('cd x; rm -rf build', kind), 'none', `${kind}: cd x; rm -rf build`);
    assert.equal(hit('cd x || exit 1; rm build/a.o', kind), 'none', `${kind}: cd x || ...`);
  }
  // a cd that fails leaves the old folder, one that works gives the new one: both are tried
  assert.equal(hit('cd x; rm ../../../Users/Fakeuser/AppData/Roaming/legion/gates/app.json'), 'names');
  assert.equal(hit('cd /nonexistent; rm ../../Users/Fakeuser/AppData/Roaming/legion/gates/app.json'), 'names');
  // a target the guard cannot read leaves no known folder: still hidden
  assert.equal(hit('cd $WHERE; rm build/a.o'), 'hidden');
});

test('N30: TMPDIR is a known folder variable', () => {
  const run = (c: string) => dataFolderHit(c, 'sh', [DATA], { cwd: 'C:/work/projA', env: { ...env, TMPDIR: 'C:\Users\Fakeuser\AppData\Local\Temp' } });
  assert.equal(run('rm -rf $TMPDIR/x'), 'none');
  assert.equal(run('rm -rf ${TMPDIR}/x'), 'none');
});

test('N29: moved is set by a cd the guard cannot prove stays outside; cwdUnknown makes relative write words hidden', { skip: WIN_ONLY }, () => {
  const read = (c: string, o: { cwdUnknown?: boolean } = {}) => dataFolderRead(c, 'sh', [DATA], { cwd: 'C:/work/projA', env, ...o });
  assert.equal(read('cd sub; ls').moved, false, 'a project subfolder is provably outside');
  assert.equal(read('npm test').moved, false);
  assert.equal(read('cd C:/Users/Fakeuser/AppData/Roaming/legion').moved, true);
  assert.equal(read('cd C:/Users/Fakeuser').moved, true, 'a folder above the data folder');
  assert.equal(read('cd $WHERE').moved, true);
  assert.equal(read('rm gates/app.json').hit, 'none');
  assert.equal(read('rm gates/app.json', { cwdUnknown: true }).hit, 'hidden');
  assert.equal(read('cat gates/app.json', { cwdUnknown: true }).hit, 'none', 'reading stays free');
});

/* ---------- the same rules with this computer's own paths (Linux, macOS and Windows alike) ---------- */

// A real folder: the home folder and the data folder inside it (as `~/.legion` is), and a project next to it. Native paths, written with `/`.
const BASE = tempDir('legion-dfg-native-');
const NHOME = join(BASE, 'home');
const NDATA = join(NHOME, '.legion-x');
mkdirSync(join(NDATA, 'gates'), { recursive: true });
mkdirSync(join(BASE, 'proj', 'sub'), { recursive: true });
const NENV = { HOME: NHOME, USERPROFILE: NHOME };
const fh = NHOME.replace(/\\/g, '/');
const fd = NDATA.replace(/\\/g, '/');
const nhit = (command: string, kind: 'sh' | 'pwsh' = 'sh') => dataFolderHit(command, kind, dataFolderTargets(NDATA), { cwd: join(BASE, 'proj'), env: NENV });

test('native paths: a write that names the protected files is found in every spelling the shell reads', () => {
  for (const c of [
    `mv ${fd}/gates/app.json x`,
    `cp x ${fd}/gates/app.json`,
    `rm ${fd}/gates-key.bin`,
    `echo {} > "${fd}/projects.json"`,
    'rm ~/.legion-x/gates/app.json',
    'rm $HOME/.legion-x/gates-key.bin',
    'rm ${HOME}/.legion-x/config.json',
    'rm "$HOME"/.legion-x/state.json',
    `rm ${fh}//.legion-x/./gates/../gates/app.json`,
    `cd ${fd} && mv gates/app.json x`,
    'cd ~/.legion-x && rm gates-key.bin',
    `mv ${fh}/.legion-*/gates/app.json x`,
    `rm -rf ${fh}`,
    `rm -rf ${fd}`,
  ]) assert.equal(nhit(c), 'names', c);
  assert.equal(nhit(`Remove-Item ${fd}/gates/app.json`, 'pwsh'), 'names');
});

test('native paths: other files, reads and the rest of the data folder stay free', () => {
  for (const c of ['rm ~/.legion-x2/x', 'mv a b', 'rm -rf node_modules', `cat ${fd}/gates/app.json`, `rm ${fd}/workspaces/a/old.txt`, `rm -rf ${fd}/logs`, 'cd sub; rm -rf build']) assert.equal(nhit(c), 'none', c);
});

test('native paths: a move into the data folder marks the rest of the run; a project subfolder does not', () => {
  const read = (c: string) => dataFolderRead(c, 'sh', dataFolderTargets(NDATA), { cwd: join(BASE, 'proj'), env: NENV });
  assert.equal(read('cd sub; ls').moved, false);
  assert.equal(read(`cd ${fd}`).moved, true);
  assert.equal(read(`cd ${fh}`).moved, true, 'a folder above the data folder');
  assert.equal(dataFolderRead('rm gates/app.json', 'sh', dataFolderTargets(NDATA), { cwd: join(BASE, 'proj'), env: NENV, cwdUnknown: true }).hit, 'hidden');
});

test('native paths: another case is the same file where the disk ignores case (Windows, macOS) and another file on Linux', () => {
  const want = process.platform === 'linux' ? 'none' : 'names';
  assert.equal(nhit('rm ~/.LEGION-X/GATES/app.json'), want);
});

test('code for an interpreter: a backslash escape (\\\\ at a line end, "\\\\n" in a string) is not the drive root, so ordinary Python edits are not carded', { skip: WIN_ONLY }, () => {
  // Found on a real run (0.3.5): a "python - <<'EOF'" edit whose code held a doubled backslash (a line continuation or an escape inside a
  // string) read as the root of the drive, which holds the data folder, so even Full carded it as "works on Legion's own settings folder".
  const real = (body: string) => `cd "C:/work/projA/atmos-open" && python - <<'PYEOF'\n${body}\nPYEOF`;
  for (const body of [
    '    assert not bad, "scene files do not match the current schema:\\\\n  " + \\\\',
    '    ild_ok = early["ild_db"] < 0.0 < late["ild_db"] \\\\',
    'print("a\\\\\\\\b")',
    's = s.replace("\\\\r\\\\n", "\\\\n")',
  ]) assert.equal(hit(real(body)), 'none', body);
  // a real path in the code still counts, in either slash, and so does the drive root written as a path
  assert.equal(hit(real("open('C:/Users/Fakeuser/AppData/Roaming/legion/projects.json', 'w')")), 'names');
  assert.equal(hit(real("open('C:\\\\Users\\\\Fakeuser\\\\AppData\\\\Roaming\\\\legion\\\\projects.json', 'w')")), 'names');
  assert.equal(hit(real("open('\\\\Users\\\\Fakeuser\\\\AppData\\\\Roaming\\\\legion\\\\projects.json', 'w')")), 'names');
  assert.equal(hit(real("import shutil; shutil.rmtree('C:\\\\')")), 'names');
});

test('code for an interpreter: a backslash that stands alone in quotes IS the root of the drive, and still counts (review of the escape fix)', { skip: WIN_ONLY }, () => {
  const py = (body: string) => `cd "C:/work/projA" && python - <<'PYEOF'\n${body}\nPYEOF`;
  for (const body of [
    "import shutil; shutil.rmtree('\\\\')",
    'import shutil; shutil.rmtree("\\\\")',
    "import os; os.chdir('\\\\'); os.remove('Users/Fakeuser/AppData/Roaming/legion/projects.json')",
    "import os; os.remove(os.path.join('\\\\', 'Users', 'Fakeuser', 'AppData', 'Roaming', 'legion', 'projects.json'))",
    "from pathlib import Path; (Path('\\\\') / 'Users').unlink()",
    "r = '\\\\'; open(r + 'Users\\\\Fakeuser\\\\AppData\\\\Roaming\\\\legion\\\\projects.json', 'w')",
  ]) assert.equal(hit(py(body)), 'names', body);
  // one-liners, spelled so the interpreter really receives a lone backslash in quotes (in shell double quotes, \\ becomes \ first)
  assert.equal(hit(`cd "C:/work/projA" && python -c 'import shutil; shutil.rmtree("\\\\")'`), 'names', 'python -c');
  assert.equal(hit(`cd "C:/work/projA" && python -c "import shutil; shutil.rmtree('\\\\\\\\')"`), 'names', 'python -c, double quoted');
  assert.equal(hit(`cd "C:/work/projA" && node -e 'require("fs").rmSync("\\\\", { recursive: true })'`), 'names', 'node -e');
});

test('code for an interpreter: a lone backslash in a paren quote (perl q(), ruby %q()) is still the drive root', { skip: WIN_ONLY }, () => {
  for (const c of [
    `cd "C:/work/projA" && perl -MFile::Path=rmtree -e 'rmtree(q(\\\\))'`,
    `cd "C:/work/projA" && ruby -rfileutils -e 'FileUtils.rm_rf(%q(\\\\))'`,
  ]) assert.equal(hit(c), 'names', c);
});

test('code for an interpreter: path building alone (pathlib, os.path, join) is not "could point there"; from the home folder or near a protected name it is', { skip: WIN_ONLY }, () => {
  const py = (body: string) => `cd "C:/work/projA" && python - <<'PYEOF'\n${body}\nPYEOF`;
  // ordinary project edits: no card outside Full either (found on a real run: every pathlib edit was "hidden", so Ask, Smart and Accept edits carded it)
  for (const body of [
    'from pathlib import Path\np = Path("src/hrtf.rs")\np.write_text(p.read_text(encoding="utf-8").replace("a", "b"), encoding="utf-8")',
    'import os\nwith open(os.path.join("src", "main.rs"), "w") as f:\n    f.write("x")',
    'from pathlib import Path\nfor f in Path("tests").glob("*.py"):\n    print(f.resolve())',
  ]) assert.equal(hit(py(body)), 'none', body);
  // built from the home folder or the environment: it could reach the data folder, so it is still hidden (or named)
  for (const body of [
    'from pathlib import Path\n(Path.home() / "AppData" / "Roaming" / "legion" / "projects.json").write_text("{}")',
    'import os\nos.remove(os.path.join(os.environ["APPDATA"], "legion", "projects.json"))',
    'import os\nos.remove(os.path.expanduser("~") + "/AppData/Roaming/legion/projects.json")',
  ]) assert.notEqual(hit(py(body)), 'none', body);
  // built from a variable but naming a protected file or the data folder's own name: still hidden
  for (const body of [
    'import os\nbase = input()\nos.remove(os.path.join(base, "projects.json"))',
    'from pathlib import Path\nimport sys\n(Path(sys.argv[1]) / "gates").rmdir()',
    'from pathlib import Path\nimport sys\n(Path(sys.argv[1]) / "legion" / "x").unlink()',
  ]) assert.notEqual(dataFolderHit(py(body), 'sh', dataFolderTargets(DATA), { cwd: 'C:/work/projA', env }), 'none', body); // the real protected set: gates, projects.json, ...
});

test('code for an interpreter: path building that walks up from the project folder, reaches the home folder without a home word, or assembles/decodes a name is still hidden (review of the path-building change)', { skip: WIN_ONLY }, () => {
  const py = (body: string) => `cd "C:/work/projA" && python - <<'PYEOF'\n${body}\nPYEOF`;
  const nd = (body: string) => `cd "C:/work/projA" && node - <<'JSEOF'\n${body}\nJSEOF`;
  const real = (c: string) => dataFolderHit(c, 'sh', dataFolderTargets(DATA), { cwd: 'C:/work/projA', env });
  const both = (c: string) => [hit(c), real(c)];
  const cards: Array<[string, string]> = [
    // walk-ups from the project folder (the project may sit inside the home folder, which holds the data folder)
    ['py cwd().parents[1]', py('from pathlib import Path\nimport shutil\nshutil.rmtree(Path.cwd().parents[1])')],
    ['py cwd().parent.parent', py('from pathlib import Path\nimport shutil\nshutil.rmtree(Path.cwd().parent.parent)')],
    ['py cwd() in a variable, then .parent', py('from pathlib import Path\nimport shutil\nhere = Path.cwd()\nshutil.rmtree(here.parent)')],
    ['py Path("..").resolve().parent', py('from pathlib import Path\nimport shutil\nshutil.rmtree(Path("..").resolve().parent)')],
    ['py abspath(join("..", ".."))', py('import os, shutil\nshutil.rmtree(os.path.abspath(os.path.join("..", "..")))')],
    ['py dirname(dirname(getcwd()))', py('import os, shutil\nshutil.rmtree(os.path.dirname(os.path.dirname(os.getcwd())))')],
    ['py os.pardir', py('import os, shutil\nshutil.rmtree(os.path.abspath(os.path.join(os.pardir, os.pardir)))')],
    ['py chdir("..") twice, then join(getcwd())', py('import os, shutil\nos.chdir("..")\nos.chdir("..")\nshutil.rmtree(os.path.join(os.getcwd(), "x"))')],
    // one level up: the current folder written out, then its parent (a project directly under the home folder makes that the home folder)
    ['py Path(".").resolve().parent', py('from pathlib import Path\nimport shutil\nshutil.rmtree(Path(".").resolve().parent)')],
    ['py Path().resolve().parent', py('from pathlib import Path\nimport shutil\nshutil.rmtree(Path().resolve().parent)')],
    ['py Path("").resolve().parent', py('from pathlib import Path\nimport shutil\nshutil.rmtree(Path("").resolve().parent)')],
    ['py Path(".").absolute().parent / name', py('from pathlib import Path\nimport shutil\nshutil.rmtree(Path(".").absolute().parent / "x")')],
    ['py Path.cwd().parent', py('from pathlib import Path\nimport shutil\nshutil.rmtree(Path.cwd().parent)')],
    ['py dirname(abspath("."))', py('import os, shutil\nshutil.rmtree(os.path.dirname(os.path.abspath(".")))')],
    ['py dirname(realpath(os.curdir))', py('import os, shutil\nshutil.rmtree(os.path.dirname(os.path.realpath(os.curdir)))')],
    ['node dirname(path.resolve("."))', nd('const path = require("path");\nrequire("fs").rmSync(path.dirname(path.resolve(".")), { recursive: true });')],
    ['node dirname(path.resolve())', nd('const path = require("path");\nrequire("fs").rmSync(path.dirname(path.resolve()), { recursive: true });')],
    ['python -c Path(".").resolve().parent', `cd "C:/work/projA" && python -c 'from pathlib import Path;import shutil;shutil.rmtree(Path(".").resolve().parent)'`],
    ['py base then a split name', py('import os, shutil\nbase = os.path.abspath(os.path.join("..", ".."))\nshutil.rmtree(os.path.join(base, ".leg" + "ion"))')],
    ['node resolve("..", "..")', nd('const path = require("path");\nrequire("fs").rmSync(path.resolve("..", ".."), { recursive: true });')],
    ['node join(process.cwd(), "..", "..")', nd('const path = require("path");\nrequire("fs").rmSync(path.join(process.cwd(), "..", ".."), { recursive: true });')],
    ['node dirname(process.cwd())', nd('const path = require("path");\nrequire("fs").rmSync(path.dirname(path.dirname(process.cwd())), { recursive: true });')],
    ['python -c abspath(join("..", ".."))', `cd "C:/work/projA" && python -c 'import shutil,os;shutil.rmtree(os.path.abspath(os.path.join("..","..")))'`],
    ['node -e resolve("..", "..", fromCharCode)', `cd "C:/work/projA" && node -e 'const path=require("path");require("fs").rmSync(path.resolve("..","..",String.fromCharCode(46,108,101,103,105,111,110)),{recursive:true})'`],
    // the home folder without the word "home": the user profile variables spelled out, a path from the user name, the passwd entry
    ['py expandvars HOMEDRIVE+HOMEPATH', py('import os, shutil\nshutil.rmtree(os.path.expandvars("%HOMEDRIVE%%HOMEPATH%"))')],
    ['py expandvars split name', py('import os, shutil\nshutil.rmtree(os.path.expandvars("%USER" + "PROFILE%"))')],
    ['py os.sep.join Users + user', py('import os, shutil\nuser = os.getlogin()\nshutil.rmtree(os.sep.join(["", "Users", user]))')],
    ['py getpass.getuser join', py('import getpass, os, shutil\nshutil.rmtree(os.path.join(os.sep, "Users", getpass.getuser()))')],
    ['py pw_dir', py('import pwd, os, shutil\nshutil.rmtree(pwd.getpwuid(os.getuid()).pw_dir)')],
    ['node os.userInfo().username join', nd('const path = require("path"), os = require("os");\nrequire("fs").rmSync(path.join("C:", "Users", os.userInfo().username), { recursive: true });')],
    // a name that is decoded, assembled from numbers, looked up by name or run from a string
    ['py b64decode + pathlib', py('import base64\nfrom pathlib import Path\nimport shutil\nshutil.rmtree(Path(base64.b64decode("QzovVXNlcnMvRmFrZXVzZXIvLmxlZ2lvbg==").decode()))')],
    ['py b64decode + os.path.join', py('import base64, os, shutil\nshutil.rmtree(os.path.join(base64.b64decode("QzovVXNlcnMvRmFrZXVzZXIvLmxlZ2lvbg==").decode()))')],
    ['py bytes.fromhex', py('import os, shutil\nshutil.rmtree(os.path.join("x", bytes.fromhex("2e6c6567696f6e").decode()))')],
    ['py chr() join', py('import shutil\nshutil.rmtree("".join(chr(c) for c in [67, 58, 47, 85, 115, 101, 114, 115]))')],
    ['py map(chr)', py('import shutil\nshutil.rmtree("".join(map(chr, [67, 58, 47])))')],
    ['py getattr(Path, "ho"+"me")', py('from pathlib import Path\ngetattr(Path, "ho" + "me")().joinpath(".leg" + "ion").unlink()')],
    ['py __import__', py('import os\n__import__("shutil").rmtree(os.path.join("x", "y"))')],
    ['py eval', py('import os\neval("__import__(chr(115)+chr(104))").rmtree(os.path.join("x"))')],
    ['node fromCharCode', nd('const path = require("path");\nrequire("fs").rmSync(path.join(String.fromCharCode(67, 58)), { recursive: true });')],
    ['node base64 Buffer', nd('const path = require("path");\nrequire("fs").rmSync(path.join(Buffer.from("QzovVXNlcnM=", "base64").toString()), { recursive: true });')],
    ['node atob', nd('const path = require("path");\nrequire("fs").rmSync(path.join(atob("QzovVXNlcnM=")), { recursive: true });')],
    // an interpreter named with a version (python3.12, py3.11) is read like python
    ['python3.12 heredoc, home', `cd "C:/work/projA" && python3.12 - <<'PYEOF'\nfrom pathlib import Path\nimport shutil\nshutil.rmtree(Path.home())\nPYEOF`],
    ['python3.12 -c, walk-up', `cd "C:/work/projA" && python3.12 -c 'import shutil,os;shutil.rmtree(os.path.abspath(os.path.join("..","..")))'`],
  ];
  for (const [name, c] of cards) for (const h of both(c)) assert.notEqual(h, 'none', name);
  // ordinary edits stay free: building a path from plain parts, a relative parent folder, the cwd as a base, a regex exec, a join of words
  const free: Array<[string, string]> = [
    ['py Path write_text', py('from pathlib import Path\np = Path("src/a.rs")\np.write_text(p.read_text(encoding="utf-8").replace("a", "b"), encoding="utf-8")')],
    ['py os.path.join open', py('import os\nopen(os.path.join("src", "m.rs"), "w").write("x")')],
    ['py Path.glob + resolve', py('from pathlib import Path\nfor f in Path("tests").glob("*.py"):\n    print(f.resolve())')],
    ['py new file in a new folder', py('from pathlib import Path\np = Path("src/new/mod.rs")\np.parent.mkdir(parents=True, exist_ok=True)\np.write_text("pub fn f() {}")')],
    ['py makedirs(dirname(relative))', py('import os\np = os.path.join("src", "new", "mod.rs")\nos.makedirs(os.path.dirname(p), exist_ok=True)\nopen(p, "w").write("x")')],
    // a parent of a path the script was given or wrote itself cannot leave the project: the makedirs idiom, __file__ (undefined in a heredoc), absolute() of a variable
    ['py makedirs(dirname(abspath(p)))', py('import os\np = os.path.join("src", "new", "mod.rs")\nos.makedirs(os.path.dirname(os.path.abspath(p)), exist_ok=True)\nopen(p, "w").write("x")')],
    ['py dirname(__file__) join', py('import os\nopen(os.path.join(os.path.dirname(__file__), "data.txt"), "w").write("x")')],
    ['py dirname(realpath(__file__))', py('import os\nopen(os.path.join(os.path.dirname(os.path.realpath(__file__)), "data.txt"), "w").write("x")')],
    ['py Path(p).absolute().parent.mkdir', py('from pathlib import Path\np = "src/new/mod.rs"\nPath(p).absolute().parent.mkdir(parents=True, exist_ok=True)\nPath(p).write_text("x")')],
    ['py Path(__file__).parent / data', py('from pathlib import Path\nprint((Path(__file__).parent / "data.txt").read_text())')],
    ['py Path("out/a.txt").resolve().parent.mkdir', py('from pathlib import Path\nPath("out/a.txt").resolve().parent.mkdir(parents=True, exist_ok=True)\nPath("out/a.txt").write_text("x")')],
    ['py Path(".").glob + p.parent', py('from pathlib import Path\nfor f in Path(".").glob("*.py"):\n    f.parent.mkdir(exist_ok=True)')],
    ['node dirname(__dirname) join', nd('const fs = require("fs"), path = require("path");\nfs.writeFileSync(path.join(path.dirname(__dirname), "a.js"), "x");')],
    ['py getcwd as the base of a project file', py('import os\nopen(os.path.join(os.getcwd(), "src", "m.rs"), "w").write("x")')],
    ['py rglob and join of words', py('from pathlib import Path\nnames = [f.name for f in Path("src").rglob("*.rs")]\nprint(", ".join(names))')],
    ['py decode of a file', py('from pathlib import Path\ntext = Path("src/a.txt").read_bytes().decode("utf-8")\nPath("src/b.txt").write_text(text.upper())')],
    ['node path.join write', nd('const fs = require("fs"), path = require("path");\nfs.writeFileSync(path.join("src", "a.js"), "x");')],
    ['node cwd as the base of a project file', nd('const fs = require("fs"), path = require("path");\nfs.writeFileSync(path.join(process.cwd(), "src", "a.js"), "x");')],
    ['node resolve + regex exec', nd('const fs = require("fs"), path = require("path");\nconst p = path.resolve("src", "a.js");\nconst m = /v(d+)/.exec(fs.readFileSync(p, "utf8"));\nfs.writeFileSync(p, String(m));')],
    ['node -e join', `cd "C:/work/projA" && node -e 'console.log(require("path").join("a","b"))'`],
    ['python -c join', `cd "C:/work/projA" && python -c 'import os;print(os.path.join("a","b"))'`],
    ['python3.12 benign heredoc', `cd "C:/work/projA" && python3.12 - <<'PYEOF'\nfrom pathlib import Path\nPath("src/a.rs").write_text("x")\nPYEOF`],
  ];
  for (const [name, c] of free) for (const h of both(c)) assert.equal(h, 'none', name);
});
