import type { Room } from '../../../src/shared/comms';
import { Icon } from '../components/icons';
import { useStore } from '../store';
import './rooms.css';
import { RoomComposer } from './RoomComposer';
import { RoomHeader } from './RoomHeader';
import { RoomSettings } from './RoomSettings';
import { loadRoom, resumeRoom, useRooms } from './roomsStore';
import { pauseCopy } from './roomsUtil';
import { Transcript } from './Transcript';

const NONE: never[] = [];

export function RoomPane({ room, narrow, onList }: { room: Room; narrow: boolean; onList: () => void }) {
  const agents = useStore((s) => s.agents);
  const approvals = useStore((s) => s.approvals);
  const live = useRooms((s) => s.live);
  const conn = useRooms((s) => s.conn);
  const messages = useRooms((s) => s.msgs[room.id]) ?? NONE;
  const detail = useRooms((s) => s.detail[room.id]);
  const detailError = useRooms((s) => s.detailError[room.id]) || null;
  const settingsOpen = useRooms((s) => s.settingsOpen);
  const offline = conn === 'offline';
  const copy = pauseCopy(room);
  const loading = detail === 'loading' || detail === undefined || detail === 'idle';

  return (
    <div className="rm-pane">
      <RoomHeader room={room} agents={agents} live={live} offline={offline} narrow={narrow} onList={onList} />
      {offline && <div className="rm-banner offline" role="status"><Icon name="pulse" size={14} /><span>Offline. Reconnecting to Legion core. Bots keep working; this room catches up when the link returns.</span></div>}
      {copy && (
        <div className="rm-banner paused" role="alert">
          <Icon name="shield" size={15} />
          <div className="rm-banner-text">
            <b>{copy.title}</b>
            <span>{copy.body}{room.paused?.detail && room.paused.reason !== 'budget' ? <> {'“'}{room.paused.detail}{'”'}</> : null}</span>
          </div>
          <button type="button" className="btn primary" onClick={() => void resumeRoom(room.id)} disabled={offline}><Icon name="play" size={13} /> Resume</button>
        </div>
      )}
      <Transcript room={room} messages={messages} agents={agents} approvals={approvals} live={live}
        loading={loading && messages.length === 0} error={detail === 'error' ? (detailError ?? 'Request failed') : null} onRetry={() => void loadRoom(room.id, true)} />
      <RoomComposer room={room} agents={agents} offline={offline} />
      {settingsOpen && <RoomSettings room={room} />}
    </div>
  );
}
