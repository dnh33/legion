import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '../../../src/shared/types';
import { CONTINUE_PROMPT, budgetLimitFromError, isBudgetPause, isLimitPause } from '../../../src/shared/continue';
import { threadKey } from '../../../src/shared/approval-keys';
import { base, token } from '../api';
import { decide, dismissOnboarding, ensureLoaded, jumpToLatest, loadOlder, openDoctor, openEditor, openSettings, refresh, retryOlder, selectTask, sendPrompt, useStore } from '../store';
import { ROW_GAP, anchoredScrollTop, hasOlder, layoutOffsets, metaDetached, rowAt, rowIndexOfMessage, scrollForRow, shouldLoadOlder, visibleRange } from '../chat/threadWindow';
import { ThreadSearch } from './ThreadSearch';
import { copyText, money } from '../util';
import { ApprovalCard } from './ApprovalCard';
import { Icon } from './icons';
import { MessageView } from './MessageView';
import { TaskSwitcher } from './TaskSwitcher';
import { ToolGroup } from './ToolChip';
import { WorkingRow } from './WorkingRow';
import { TodoList } from './TodoList';

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
const itemKey = (it: Item): string => (it.k === 'tools' ? it.items[0]!.id : it.m.id);

/** One drawn row of the conversation. Its measured height feeds the window (rows not drawn use an estimate); `onSize` also fires when the row resizes (a code block wrapping, an image loading). */
function Row({ k, onSize, hit, children }: { k: string; onSize: (k: string, h: number) => void; hit: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    onSize(k, el.offsetHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => onSize(k, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [k, onSize]);
  return <div ref={ref} className={`vrow${hit ? ' hit' : ''}`} data-k={k}>{children}</div>;
}

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
  // a turn-limit or spend-limit stop is a pause with the work kept, not a failure: it gets its own card
  const paused = isLimitPause(task);
  const budgetPaused = isBudgetPause(task);
  const pausedBudget = budgetPaused ? budgetLimitFromError(task?.error) : undefined;
  const pausedTurns = paused ? /\((\d+) turns this run\)/.exec(task?.error ?? '')?.[1] : undefined;
  // the history already ends with the engine's own "Cancelled" line: the thread must not say it twice
  const last = messages[messages.length - 1];
  const cancelledInHistory = last?.role === 'system' && last.text === 'Cancelled';

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const meta = useStore((s) => (taskId ? s.threadMeta[taskId] : undefined));
  // windowing: measured row heights (per thread), the scroll offset, and what the reader is anchored to while older rows load
  const hv = useRef<{ id: string | null; map: Map<string, number> }>({ id: null, map: new Map() });
  if (hv.current.id !== taskId) hv.current = { id: taskId, map: new Map() };
  const [tick, setTick] = useState(0);
  const [top, setTop] = useState(Number.MAX_SAFE_INTEGER); // "far down": a thread opens at its tail
  const [viewH, setViewH] = useState(640);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hitId, setHitId] = useState<string | null>(null);
  const anchor = useRef<{ key: string; rowTop: number; first: string } | null>(null);
  const pin = useRef<{ id: string; n: number } | null>(null);
  const offsetsRef = useRef<number[]>([0]);
  const keysRef = useRef<string[]>([]);
  const pendingSize = useRef(false);
  const onSize = useCallback((k: string, h: number) => {
    const map = hv.current.map; const old = map.get(k);
    if (old === h) return;
    map.set(k, h);
    const el = scroller.current; const i = keysRef.current.indexOf(k);
    // a row above the reader changed height: move the scroll position by the same amount so what is on screen does not jump
    if (el && i >= 0 && !stick.current && old !== undefined && offsetsRef.current[i + 1]! <= el.scrollTop) el.scrollTop += h - old;
    if (!pendingSize.current) { pendingSize.current = true; queueMicrotask(() => { pendingSize.current = false; setTick((t) => t + 1); }); }
  }, []);
  const [away, setAway] = useState(false);
  const awayRef = useRef(false);
  const setAwayOnce = useCallback((v: boolean) => { if (awayRef.current !== v) { awayRef.current = v; setAway(v); } }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current; if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    stick.current = near;
    setAwayOnce(!near);
    setTop(el.scrollTop); setViewH(el.clientHeight || 800);
    if (taskId && shouldLoadOlder(el.scrollTop, meta)) {
      const i = rowAt(offsetsRef.current, el.scrollTop);
      anchor.current = { key: keysRef.current[i] ?? '', rowTop: (offsetsRef.current[i] ?? 0) - el.scrollTop, first: keysRef.current[0] ?? '' };
      void loadOlder(taskId);
    }
  }, [setAwayOnce, taskId, meta]);
  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current; if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stick.current = true; setAwayOnce(false);
  }, [setAwayOnce]);

  // new thread → jump to bottom without animation
  useLayoutEffect(() => { stick.current = true; anchor.current = null; pin.current = null; setHitId(null); setSearchOpen(false); setTop(Number.MAX_SAFE_INTEGER); toBottom(); setViewH(scroller.current?.clientHeight || 800); }, [taskId, toBottom]);
  // the window follows the pane's height (resizing, a hidden pane being shown)
  useEffect(() => {
    const el = scroller.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // follow content while stuck to bottom
  const taskApprovals = approvals.filter((a) => a.taskId === taskId);
  const otherApprovals = approvals.filter((a) => a.agentId === agentId && a.taskId !== taskId);
  useLayoutEffect(() => { if (stick.current && !metaDetached(meta)) toBottom(); }, [messages, stream, taskApprovals.length, running, toBottom, tick, meta]);

  // A / D shortcut for the first pending approval when nothing is focused (A never allows a click-only card)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || t.closest('.approval, .modal'))) return;
      // the same rule as the card's own keys: a Blender script or a download is allowed by clicking only
      const k = threadKey(taskApprovals[0], e.key); if (!k) return;
      e.preventDefault(); void decide(k.id, k.allow);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const items = useMemo(() => group(messages), [messages]);
  const results = useMemo(() => toolResults(messages), [messages]);
  const lastUser = useMemo(() => [...messages].reverse().find((m) => m.role === 'user' && !m.fromAgentId), [messages]);
  const empty = items.length === 0 && !stream && !running;
  const keys = useMemo(() => items.map(itemKey), [items]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const offsets = useMemo(() => layoutOffsets(keys, hv.current.map), [keys, tick, taskId]);
  keysRef.current = keys; offsetsRef.current = offsets;
  const win = visibleRange(offsets, top, viewH);
  // older rows arrived above: put the scroll position back so the row the reader was looking at stays where it was
  useLayoutEffect(() => {
    const el = scroller.current; const a = anchor.current;
    if (!el || !a || keys[0] === a.first) return;
    const i = keys.indexOf(a.key); anchor.current = null;
    if (i >= 0) { el.scrollTop = anchoredScrollTop(offsets[i]!, a.rowTop); setTop(el.scrollTop); }
  }, [keys, offsets]);
  // a search hit: bring its row to the top, again as the rows around it are measured (estimates become real heights), until it settles
  useLayoutEffect(() => {
    const el = scroller.current; const p = pin.current;
    if (!el || !p) return;
    const i = rowIndexOfMessage(items, messages, p.id);
    if (i < 0) return;
    const want = scrollForRow(offsets, i);
    if (Math.abs(el.scrollTop - want) > 2) { el.scrollTop = want; setTop(want); }
    if (++p.n > 8) pin.current = null;
  }, [offsets, items, messages]);
  const jumpTo = useCallback(async (index: number, id: string) => {
    if (!taskId || !(await ensureLoaded(taskId, index))) return;
    stick.current = false; setAwayOnce(true); setHitId(id); pin.current = { id, n: 0 }; setTick((t) => t + 1);
  }, [taskId, setAwayOnce]);

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
          {taskId && <button className={`icon-btn${searchOpen ? ' on' : ''}`} onClick={() => setSearchOpen((v) => !v)} aria-pressed={searchOpen} aria-label="Search this conversation" title="Search this conversation"><Icon name="search" size={14} /></button>}
          {agent && <button className="icon-btn" onClick={() => openEditor(agent.id)} aria-label="Edit agent" title="Edit agent"><Icon name="edit" size={14} /></button>}
        </div>
      </div>
      <TaskSwitcher />
      {taskId && searchOpen && <ThreadSearch taskId={taskId} onJump={jumpTo} onClose={() => { setSearchOpen(false); setHitId(null); }} />}
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
              {taskId && hasOlder(meta) && (
                <div className="older-row" role="status">
                  {meta?.error ? <button className="btn sm" onClick={() => retryOlder(taskId)}>Could not load earlier messages. Retry</button>
                    : meta?.loadingOlder ? <span><span className="spin" /> Loading earlier messages{'\u2026'}</span>
                    : <button className="btn sm" onClick={() => { anchor.current = { key: keys[0] ?? '', rowTop: 0, first: keys[0] ?? '' }; void loadOlder(taskId); }}>{meta!.start} earlier messages. Load more</button>}
                </div>
              )}
              {win.padTop > 0 && <div aria-hidden="true" style={{ height: Math.max(0, win.padTop - ROW_GAP) }} />}
              {items.slice(win.start, win.end).map((it) => {
                const k = itemKey(it);
                return (
                  <Row key={k} k={k} onSize={onSize} hit={hitId !== null && (it.k === 'msg' ? it.m.id === hitId : it.items.some((x) => x.id === hitId))}>
                    {it.k === 'tools' ? <ToolGroup items={it.items} results={results} /> : <MessageView m={it.m} agent={agent} task={task} />}
                  </Row>
                );
              })}
              {win.padBottom > 0 && <div aria-hidden="true" style={{ height: Math.max(0, win.padBottom - ROW_GAP) }} />}
              {stream && <MessageView m={{ role: 'assistant', text: stream }} agent={agent} task={task} streaming />}
              {running && task && task.status !== 'queued' && <TodoList taskId={task.id} />}
              {running && !stream && task && <WorkingRow taskId={task.id} queued={task.status === 'queued'} waiting={taskApprovals.length > 0} />}
              {taskApprovals.map((a) => <ApprovalCard key={a.id} a={a} />)}
              {task?.status === 'error' && (paused ? (
                <div className="msg err paused" role="status">
                  <Icon name="pause" size={14} />
                  <div className="err-body">{budgetPaused ? <><b>Paused at the spend limit</b><p>{pausedBudget ? `This run reached its spend limit of ${pausedBudget}` : 'This run reached its spend limit'} before finishing. The work so far is kept; Continue picks up where it stopped.</p></> : <><b>Paused at the turn limit</b><p>{pausedTurns ? `Claude used all ${pausedTurns} turns of this run` : 'Claude used all the turns of this run'} before finishing. The work so far is kept; Continue picks up where it stopped.</p></>}</div>
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
              {task?.status === 'cancelled' && (task.resumable ? (
                /* the run reached its session before it was cancelled, so Continue picks up there instead of starting over */
                <div className="msg system">{cancelledInHistory ? '' : 'Cancelled. '}Continue picks up where it stopped. <button className="btn sm" onClick={() => void sendPrompt(CONTINUE_PROMPT)}>Continue</button></div>
              ) : !cancelledInHistory && <div className="msg system">Cancelled</div>)}
              <div className="thread-pad" />
            </>
          )}
        </div>
      </div>
      {taskId && metaDetached(meta) && <div className="banner detached" role="status"><span>Showing an earlier part of this conversation.</span> <button className="btn sm" onClick={() => { jumpToLatest(taskId); setHitId(null); stick.current = true; }}>Jump to latest</button></div>}
      {away && !metaDetached(meta) && <button className="jump" onClick={() => toBottom(true)}><Icon name="down" size={13} /> Jump to latest</button>}
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
