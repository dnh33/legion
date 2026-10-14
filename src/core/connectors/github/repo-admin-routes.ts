/** Owner-only repo create routes (design 6.4). Not on the client route list, so only the admin secret reaches them. */
import { getGitHubClient } from './client.js';
import { createRepoAdmin, type RepoAdminDeps } from './repo-admin.js';
import type { RouteAdder } from '../../modules.js';

export function addRepoAdminRoutes(add: RouteAdder, deps: { dataDir: string; client?: RepoAdminDeps['client'] }): void {
  const admin = createRepoAdmin({ dataDir: deps.dataDir, client: deps.client ?? ((k) => getGitHubClient(k)) });
  add('POST', '/api/github/repos', ({ body }) => admin.create(body));
  add('GET', '/api/github/orgs', () => admin.orgs());
}
