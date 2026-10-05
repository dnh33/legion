import { platform } from '../api';
import { BlenderChip } from '../blender/BlenderChip';
import { BsvChip } from '../bsv/BsvChip';
import { RelicGlyph } from '../mascot/Relic';
import { useL } from '../library/libraryStore';
import { isUnread, useRooms } from '../rooms/roomsStore';
import { VIEW_KEY_LABELS } from '../viewKeys';
import { openDoctor, openPalette, setView, toggleOps, toggleSettings, toggleTheme, useStore } from '../store';
import { Icon } from './icons';
import { UsageButton } from './UsagePopover';

/** Icon-only view tabs keep the title bar the width v4 shipped (the search box does not move). */
function ViewGlyph({ v }: { v: 'chat' | 'rooms' | 'graph' }) {
  const p = { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
  if (v === 'chat') return <svg {...p}><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></svg>;
  if (v === 'rooms') return <svg {...p}><circle cx="5.5" cy="6" r="2" /><circle cx="11" cy="6.5" r="1.6" /><path d="M2 12.5c.4-2 1.9-3 3.5-3s3.1 1 3.5 3M9.8 10c1.6-.3 3.4.4 4.2 2.5" /></svg>;
  return <svg {...p}><circle cx="4" cy="4" r="1.6" /><circle cx="12" cy="5" r="1.6" /><circle cx="8" cy="12" r="1.6" /><path d="M5.4 4.4l5 .4M4.8 5.4l2.4 5.2M11.2 6.4L8.8 10.6" /></svg>;
}

export function TitleBar() {
  const conn = useStore((s) => s.conn);
  const theme = useStore((s) => s.theme);
  const opsOpen = useStore((s) => s.opsOpen);
  const doctor = useStore((s) => s.doctor);
  const version = useStore((s) => s.version);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const view = useStore((s) => s.view);
  const pending = useL((s) => s.inbox?.length ?? 0);
  const roomAttn = useRooms((s) => s.rooms.filter((r) => r.paused || isUnread(s, r)).length);
  const bad = doctor ? doctor.filter((c) => !c.ok).length : 0;
  const connLabel = conn === 'online' ? 'Connected' : conn === 'connecting' ? 'Connecting…' : 'Offline — retrying';
  const padRight = platform === 'darwin' || platform === 'linux' ? 16 : 140;
  const padLeft = platform === 'darwin' ? 84 : 14;
  return (
    <header className="titlebar" style={{ paddingRight: padRight, paddingLeft: padLeft }}>
      <div className="tb-brand">
        <RelicGlyph size={22} />
        <span className="tb-word">
          <span className="tb-name">Legion</span>
          {version && <span className="tb-ver">v{version}</span>}
          <span className="tb-beta nodrag" title="Legion is in beta. Expect rough edges and the odd bug.">Beta</span>
        </span>
      </div>
      <button className="tb-search nodrag" onClick={openPalette} aria-label="Open command palette">
        <Icon name="search" size={14} /> <span>Search or run a command</span> <kbd>Ctrl K</kbd>
      </button>
      <div className="tb-right nodrag">
        <div className="tb-views nodrag" role="tablist" aria-label="View">
          {(['chat', 'rooms', 'graph'] as const).map((v) => {
            const label = v === 'chat' ? 'Chat' : v === 'rooms' ? 'Rooms' : pending > 0 ? `Library, ${pending} waiting for review` : 'Library';
            return (
              <button key={v} role="tab" aria-selected={view === v} aria-label={label} className={`tb-view${view === v ? ' on' : ''}`} onClick={() => setView(v)} title={`${label} · ${VIEW_KEY_LABELS[v]}`} aria-keyshortcuts={VIEW_KEY_LABELS[v]}>
                <ViewGlyph v={v} />
                {v === 'rooms' && view !== 'rooms' && roomAttn > 0 && <i className="tb-badge" aria-label={`${roomAttn} rooms need attention`}>{roomAttn}</i>}
                {v === 'graph' && pending > 0 && <i className="tb-badge" aria-hidden="true">{pending > 99 ? '99+' : pending}</i>}
              </button>
            );
          })}
        </div>
        <span className={`conn conn-${conn}`} title={connLabel}><i className="conn-dot" /> <span className="conn-label">{connLabel}</span></span>
        <BsvChip />
        <BlenderChip />
        <UsageButton />
        <button className={`tb-doctor${bad ? ' bad' : doctor ? ' good' : ''}`} onClick={openDoctor} title={bad ? `${bad} setup check${bad === 1 ? '' : 's'} failing. Open Doctor` : doctor ? 'All required checks pass. Open Doctor' : 'Sign-in & setup checks'}>
          <Icon name="pulse" size={14} /> Doctor{bad > 0 && <b>{bad} to fix</b>}
        </button>
        <button className={`icon-btn${settingsOpen ? ' on' : ''}`} onClick={toggleSettings} aria-label="Settings" title="Settings (Ctrl ,)"><Icon name="gear" /></button>
        <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
        <button className={`icon-btn${opsOpen ? ' on' : ''}`} onClick={toggleOps} aria-label="Toggle Ops panel" title="Ops panel (Ctrl .)"><Icon name="sidebar" /></button>
      </div>
    </header>
  );
}
