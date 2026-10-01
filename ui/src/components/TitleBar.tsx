import { platform } from '../api';
import { BsvChip } from '../bsv/BsvChip';
import { RelicGlyph } from '../mascot/Relic';
import { isUnread, useRooms } from '../rooms/roomsStore';
import { openDoctor, openPalette, setView, toggleOps, toggleTheme, useStore } from '../store';
import { Icon } from './icons';

export function TitleBar() {
  const conn = useStore((s) => s.conn);
  const theme = useStore((s) => s.theme);
  const opsOpen = useStore((s) => s.opsOpen);
  const doctor = useStore((s) => s.doctor);
  const version = useStore((s) => s.version);
  const view = useStore((s) => s.view);
  const roomAttn = useRooms((s) => s.rooms.filter((r) => r.paused || isUnread(s, r)).length);
  const bad = doctor ? doctor.filter((c) => !c.ok).length : 0;
  const connLabel = conn === 'online' ? 'Connected' : conn === 'connecting' ? 'Connecting…' : 'Offline — retrying';
  const padRight = platform === 'darwin' || platform === 'linux' ? 16 : 140;
  const padLeft = platform === 'darwin' ? 84 : 14;
  return (
    <header className="titlebar" style={{ paddingRight: padRight, paddingLeft: padLeft }}>
      <div className="tb-brand">
        <RelicGlyph size={22} />
        <span className="tb-name">Legion</span>
        {version && <span className="tb-ver">v{version}</span>}
      </div>
      <button className="tb-search nodrag" onClick={openPalette} aria-label="Open command palette">
        <Icon name="search" size={14} /> <span>Search or run a command</span> <kbd>Ctrl K</kbd>
      </button>
      <div className="tb-right nodrag">
        <div className="tb-views nodrag" role="tablist" aria-label="View">
          {(['chat', 'rooms', 'graph'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={`tb-view${view === v ? ' on' : ''}`} onClick={() => setView(v)}>
              {v === 'chat' ? 'Chat' : v === 'rooms' ? 'Rooms' : 'Lattice'}
            {v === 'rooms' && view !== 'rooms' && roomAttn > 0 && <i className="tb-badge" aria-label={`${roomAttn} rooms need attention`}>{roomAttn}</i>}
            </button>
          ))}
        </div>
        <span className={`conn conn-${conn}`} title={connLabel}><i className="conn-dot" /> <span className="conn-label">{connLabel}</span></span>
        <BsvChip />
        <button className={`tb-doctor${bad ? ' bad' : ''}`} onClick={openDoctor} title={bad ? `${bad} setup check${bad === 1 ? '' : 's'} failing. Open Doctor` : 'Sign-in & setup checks'}>
          <Icon name="pulse" size={14} /> Doctor{bad > 0 && <b>{bad} to fix</b>}
        </button>
        <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
        <button className={`icon-btn${opsOpen ? ' on' : ''}`} onClick={toggleOps} aria-label="Toggle Ops panel" title="Ops panel (Ctrl .)"><Icon name="sidebar" /></button>
      </div>
    </header>
  );
}
