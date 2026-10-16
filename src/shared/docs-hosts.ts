// Built-in docs hosts: web reads on these hosts are trusted without asking.
// A typed const, not JSON: JSON under src/shared is not copied to dist. It ships inside app.zip, which the signed manifest covers.
// Only documentation sites and package registries. Never a host that serves what any user uploads (gists, pastebins,
// raw.githubusercontent.com, *.github.io, *.vercel.app, *.pages.dev, notion.site, huggingface.co, shorteners): test/docs-hosts.test.ts enforces it.
export const DOCS_HOSTS: readonly string[] = [
  'developer.mozilla.org',
  'docs.python.org',
  'pypi.org',
  'docs.github.com',
  'docs.stripe.com',
  'learn.microsoft.com',
  'nodejs.org',
  'docs.npmjs.com',
  'www.npmjs.com',
  'www.typescriptlang.org',
  'react.dev',
  'nextjs.org',
  'vuejs.org',
  'svelte.dev',
  'vite.dev',
  'tailwindcss.com',
  'www.electronjs.org',
  'doc.rust-lang.org',
  'docs.rs',
  'crates.io',
  'go.dev',
  'pkg.go.dev',
  'docs.docker.com',
  'kubernetes.io',
  'git-scm.com',
  'www.postgresql.org',
  'www.sqlite.org',
];

// The set of trusted docs hosts. Tests pass their own list.
export function loadDocsHosts(list: readonly string[] = DOCS_HOSTS): ReadonlySet<string> {
  return new Set(list.map((h) => h.toLowerCase().replace(/\.$/, '')));
}
