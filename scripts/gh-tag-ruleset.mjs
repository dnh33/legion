#!/usr/bin/env node
// The v* tag protection ruleset: after this is applied, only a repository admin (the owner) may create, update or delete a
// tag whose name matches refs/tags/v*. Everyone else is refused, so a release tag cannot be moved or forged.
//
// This is an OWNER-ONLY, one-time step. It needs an authenticated `gh` with admin rights on the repository, so it never
// runs in CI and carries no secret of its own. Applying it is deliberately manual (docs/SHIPPING.md).
//
// usage:
//   node scripts/gh-tag-ruleset.mjs                 # print the ruleset JSON and how to apply it (no network)
//   node scripts/gh-tag-ruleset.mjs --apply         # create it on GitHub (or update it if the name already exists)
//   node scripts/gh-tag-ruleset.mjs --repo owner/name --name "custom name"
//
// The REST body follows the official schema for POST /repos/{owner}/{repo}/rulesets (target: tag; rules: creation, update,
// deletion; bypass_actors actor_type RepositoryRole). RepositoryRole id 5 is the repository admin role.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPO = 'dnh33/legion';
export const DEFAULT_NAME = 'v* release tags: owner only';

/** The ruleset body for POST/PUT /repos/{owner}/{repo}/rulesets. */
export function tagRuleset(name = DEFAULT_NAME) {
  return {
    name,
    target: 'tag',
    enforcement: 'active',
    // The only actor that may bypass: the repository admin role (base repository role id 5), i.e. the owner on a personal
    // repository. With no other bypass actor, creation/update/deletion of a v* tag is refused for everyone else.
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }],
  };
}

/** The argv for `gh` that creates (existingId undefined) or updates the ruleset from a JSON file. */
export function ghApplyArgs(repo, jsonFile, existingId) {
  return existingId === undefined
    ? ['api', '--method', 'POST', `repos/${repo}/rulesets`, '--input', jsonFile]
    : ['api', '--method', 'PUT', `repos/${repo}/rulesets/${existingId}`, '--input', jsonFile];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  let apply = false;
  let repo = DEFAULT_REPO;
  let name = DEFAULT_NAME;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--print') apply = false;
    else if (a === '--repo') { repo = argv[++i]; if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) { console.error('unknown or malformed --repo (expected owner/name)'); process.exit(2); } }
    else if (a === '--name') { name = argv[++i]; if (!name) { console.error('--name needs a value'); process.exit(2); } }
    else { console.error(`unknown option ${a}`); process.exit(2); }
  }
  const json = JSON.stringify(tagRuleset(name), null, 2) + '\n';
  if (!apply) {
    process.stdout.write(json);
    process.stderr.write(
      `\nApply it (owner only, needs gh auth with admin on ${repo}):\n`
      + `  node scripts/gh-tag-ruleset.mjs --apply --repo ${repo}\n`
      + `or with gh directly:\n`
      + `  node scripts/gh-tag-ruleset.mjs --repo ${repo} > ruleset.json\n`
      + `  gh api --method POST repos/${repo}/rulesets --input ruleset.json\n`);
    process.exit(0);
  }
  const gh = process.env.LEGION_GH || 'gh';
  const dir = mkdtempSync(join(tmpdir(), 'legion-ruleset-'));
  const file = join(dir, 'ruleset.json');
  writeFileSync(file, json);
  try {
    const list = JSON.parse(execFileSync(gh, ['api', `repos/${repo}/rulesets`], { encoding: 'utf8' }));
    const existing = (Array.isArray(list) ? list : []).find((r) => r && r.name === name);
    const out = execFileSync(gh, ghApplyArgs(repo, file, existing ? existing.id : undefined), { encoding: 'utf8' });
    process.stdout.write(out);
    process.stderr.write(`\n${existing ? 'updated' : 'created'} ruleset "${name}" on ${repo}.\n`);
  } catch (e) {
    console.error(`gh api failed: ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
