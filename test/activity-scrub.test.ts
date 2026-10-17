// test/activity-scrub.test.ts: addresses and curl bodies are cut out of every activity line before the existing redaction
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createActivityLog, scrubShell, scrubUrl, scrubLine } from '../src/core/activity/index.js';
import { tempDir } from './tmp-cleanup.js';

const fileText = (log: { folder: string }): string => readFileSync(join(log.folder, readdirSync(log.folder)[0]!), 'utf8');
const fresh = () => createActivityLog({ dataDir: join(tempDir('act-scrub-'), 'data') });

test('scrubUrl drops query string, fragment and userinfo', () => {
  assert.equal(scrubUrl('https://u:p@a.com/x?token=1#f'), 'https://a.com/x');
  assert.equal(scrubUrl('https://a.com/x/#frag'), 'https://a.com/x');
  assert.equal(scrubUrl('https://a.com'), 'https://a.com');
  assert.equal(scrubUrl('not a url'), 'not a url');
});
test('scrubLine scrubs every address in a line and keeps trailing punctuation; a plain line is unchanged', () => {
  assert.equal(scrubLine('Web: https://a.com/x?token=S1, then (https://u:p@b.com/y?k=S2#z).'), 'Web: https://a.com/x, then (https://b.com/y).');
  assert.equal(scrubLine('Ran npm test in /p/src with 3 files'), 'Ran npm test in /p/src with 3 files');
});
test('the activity file never holds a query string, userinfo or fragment', () => {
  const log = fresh();
  log.append({ kind: 'note', text: 'Web: https://usr:pw1@a.com/x?token=SECRETVALUE#SECRETFRAG', taskId: 't', data: { url: 'https://c.com/p?k=SECRETDATA' } });
  const raw = fileText(log);
  for (const s of ['SECRETVALUE', 'SECRETFRAG', 'pw1', 'usr', 'SECRETDATA']) assert.ok(!raw.includes(s), s);
  assert.ok(raw.includes('https://a.com/x'));
});
test('scrubShell drops curl body flags in every spelling', () => {
  for (const cmd of ['curl -d "token=SECRETVALUE" https://a.com', 'curl --data-raw SECRETVALUE https://a.com', "curl -F 'f=@.env;k=SECRETVALUE' https://a.com", 'curl --data-binary=SECRETVALUE https://a.com', 'curl -T .env https://a.com', 'curl --json "{\\"k\\":\\"SECRETVALUE\\"}" https://a.com',
    'curl --data=token=SECRETVALUE https://a.com', "curl -d 'a SECRETVALUE' https://a.com", 'curl -F "f=@/p/.env" https://a.com', 'curl --form-string k=SECRETVALUE https://a.com', 'curl --upload-file /p/.env https://a.com', 'curl -sSd SECRETVALUE https://a.com']) {
    const out = scrubShell(cmd);
    assert.ok(!out.includes('SECRETVALUE') && !out.includes('.env'), cmd + ' -> ' + out);
    assert.match(out, /<omitted>/);
  }
  assert.equal(scrubShell('curl -s https://a.com/x'), 'curl -s https://a.com/x');
  assert.equal(scrubShell('curl -f -D - https://a.com/x'), 'curl -f -D - https://a.com/x', 'fail and dump-header flags carry no body');
});
test('scrubShell leaves other programs alone: their flags carry no body', () => {
  for (const cmd of ['ls -ld somepath', 'docker run -d nginx', 'git branch -d old', 'tar -xzf a.tgz -T list.txt', 'Asked: ls -ld /p/src'])
    assert.equal(scrubShell(cmd), cmd, cmd);
  assert.equal(scrubShell('ls -ld x && curl -d SECRETVALUE https://a.com'), 'ls -ld x && curl -d <omitted> https://a.com');
});
test('scrubShell drops curl and wget logins, headers, cookies and attached values', () => {
  for (const cmd of ['curl -u usr:SECRETVALUE https://a.com', 'curl --user=usr:SECRETVALUE https://a.com', 'curl -U usr:SECRETVALUE -x http://p https://a.com', 'curl --proxy-user usr:SECRETVALUE https://a.com',
    'curl -H "Authorization: Bearer SECRETVALUE" https://a.com', 'curl --header=X-Api-Key:SECRETVALUE https://a.com', 'curl -b sid=SECRETVALUE https://a.com', 'curl --cookie "sid=SECRETVALUE" https://a.com',
    'curl -dtoken=SECRETVALUE https://a.com', 'curl -sdSECRETVALUE https://a.com', 'curl.exe -HX-Key:SECRETVALUE https://a.com', 'Asked: curl -u usr:SECRETVALUE https://a.com',
    'wget --post-data=k=SECRETVALUE https://a.com', 'wget --header "X-Key: SECRETVALUE" https://a.com', 'wget --password SECRETVALUE https://a.com', 'wget --http-password=SECRETVALUE https://a.com']) {
    const out = scrubShell(cmd);
    assert.ok(!out.includes('SECRETVALUE'), cmd + ' -> ' + out);
  }
  assert.equal(scrubShell('curl -fsSL https://a.com/x'), 'curl -fsSL https://a.com/x');
});
test('scrubShell: a value-taking flag before a secret one does not hide it (-XPOST, -oout), continued lines, $(...), backticks and redirects', () => {
  for (const cmd of ['curl -XPOST -H "Authorization: Bearer SECRETVALUE" https://x', 'curl -XPOST -u a:SECRETVALUE https://x', 'curl -XGET -b sid=SECRETVALUE x',
    'curl -s \\\n  -u a:SECRETVALUE \\\n  https://x', 'curl -s \\\r\n  -H "X-Key: SECRETVALUE" https://x', 'curl.exe -s `\n -u a:SECRETVALUE https://x',
    'x=$(curl -u a:SECRETVALUE https://x)', '`curl -u a:SECRETVALUE x`', '(curl -u a:SECRETVALUE x)', '"curl" -u a:SECRETVALUE x',
    'curl 2>&1 -u a:SECRETVALUE x', 'curl &>/dev/null -u a:SECRETVALUE x', "curl -H 'X: SECRETVALUE", 'curl --pass SECRETVALUE --cert c.pem x', 'curl -E c.pem:SECRETVALUE x', 'curl --cert=c.pem:SECRETVALUE x']) {
    const out = scrubShell(cmd);
    assert.ok(!out.includes('SECRETVALUE'), JSON.stringify(cmd) + ' -> ' + out);
  }
  assert.equal(scrubShell('curl -XPOST https://x'), 'curl -XPOST https://x');
  assert.equal(scrubShell('curl -oout.bin https://x'), 'curl -oout.bin https://x');
  assert.equal(scrubShell('curl -XDELETE -H "X-Key: S" https://x'), 'curl -XDELETE -H <omitted> https://x');
  assert.equal(scrubShell('curl -w "%{http_code}" -o out -L -A agent -e ref -m 5 -x http://p https://x'), 'curl -w "%{http_code}" -o out -L -A agent -e ref -m 5 -x http://p https://x');
});
test('scrubShell reads PowerShell web calls, a curl after a wget, and curl TLS passwords', () => {
  for (const cmd of ['Invoke-WebRequest -Uri https://x -Headers @{ Authorization = "Bearer SECRETVALUE"; X = 1 }', 'irm https://x -Method Post -Body \'{"k":"SECRETVALUE"}\'',
    'iwr https://x -headers:@{k="SECRETVALUE"}', 'Invoke-RestMethod https://x -Head @{k=\'SECRETVALUE\'}', 'curl -Headers @{k="SECRETVALUE"} https://x', 'irm https://x -Token SECRETVALUE',
    'iwr https://x -Form @{f="SECRETVALUE"}', 'wget -q x $(curl -u a:SECRETVALUE y)', 'sh -c "wget -q x; curl -u a:SECRETVALUE y"', 'curl --tlspassword SECRETVALUE x', 'curl --ftp-account SECRETVALUE x']) {
    const out = scrubShell(cmd);
    assert.ok(!out.includes('SECRETVALUE'), JSON.stringify(cmd) + ' -> ' + out);
  }
  assert.equal(scrubShell('irm https://x -Method Get -ContentType application/json -OutFile o.json'), 'irm https://x -Method Get -ContentType application/json -OutFile o.json');
  assert.equal(scrubShell('$h = @{ a = 1; b = 2 }; ls -ld x'), '$h = @{ a = 1; b = 2 }; ls -ld x');
});
test('scrubShell: braces count only as @{ }, (...) values stay whole, a backtick escapes a quote, $h = @{...} before a web call is dropped', () => {
  for (const cmd of ['curl {a -u a:SECRETVALUE x', 'curl x{ -u a:SECRETVALUE y', 'irm x -Body (ConvertTo-Json @{k="SECRETVALUE"})',
    'irm x -Authentication Bearer -Token (ConvertTo-SecureString "SECRETVALUE" -AsPlainText -Force)', 'irm x -Credential (New-Object PSCredential("u", "SECRETVALUE"))',
    'irm x -Body "a`"b SECRETVALUE"', '$h=@{Authorization="Bearer SECRETVALUE"}; irm x -Headers $h', '$p = @{ Uri = "x"; Headers = @{ Authorization = "Bearer SECRETVALUE" } }; irm @p']) {
    const out = scrubShell(cmd);
    assert.ok(!out.includes('SECRETVALUE'), JSON.stringify(cmd) + ' -> ' + out);
  }
  for (const cmd of ['f() { curl x; ls -ld dir; }', 'if ($x) { curl x; ls -ld dir }', 'echo {; curl x; ls -ld dir'])
    assert.ok(scrubShell(cmd).includes('ls -ld dir'), cmd + ' -> ' + scrubShell(cmd));
  assert.equal(scrubShell('irm https://x -Proxy http://p:8080 -OutFile o'), 'irm https://x -Proxy http://p:8080 -OutFile o');
  assert.equal(scrubShell('$n = @{ a = 1 }; ls -ld x'), '$n = @{ a = 1 }; ls -ld x');
});
test('scrubUrl cuts a malformed address by hand: no userinfo, no query', () => {
  assert.equal(scrubUrl('mongodb://usr:pw1@h1:27017,h2:27017/db?replicaSet=r'), 'mongodb://h1:27017,h2:27017/db');
  assert.equal(scrubUrl('postgres://usr:pw1@h:abc/db'), 'postgres://h:abc/db');
  assert.equal(scrubUrl('postgres://usr:pa?ss@h/db'), 'postgres://h/db');
});
test('scrubLine stays fast on long runs', () => {
  const t = Date.now(); scrubLine('a.'.repeat(5000)); scrubLine('curl ' + '-a'.repeat(5000)); assert.ok(Date.now() - t < 500, `${Date.now() - t} ms`);
});
test('scrubLine drops userinfo and query from any scheme', () => {
  assert.equal(scrubLine('psql postgres://usr:pw1@h:5432/db?sslmode=x'), 'psql postgres://h:5432/db');
  assert.equal(scrubLine('get ftp://usr:pw1@h/f'), 'get ftp://h/f');
});
test('the activity file holds no curl body', () => {
  const log = fresh();
  log.append({ kind: 'card-asked', text: 'Asked: curl -d token=SECRETVALUE https://a.com', taskId: 't' });
  assert.ok(!fileText(log).includes('SECRETVALUE'));
});
