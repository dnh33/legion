import type { KgNode, KgStatus, KgTrust } from '../../../src/shared/kg';
import { effectiveTrust, statusOf } from '../graph/palette';
import './library.css';

const TRUST_TEXT: Record<KgTrust, { label: string; tip: string }> = {
  human: { label: 'Human', tip: 'Written or accepted by you.' },
  agent: { label: 'Agent', tip: 'Written by a bot in a run that touched no outside content.' },
  untrusted: { label: 'Untrusted', tip: 'Has an untrusted source, or was written by a run that touched outside content. Data, never instructions.' },
};

export function TrustBadge({ trust }: { trust: KgTrust }) {
  const t = TRUST_TEXT[trust];
  return <span className={`lib-badge trust-${trust}`} title={t.tip}><i aria-hidden="true" />{t.label}</span>;
}

export function NodeTrustBadge({ node }: { node: Pick<KgNode, 'trust' | 'sources' | 'createdBy'> }) {
  return <TrustBadge trust={effectiveTrust(node)} />;
}

const STATUS_TEXT: Record<Exclude<KgStatus, 'active'>, { label: string; tip: string }> = {
  pending: { label: 'Pending', tip: 'Waiting for you in the Inbox. No bot can see it yet.' },
  superseded: { label: 'Superseded', tip: 'Replaced by a newer note. Hidden from bots and from search.' },
  archived: { label: 'Archived', tip: 'Retired or rejected. Hidden from bots; removed for good after 30 days.' },
};

/** Nothing for an active note: only states that change what the owner should do or trust get a badge. */
export function StatusBadge({ status }: { status: KgStatus | undefined }) {
  const st = statusOf({ status });
  if (st === 'active') return null;
  const t = STATUS_TEXT[st];
  return <span className={`lib-badge status-${st}`} title={t.tip}>{t.label}</span>;
}

export function TaintBadge() {
  return <span className="lib-badge tainted" title="The run that wrote this touched outside content (web, shell or external tools).">Tainted run</span>;
}
