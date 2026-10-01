import { memo } from 'react';
import type { AgentProfile, ChatMessage, Task } from '../../../src/shared/types';
import { Markdown } from './Markdown';
import { modelLabel } from '../models';
import { selectTask, useStore } from '../store';

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

function MessageViewImpl({ m, agent, task, streaming }: { m: Pick<ChatMessage, 'role' | 'text' | 'fromAgentId'>; agent?: AgentProfile; task?: Task; streaming?: boolean }) {
  if (m.role === 'user' && (m.fromAgentId || parseReply(m.text))) return <AgentMessage from={m.fromAgentId ?? parseReply(m.text)!.name} text={m.text} />;
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

/** "[Reply from Builder \u00b7 task task_x] body" is how a tell() result is delivered back into the caller's task. */
export function parseReply(text: string): { name: string; taskId: string; body: string } | null {
  const r = /^\[Reply from (.+?) \u00b7 task (\S+?)\]\s*([\s\S]*)$/.exec(text);
  return r ? { name: r[1], taskId: r[2], body: r[3] } : null;
}

/** A user-role turn sent by another Legion agent through the bridge. Not the owner's bubble. */
function AgentMessage({ from, text }: { from: string; text: string }) {
  const sender = useStore((s) => s.agents.find((a) => a.id === from));
  const reply = parseReply(text);
  const taskExists = useStore((s) => (reply ? s.tasks.some((t) => t.id === reply.taskId) : false));
  return (
    <div className="msg from-agent">
      <div className="msg-head">
        <span className="mini-avatar">{sender?.emoji ?? '\u25cf'}</span>
        <span className="who">{sender?.name ?? reply?.name ?? from}</span>
        {reply ? (taskExists
          ? <button type="button" className="mtag reply-tag" title={`Open task ${reply.taskId}`} onClick={() => selectTask(reply.taskId)}>Reply {'\u2197'}</button>
          : <span className="mtag reply-tag" title={`Task ${reply.taskId}`}>Reply</span>)
          : null}
        <span className="mtag via-tag" title="Sent by another agent through the Legion bridge">via Legion</span>
      </div>
      <div className="fa-body">{reply ? reply.body : text}</div>
    </div>
  );
}

type MVProps = Parameters<typeof MessageViewImpl>[0];
/**
 * A history bubble re-renders only when what it draws changes: its text/role, the agent, the model tag (task.model / task.escalated, the only
 * task fields it reads) or the streaming caret. The live bubble gets a new `m` object per frame, so only it re-renders while text streams
 * (before: every bubble in the thread, on every delta and every task.updated).
 */
export const MessageView = memo(MessageViewImpl, (p: MVProps, n: MVProps) =>
  (p.m === n.m || (p.m.text === n.m.text && p.m.role === n.m.role && p.m.fromAgentId === n.m.fromAgentId))
  && p.agent === n.agent && p.streaming === n.streaming
  && p.task?.model === n.task?.model && p.task?.escalated === n.task?.escalated);
