import { Modal } from '../components/Modal';
import { cancelEnableBlender, confirmEnableBlender, useBlender } from './blenderStore';
import { ENABLE_CONFIRM, ENABLE_TEXT, ENABLE_TITLE } from './enableCopy';
import './blender.css';

/** "Turn on Blender?" Cancel is the default button; Escape, the X and a click outside cancel. Mounted once in App. */
export function EnableBlenderDialog() {
  const open = useBlender((s) => s.confirmOpen);
  if (!open) return null;
  return (
    <Modal
      title={ENABLE_TITLE} width={520} onClose={cancelEnableBlender}
      footer={<>
        <span style={{ flex: 1 }} />
        <button className="btn-ghost" data-autofocus onClick={cancelEnableBlender}>Cancel</button>
        <button className="btn primary" onClick={confirmEnableBlender}>{ENABLE_CONFIRM}</button>
      </>}
    >
      <p className="bl-enable-text">{ENABLE_TEXT}</p>
    </Modal>
  );
}
