import { useEffect, useState } from 'react';
import type { LegionConfig } from '../../../src/shared/types';
import { api } from '../api';
import { runDoctor, useStore } from '../store';
import { copyText } from '../util';
import { Icon } from './icons';
import { Modal } from './Modal';

export function DoctorModal() {
  const checks = useStore((s) => s.doctor);
  const loading = useStore((s) => s.doctorLoading);
  const [cfg, setCfg] = useState<Partial<LegionConfig> | null>(null);
  useEffect(() => { api.config().then(setCfg).catch(() => setCfg(null)); }, []);
  const boat = useStore((s) => s.boatConfigured);
  const isOptional = (c: { id: string; ok: boolean; detail: string }) => c.id === 'boat' && (!boat || /not configured/i.test(c.detail));
  const bad = checks?.filter((c) => !c.ok && !isOptional(c)).length ?? 0;
  const optional = checks?.filter(isOptional).length ?? 0;
  return (
    <Modal title="Doctor" width={600}
      footer={<><span className="muted-s">{loading ? 'Checking…' : checks ? (bad ? `${bad} ${bad === 1 ? 'needs' : 'need'} attention` : (optional ? 'All required checks passed' : 'All checks passed')) : ''}</span><span className="spacer" /><button className="btn" onClick={() => void runDoctor()} disabled={loading}>Re-run checks</button></>}>
      <ul className="checks">
        {!checks && <li className="check skeleton" />}
        {checks?.map((c) => (
          <li key={c.id} className={`check ${isOptional(c) ? 'opt' : c.ok ? 'ok' : 'bad'}`}>
            <span className="check-ic">{isOptional(c) ? <Icon name="minus" size={12} /> : c.ok ? <Icon name="check" size={12} /> : <Icon name="x" size={12} />}</span>
            <div>
              <b>{c.label}{isOptional(c) && <span className="opt-tag">Optional {'·'} not set up</span>}</b>
              <p>{isOptional(c) ? 'Agent VMs stay off until you add a boat.dev key. Everything else works without it.' : c.detail}</p>
              {(!c.ok || isOptional(c)) && c.fix && <div className="cmd fix"><code>{c.fix}</code><button className="btn-ghost sm" onClick={() => void copyText(c.fix!)}><Icon name="copy" size={12} /> Copy</button></div>}
            </div>
          </li>
        ))}
      </ul>
      <details className="cfg">
        <summary>Config (read-only)</summary>
        <p className="muted-s">Edit <code>~/.legion/config.json</code> (Windows: <code>%USERPROFILE%\.legion\config.json</code>) and restart the core. Secrets are redacted here.</p>
        <pre>{cfg ? JSON.stringify(cfg, null, 2) : 'Loading…'}</pre>
      </details>
    </Modal>
  );
}
