import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '../../../src/shared/types';
import { CONTINUE_PROMPT, TURN_LIMIT_PREFIX } from '../../../src/shared/continue';
import { base, token } from '../api';
import { decide, dismissOnboarding, openDoctor, openEditor, openSettings, refresh, selectTask, sendPrompt, useStore } from '../store';
import { copyText, money } from '../util';
import { ApprovalCard } from './ApprovalCard';
import { Icon } from './icons';
import { MessageView } from './MessageView';
import { TaskSwitcher } from './TaskSwitcher';
import { ToolGroup } from './ToolChip';

type Item = { k: 'msg'; m: ChatMessage } | { k: 'tools'; items: ChatMessage[] };

/** Tool results are stored as separate messages (resultFor → toolUseId); they are shown inside their call's chip. */
function toolResults(messages: ChatMessage[]): Record<string, string> {
  const r: Record<string, string> = {};
  for (const m of messages) if (m.resultFor) r[m.resultFor] = m.text;
  return r;
}

function group(messages: ChatMessage[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    if (m.resultFor) continue;
    if (m.role === 'tool') {
      const last = out[out.length - 1];
      if (last && last.k === 'tools') last.items.push(m); else out.push({ k: 'tools', items: [m] });
    } else out.push({ k: 'msg', m });
  }
  return out;
}

const EMPTY: ChatMessage[] = [];

export function Thread() {
  const agentId = useStore((s) => s.selectedAgentId);
  const taskId = useStore((s) => s.selectedTaskId);
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const messages = useStore((s) => (taskId ? s.messages[taskId] ?? EMPTY : EMPTY));
  const stream = useStore((s) => (taskId ? s.streaming[taskId] ?? '' : ''));
  const approvals = useStore((s) => s.approvals);
  const conn = useStore((s) => s.conn);
  const loaded = useStore((s) => s.loaded);
  const agent = agents.find((a) => a.id === agentId);
  const task = taskId ? tasks.find((t) => t.id === taskId) : undefined;
  const running = task?.status === 'running' || task?.status === 'queued';
  // a turn-limit stop is a pause with the work kept, not a failure: it gets its own card
  const paused = task?.status === 'error' && (task.error ?? '').startsWith(TURN_LIMIT_PREFIX);

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const awayRef = useRef(false);
  const setAwayOnce = useCallback((v: boolean) => { if (awayRef.current !== v) { awayRef.current = v; setAway(v); } }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current; if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    stick.current = near;
    setAwayOnce(!near);
  }, [setAwayOnce]);
  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current; if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stick.current = true; setAwayOnce(false);
  }, [setAwayOnce]);

  // new thread → jump to bottom without animation
  useLayoutEffect(() => { stick.current = true; toBottom(); }, [taskId, toBottom]);
  // follow content while stuck to bottom
  const taskApprovals = approvals.filter((a) => a.taskId === taskId);
  const otherApprovals = approvals.filter((a) => a.agentId === agentId && a.taskId !== taskId);
  useLayoutEffect(() => { if (stick.current) toBottom(); }, [messages, stream, taskApprovals.length, running, toBottom]);

  // A / D shortcut for the first pending approval when nothing is focused
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || t.closest('.approval, .modal'))) return;
      const first = taskApprovals[0]; if (!first) return;
      if (e.key === 'a' || e.key === 'A') { e.preventDefault(); void decide(first.id, true); }
      if (e.key === 'd' || e.key === 'D') { e.preventDefault(); void decide(first.id, false); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const items = useMemo(() => group(messages), [messages]);
  const results = useMemo(() => toolResults(messages), [messages]);
  const lastUser = useMemo(() => [...messages].reverse().find((m) => m.role === 'user' && !m.fromAgentId), [messages]);
  const empty = items.length === 0 && !stream && !running;

  return (
    <section className="thread">
      <div className="thread-head">
        <div className="th-agent">
          <span className="avatar sm">{agent?.emoji ?? '●'}</span>
          <div className="th-text">
            <b>{agent?.name ?? 'Legion'}</b>
            <span>{agent?.description || 'General-purpose agent'}</span>
          </div>
        </div>
        <div className="th-right">
          {agent && <span className={`chip-pill ap-${agent.approval}`} title="Approval mode">{agent.approval === 'full' ? 'Full access' : agent.approval === 'ask' ? 'Asks first' : 'Auto-edits'}</span>}
          {task?.provider && <span className="th-cost" title="This run used a provider, not Claude. Cost is shown only when you entered prices for the model.">{task.provider}{task.tokenUsage?.inputTokens != null ? ` \u00b7 ${task.tokenUsage.inputTokens} in / ${task.tokenUsage.outputTokens ?? 0} out` : ''}{task.tokenUsage?.unknown ? ' \u00b7 token counts unknown' : ''}{task.costUsd == null ? ' \u00b7 cost unknown' : ''}</span>}
          {task && <span className="th-cost" title="Cumulative cost and turns for this task">{task.costUsd != null ? money(task.costUsd) : ''}{task.costUsd != null && task.turns != null ? ' · ' : ''}{task.turns != null ? `${task.turns} turn${task.turns === 1 ? '' : 's'}` : ''}</span>}
          {agent && <button className="icon-btn" onClick={() => openEditor(agent.id)} aria-label="Edit agent" title="Edit agent"><Icon name="edit" size={14} /></button>}
        </div>
      </div>
      <TaskSwitcher />
      {loaded && conn === 'offline' && agents.length > 0 && (
        <div className="banner offline" role="status"><Icon name="x" size={13} /> <span>Legion core is not reachable. Retrying automatically; replies resume when it is back.</span></div>
      )}
      {otherApprovals.length > 0 && (
        <button className="banner" onClick={() => selectTask(otherApprovals[0].taskId)}>
          <Icon name="shield" size={13} /> {otherApprovals.length} approval{otherApprovals.length > 1 ? 's' : ''} waiting in another task <span>Open {'→'}</span>
        </button>
      )}
      <div className="thread-scroll scroll-cue" ref={scroller} onScroll={onScroll}>
        <div className="thread-inner">
          {empty ? <EmptyState /> : (
            <>
              {items.map((it, i) => it.k === 'tools'
                ? <ToolGroup key={it.items[0].id} items={it.items} results={results} />
                : <MessageView key={it.m.id} m={it.m} agent={agent} task={task} />)}
              {stream && <MessageView m={{ role: 'assistant', text: stream }} agent={agent} task={task} streaming />}
              {running && !stream && <div className="working" aria-live="polite"><i /><i /><i /><span>{task?.status === 'queued' ? 'Queued' : 'Working'}</span></div>}
              {taskApprovals.map((a) => <ApprovalCard key={a.id} a={a} />)}
              {task?.status === 'error' && (paused ? (
                <div className="msg err paused" role="status">
                  <Icon name="pause" size={14} />
                  <div className="err-body"><b>Paused at the turn limit</b><p>{task.error}</p></div>
                  <div className="err-actions">
                    {task.resumable && <button className="btn sm primary" onClick={() => void sendPrompt(CONTINUE_PROMPT)}>Continue</button>}
                    <button className="link-btn" onClick={() => openSettings('claude')}>Raise the limit</button>
                  </div>
                </div>
              ) : (
                <div className="msg err" role="alert">
                  <Icon name="x" size={14} />
                  <div className="err-body"><b>Run failed</b><p>{task.error || 'The run failed without a message.'}</p></div>
                  {/* resumable: the session already holds the request, so re-sending it would start the task over */}
                  {task.resumable
                    ? <button className="btn sm" onClick={() => void sendPrompt(CONTINUE_PROMPT)} title="Pick up where the run stopped, in the same conversation">Continue</button>
                    : lastUser && <button className="btn sm" onClick={() => void sendPrompt(lastUser.text)}>Retry</button>}
                </div>
              ))}
              {task?.status === 'cancelled' && !(messages[messages.length - 1]?.role === 'system' && messages[messages.length - 1]?.text === 'Cancelled') && <div className="msg system">Cancelled</div>}
              <div className="thread-pad" />
            </>
          )}
        </div>
      </div>
      {away && <button className="jump" onClick={() => toBottom(true)}><Icon name="down" size={13} /> Jump to latest</button>}
    </section>
  );
}

function EmptyState() {
  const agents = useStore((s) => s.agents);
  const agentId = useStore((s) => s.selectedAgentId);
  const tasks = useStore((s) => s.tasks);
  const dismissed = useStore((s) => s.onboardingDismissed);
  const boat = useStore((s) => s.boatConfigured);
  const doctor = useStore((s) => s.doctor);
  const agent = agents.find((a) => a.id === agentId);
  const conn = useStore((s) => s.conn);
  const first = tasks.length === 0 && !dismissed;
  const mkCmd = (tok: string) => `claude mcp add --transport http legion ${base}/mcp --header "Authorization: Bearer ${tok}"`;
  const cmd = mkCmd(token);
  const shownCmd = mkCmd(token ? '\u2022'.repeat(12) : '<token>');
  const [copied, setCopied] = useState(false);
  const signin = doctor?.find((c) => /claude|sign|auth/i.test(c.id + c.label));

  if (agents.length === 0 && conn !== 'online') {
    return (
      <div className="empty down">
        <span className="avatar xl"><Icon name="pulse" size={24} /></span>
        <h3>{conn === 'connecting' ? 'Connecting to Legion core\u2026' : 'Cannot reach Legion core'}</h3>
        <p>{conn === 'connecting' ? 'Hold on, this takes a moment.' : 'The local core is not answering. Start it with start-legion.cmd, then try again. Legion keeps retrying on its own.'}</p>
        <button className="btn" onClick={() => void refresh()}>Try again</button>
      </div>
    );
  }
  if (!first) {
    return (
      <div className="empty">
        <span className="avatar xl">{agent?.emoji ?? '●'}</span>
        <h3>New task for {agent?.name ?? 'Legion'}</h3>
        <p>{agent?.description || 'Describe what you want done.'}</p>
        <div className="hints">
          <kbd>/opus</kbd><span>force Opus</span><kbd>/sonnet</kbd><span>force Sonnet</span><kbd>Shift Enter</kbd><span>newline</span>
        </div>
      </div>
    );
  }
  return (
    <div className="firstrun">
      <h3>Welcome to Legion</h3>
      <p className="lead">Three quick things and you are set. Then just type below.</p>
      <ol className="steps">
        <li>
          <span className={`step-n${signin?.ok ? ' ok' : ''}`}>{signin?.ok ? <Icon name="check" size={12} /> : 1}</span>
          <div><b>Check your Claude sign-in</b><p>Legion uses the account you are signed into Claude Code with. Doctor verifies it without a model call.</p></div>
          <button className="btn" onClick={openDoctor}>Run Doctor</button>
        </li>
        <li>
          <span className={`step-n${boat ? ' ok' : ''}`}>{boat ? <Icon name="check" size={12} /> : 2}</span>
          <div><b>Add a boat key for VMs</b><p>{boat ? 'Connected. Agents can start on-demand VMs.' : <>Paste your boat.dev key in Settings. It applies straight away, no restart.</>}</p></div>
          {!boat && <button className="btn" onClick={() => openSettings('boat')}>Add key</button>}
        </li>
        <li>
          <span className="step-n">3</span>
          <div><b>Connect to Claude Code</b><p>Run this once in a terminal to drive your agents from Claude Code or Cowork. Copy includes your token; it is hidden here.</p>
            <div className="cmd"><code>{shownCmd}</code>
              <button className="btn-ghost sm" onClick={async () => { if (await copyText(cmd)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}><Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
        </li>
      </ol>
      <button className="btn-ghost" onClick={dismissOnboarding}>Dismiss</button>
    </div>
  );
}
