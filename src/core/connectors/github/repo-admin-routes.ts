/** Owner-only repo create routes (design 6.4). Not on the client route list, so only the admin secret reaches them. */
import { getGitHubClient } from './client.js';
import { createRepoAdmin, type RepoAdminDeps } from './repo-admin.js';
import type { RouteAdder } from '../../modules.js';

export function addRepoAdminRoutes(add: RouteAdder, deps: { dataDir: string; client?: RepoAdminDeps['client']; area?: { invalidate(): void } }): void {
  const admin = createRepoAdmin({ dataDir: deps.dataDir, client: deps.client ?? ((k) => getGitHubClient(k)) });
  add('POST', '/api/github/repos', async ({ body }) => {
    const r = await admin.create(body);
    if (r.phase === 'done') deps.area?.invalidate(); // the new repo shows in the area list without waiting for the cache
    return r;
  });
  add('GET', '/api/github/orgs', () => admin.orgs());
}
