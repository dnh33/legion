import test from 'node:test';
import assert from 'node:assert/strict';
import { isBuildFile } from '../src/shared/build-files.js';

test('build and script files are matched, with either slash', () => {
  for (const p of ['p/package.json', 'C:\\p\\Makefile', 'p/scripts/build.sh', 'p/scripts/a/b.js', 'p/vitest.config.ts', 'p/Cargo.toml', 'p/conftest.py', 'p/sub/package-lock.json', 'p/pnpm-lock.yaml', 'p/pyproject.toml', 'p/.npmrc', 'p/go.mod', 'p/.yarnrc.yml', 'p/.yarnrc', 'p/.pnpmfile.cjs', 'p/bunfig.toml']) assert.equal(isBuildFile(p), true, p);
  for (const p of ['p/src/index.ts', 'p/README.md', 'p/subscripts/a.js', 'p/package.json.bak', 'p/docs/package.md']) assert.equal(isBuildFile(p), false, p);
});

test('Windows spellings of the same file are matched', () => {
  for (const p of ['p/package.json.', 'p/package.json ', 'p/package.json::$DATA', 'p/package.json:stream', 'C:package.json', 'p/scripts./build.js', 'p/scripts/build.js.', 'C:\\p\\package.json.']) assert.equal(isBuildFile(p), true, p);
  for (const p of ['p/src/a.ts.', 'C:src/a.ts', 'p/package.jsonx::$DATA']) assert.equal(isBuildFile(p), false, p);
});

// ---- security fix 1 (C-M2): common build scripts and tool configs are build files too
test('build scripts and tool configs are build files, in any folder, any case, either slash', () => {
  const names = [
    'build.rs', 'p/build.rs', 'build.gradle', 'p/app/build.gradle', 'settings.gradle', 'build.gradle.kts', 'p/app/settings.gradle.kts', 'CMakeLists.txt', 'p/sub/CMakeLists.txt', 'meson.build', 'SConstruct', 'Rakefile',
    'Gemfile', 'noxfile.py', 'justfile', 'Justfile', 'Taskfile.yml', 'Taskfile.yaml', 'deno.json', 'deno.jsonc', '.husky/pre-commit', 'p/.husky/_/husky.sh', 'p\\.husky\\pre-push',
    'vite.config.ts', 'vite.config.js', 'webpack.config.js', 'webpack.config.cjs', 'rollup.config.mjs', 'babel.config.js', 'next.config.js', 'next.config.mjs', 'postcss.config.js', 'tailwind.config.ts', 'eslint.config.js',
    'vitest.config.mts', 'jest.config.cts', 'playwright.config.ts', 'p/apps/web/vite.config.ts', 'astro.config.mjs', 'tsup.config.ts', 'C:\\p\\Vite.Config.TS',
  ];
  for (const p of names) assert.equal(isBuildFile(p), true, p);
});
test('build scripts: Windows spellings still fold, and ordinary files are not build files', () => {
  for (const p of ['p/build.rs.', 'p/vite.config.ts::$DATA', 'C:vite.config.ts', 'p/justfile ', 'p/.husky./pre-commit']) assert.equal(isBuildFile(p), true, p);
  for (const p of ['src/app.ts', 'p/src/app.ts', 'p/src/build.ts', 'p/rs/build.rs.bak', 'p/config.ts', 'p/src/config.js', 'p/vite.config.json', 'p/husky/pre-commit', 'p/docs/justfile.md', 'p/CMakeLists.txt.in', 'p/gradle.properties', 'p/src/rakefile.rb', 'p/Gemfile.md']) {
    assert.equal(isBuildFile(p), false, p);
  }
});
