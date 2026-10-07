/**
 * The class of every connector tool (design 4.1 "Classification"). The table ships with Legion. A tool that is not in it is WRITE:
 * a name the model made up, a tool of a newer server, or a typo can never be treated as a harmless read. Server annotations
 * (`readOnlyHint` and friends) are a UI hint only and never lower a class. The gateway checks the class at call time.
 *
 * READ: no card. WRITE: a card, always (raised inside the handler). SPEND: a card with a price and the spend caps (slice 1c).
 * The GitHub write names are listed here already so that they classify as WRITE; slice 1b has no handler for any of them.
 */
export type ToolClass = 'READ' | 'WRITE' | 'SPEND';

export const SHIPPED_CLASSES: Readonly<Record<string, Readonly<Record<string, ToolClass>>>> = {
  github: {
    github_status: 'READ',
    github_repo_list: 'READ',
    github_repo_get: 'READ',
    github_issue_list: 'READ',
    github_issue_get: 'READ',
    github_issue_comments: 'READ',
    github_pr_list: 'READ',
    github_pr_get: 'READ',
    github_pr_files: 'READ',
    github_file_get: 'READ',
    github_dir_list: 'READ',
    github_ci_runs: 'READ',
    github_ci_run: 'READ',
    github_ci_wait: 'READ',
    // writes: slice 2 (carded). Listed so they classify as WRITE and never as READ.
    github_issue_write: 'WRITE',
    github_comment: 'WRITE',
    github_create_pr: 'WRITE',
    github_review: 'WRITE',
    github_ci_rerun: 'WRITE',
    github_ci_cancel: 'WRITE',
  },
};

/** The class of a tool. Anything that is not in the shipped table (any connector, any name) is WRITE. */
export function classOf(connector: string, tool: string): ToolClass {
  const t = Object.hasOwn(SHIPPED_CLASSES, connector) ? SHIPPED_CLASSES[connector]! : undefined;
  return t && Object.hasOwn(t, tool) ? t[tool]! : 'WRITE';
}

/** Connector ids and tool names must match this, else the entry is wrapped and the run is tainted. */
export const SAFE_NAME = /^[a-z0-9_-]{1,64}$/;
