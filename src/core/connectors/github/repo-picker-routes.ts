/** Owner-only "choose repos" routes. Not on the client route list, so only the admin secret reaches them. */
import { createRepoPicker, type RepoPickerDeps } from './repo-picker.js';
import type { RouteAdder } from '../../modules.js';

export function addRepoPickerRoutes(add: RouteAdder, deps: RepoPickerDeps): void {
  const picker = createRepoPicker(deps);
  add('GET', '/api/github/apps/:app/repos', ({ params, url }) => picker.list(params[0], url.searchParams.get('q') ?? ''));
  add('PUT', '/api/github/apps/:app/repos/:repoId', ({ params }) => picker.add(params[0], params[1]));
  add('DELETE', '/api/github/apps/:app/repos/:repoId', ({ params }) => picker.remove(params[0], params[1]));
}
