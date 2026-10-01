import type { AgentProfile, ChatMessage, Task } from '../../../src/shared/types';
import { Markdown } from './Markdown';
import { modelLabel } from '../models';
import { useStore } from '../store';

export function ModelTag({ task }: { task?: Task }) {
  const catalog = useStore((s) => s.catalog);
  if (!task?.model) return null;
  return (
    <span className="mtags">
      <span className="mtag" title={`Model that ran: ${task.model}`}>{modelLabel(catalog, task.model)}</span>
      {task.escalated && <span className="mtag mtag-esc" title="The router retried this task on Opus">{'↑'} escalated</span>}
    </span>
  );
}

/** Splits a leading /opus, /sonnet or /model x routing prefix off a user message so the bubble shows only what was asked. */
export function splitPrefix(text: string): { model: string | null; text: string } {
  const a = /^\/(opus|sonnet)\s+([\s\S]*)$/i.exec(text);
  if (a) return { model: a[1].toLowerCase(), text: a[2] };
  const b = /^\/model\s+(\S+)\s+([\s\S]*)$/i.exec(text);
  return b ? { model: b[1], text: b[2] } : { model: null, text };
}

export function MessageView({ m, agent, task, streaming }: { m: Pick<ChatMessage, 'role' | 'text'>; agent?: AgentProfile; task?: Task; streaming?: boolean }) {
  if (m.role === 'user') return <UserBubble text={m.text} />;
  if (m.role === 'system') return <div className="msg system">{m.text}</div>;
  return (
    <div className="msg assistant">
      <div className="msg-head">
        <span className="mini-avatar">{agent?.emoji ?? '●'}</span>
        <span className="who">{agent?.name ?? 'Legion'}</span>
        <ModelTag task={task} />
      </div>
      <Markdown text={m.text} caret={streaming} />
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  const catalog = useStore((s) => s.catalog);
  const p = splitPrefix(text);
  return (
    <div className="msg user">
      {p.model && <span className="mtag user-mtag" title="Model chosen for this message">{modelLabel(catalog, p.model)}</span>}
      <div className="bubble">{p.text}</div>
    </div>
  );
}
