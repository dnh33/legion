// The words of the web cards and the web lines on the Gates page. Shared by the core (the card summary) and the app (the card).
// Plain words: no em dash, "your computer" and never "this computer".
import type { WebVerdict } from './web-verdict.js';

export type WebAskWhy = Extract<WebVerdict, { kind: 'ask' }>['why'];

export const WEB_CARD = {
  title: (host: string) => `Open ${host}?`,
  body: (host: string, path: string) => `Legion wants to open ${host}${path}. It has not read from this site in this project.`,
  bodyCode: 'This address contains a long code. It may hide your data.',
  buttons: { always: (host: string) => `Always allow ${host}`, goal: 'Allow for this goal', once: 'Allow once', deny: 'Deny' },
  many: (n: number, hosts: string[]) => `${n} new sites: ${hosts.join(', ')}`,
  egressTitle: 'Connector data may leave through the web',
} as const;

/** Why a site that is not new still asks. The first line of a card is the title, the second says what Legion wants, the third says why. */
const WHY: Record<Exclude<WebAskWhy, 'new-host'>, string> = {
  query: 'The address carries a query string. It may hide your data.',
  userinfo: 'The address holds a name and a password. It may hide your data.',
  'odd-path': WEB_CARD.bodyCode,
  http: 'This address is not a secure web address (https).',
  port: 'The address names a port, which is not usual for a web site.',
  ip: 'The address is a number, not a site name.',
  'long-search': 'This search is very long. It may hide your data.',
  budget: 'Legion has read many pages here in this run.',
  'secret-read': 'This run read a file that may hold secrets, so every web call asks.',
};

/** The text of one web card for the clients that show only a summary: the title, then what Legion wants and why it asks. */
export function webCardSummary(a: { why: WebAskWhy; host: string; path: string; search?: string }): string {
  const target = a.search !== undefined ? `Legion wants to search the web for: ${a.search}` : `Legion wants to open ${a.host}${a.path}.`;
  const lines = a.search !== undefined ? ['Search the web?', `${target}`] : [WEB_CARD.title(a.host), a.why === 'new-host' ? WEB_CARD.body(a.host, a.path) : target];
  if (a.why !== 'new-host') lines.push(WHY[a.why]);
  return lines.join('\n');
}

/** Shown once on the first web card, in every mode. */
export const WEB_NOTICE = 'Agents read sites on your list. A new site asks once.';
/** Shown on the Gates page under the presets. */
export const WEB_LINE = 'Agents ask before they read a new website. Sites on your list open without asking.';
/** Shown once in the Smart confirm dialog and on the first-run screen: Smart lets agents run what they write. */
export const CONSENT_LINE = 'Agents will run the code they write, like tests and builds.';
