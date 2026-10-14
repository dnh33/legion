/**
 * Opens the GitHub area from places that render outside it (agent editor, project page). They send an event and the area's store,
 * started by the app (initGithub), opens itself, so these components never load the store or its window listeners.
 */
export const OPEN_GITHUB_EVENT = 'legion:open-github';
export function openGithubArea(repo?: string): void {
  window.dispatchEvent(new CustomEvent<{ repo?: string }>(OPEN_GITHUB_EVENT, { detail: repo ? { repo } : {} }));
}
