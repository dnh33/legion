import { Icon } from '../components/icons';
import { bannerModel } from './coreRestartText';
import { dismissCoreNotice, restartCoreFromBanner, useCoreRestart } from './coreRestartStore';

/** Above the views: the one notice after Legion restarted its core, or the stopped banner with a Restart core button. */
export function CoreRestartBanner() {
  const restarted = useCoreRestart((s) => s.restarted);
  const stopped = useCoreRestart((s) => s.stopped);
  const dismissed = useCoreRestart((s) => s.dismissed);
  const busy = useCoreRestart((s) => s.busy);
  const error = useCoreRestart((s) => s.error);
  const m = bannerModel({ restarted, stopped, dismissed, busy, error });
  if (!m) return null;
  return (
    <div className={`core-note ${m.tone}`} role={m.role}>
      <Icon name={m.tone === 'stop' ? 'warn' : 'pulse'} size={14} />
      <span>{m.text}</span>
      <button type="button" className={m.action === 'restart' ? 'btn sm' : 'btn-ghost sm'} disabled={m.actionDisabled} onClick={() => (m.action === 'restart' ? void restartCoreFromBanner() : dismissCoreNotice())}>{m.actionLabel}</button>
    </div>
  );
}
