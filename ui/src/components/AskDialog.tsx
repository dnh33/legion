import { Modal } from './Modal';
import { answerAsk, useAsk } from './askStore';

/** The app's yes/no question (askStore.ts), in the app's Modal. Esc, a click outside and Close all answer No; focus starts on the No button. */
export function AskDialog() {
  const q = useAsk();
  if (!q) return null;
  return (
    <Modal key={q.id} title={q.title} width={460} onClose={() => answerAsk(q.id, false)}
      footer={<>
        <span className="spacer" />
        <button type="button" className="btn-ghost" data-autofocus onClick={() => answerAsk(q.id, false)}>{q.no}</button>
        <button type="button" className={q.danger ? 'btn danger' : 'btn'} onClick={() => answerAsk(q.id, true)}>{q.yes}</button>
      </>}>
      <p className="ask-msg">{q.message}</p>
    </Modal>
  );
}
