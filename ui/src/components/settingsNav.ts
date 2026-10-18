export type SettingsSection = 'claude' | 'gates' | 'accessibility' | 'notifications' | 'spending' | 'providers' | 'boat' | 'mcp' | 'blender' | 'compaction' | 'house' | 'armory' | 'github' | 'connections' | 'logs' | 'about';

export interface NavItem { id: SettingsSection; label: string; hint: string }
export interface NavGroup { heading: string | null; ids: SettingsSection[] }

// Order comes from judged frequency of use, then grouped by purpose. The last group has no heading.
export const NAV_GROUPS: NavGroup[] = [
  { heading: 'Get started', ids: ['claude'] },
  { heading: 'Your agents', ids: ['gates', 'armory', 'house'] },
  { heading: 'Staying informed', ids: ['spending', 'notifications'] },
  { heading: 'Connections', ids: ['mcp', 'github', 'providers', 'connections', 'boat', 'blender'] },
  { heading: 'Advanced', ids: ['accessibility', 'logs', 'compaction'] },
  { heading: null, ids: ['about'] },
];

const ITEMS: Record<SettingsSection, Omit<NavItem, 'id'>> = {
  claude: { label: 'Claude', hint: 'Sign-in, key, runs' },
  gates: { label: 'Gates', hint: 'When agents need your OK' },
  armory: { label: 'Armory', hint: 'Skills your agents can pick up' },
  house: { label: 'Doctrine', hint: 'Rules and drills your agents follow' },
  spending: { label: 'Spending', hint: 'What your agents cost' },
  notifications: { label: 'Notifications', hint: 'Pop-ups, sounds, quiet hours' },
  mcp: { label: 'MCP servers', hint: 'Extra tools for agents' },
  github: { label: 'GitHub', hint: 'Connector: read repos and CI' },
  providers: { label: 'Providers', hint: 'Other models, optional' },
  connections: { label: 'Use from Claude', hint: 'Drive Legion from Claude Code' },
  boat: { label: 'boat.dev (VMs)', hint: 'Cloud computers' },
  blender: { label: 'Blender', hint: 'Build 3D with the Sculptor' },
  accessibility: { label: 'Accessibility', hint: 'Focus rings for the keyboard' },
  logs: { label: 'Logs', hint: 'What Legion did, on your computer' },
  compaction: { label: 'Compaction', hint: 'Context limits for long runs' },
  about: { label: 'About', hint: 'Version and folders' },
};

/** What an empty Settings page says when the core did not answer: the part that cannot load, then the way back (the same next step as every other offline line). */
export const settingsUnreachableLine = (section: SettingsSection, nextStep: string): string =>
  `Legion core is not reachable, so ${section === 'gates' ? 'Gates' : 'this page'} cannot load. ${nextStep}`;

export const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.ids.map((id) => ({ id, ...ITEMS[id] })));

/** The visible items, regrouped in order; a group with nothing left is dropped. */
export function groupNav(items: NavItem[]): { heading: string | null; items: NavItem[] }[] {
  return NAV_GROUPS
    .map((g) => ({ heading: g.heading, items: g.ids.map((id) => items.find((n) => n.id === id)).filter((n): n is NavItem => !!n) }))
    .filter((g) => g.items.length > 0);
}
