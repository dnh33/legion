import { useEffect, useMemo, useRef, useState } from 'react';
import { buildMenu, isCostly, parseSlash, runLegionCommand, LEGION_COMMANDS, type MenuItem } from '../commands';
import { modelLabel } from '../models';
import { cancelSelected, effectiveModel, loadCatalog, sendPrompt, toast, useStore } from '../store';
import { clip } from '../util';
import { Icon } from './icons';
import { ModelPicker } from './ModelPicker';
import { SlashMenu } from './SlashMenu';

export function Composer() {
  const [text, setText] = useState('');
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [picker, setPicker] = useState(false);
  const [costAsk, setCostAsk] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const agentId = useStore((s) => s.selectedAgentId);
  const taskId = useStore((s) => s.selectedTaskId);
  const model = useStore(effectiveModel);
  const catalog = useStore((s) => s.catalog);
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const task = tasks.find((t) => t.id === taskId);
  const agent = agents.find((a) => a.id === agentId);
  const running = task?.status === 'running' || task?.status === 'queued';
  const agentName = clip(agent?.name ?? 'Legion', 26);

  // slash menu: only while the text is a single "/token" (no space yet)
  const token = /^\/([^\s]*)$/.exec(text);
  const menuOpen = !!token && !dismissed && !picker;
  const items = useMemo<MenuItem[]>(() => (token ? buildMenu(token[1], catalog?.commands ?? []) : []), [text, catalog]);
  useEffect(() => { if (menuOpen && !catalog) void loadCatalog(); }, [menuOpen, catalog]);
  useEffect(() => { setSel(0); setDismissed(false); }, [token?.[1]]);
  useEffect(() => { setCostAsk(null); }, [text]);

  // argument hint once a command has been chosen: "/review " -> [pr-number]
  const argHint = useMemo(() => {
    const p = parseSlash(text);
    if (!p || p.arg || !/\s$/.test(text)) return null;
    const l = LEGION_COMMANDS.find((c) => c.name === p.name);
    const c = l ?? catalog?.commands.find((x) => x.name.toLowerCase() === p.name);
    return c && c.argumentHint ? { name: p.name, hint: c.argumentHint, description: c.description } : null;
  }, [text, catalog]);

  const fit = () => {
    const el = ta.current; if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  };
  useEffect(fit, [text]);
  useEffect(() => {
    const f = () => ta.current?.focus();
    const p = () => setPicker((o) => !o);
    window.addEventListener('legion:focus-composer', f);
    window.addEventListener('legion:model-picker', p);
    return () => { window.removeEventListener('legion:focus-composer', f); window.removeEventListener('legion:model-picker', p); };
  }, []);
  const closePicker = () => { setPicker(false); ta.current?.focus(); };

  const submit = async (raw = text) => {
    if (!raw.trim()) return;
    // commands whose description mentions money need a deliberate second Enter
    const cp = parseSlash(raw);
    const cc = cp ? catalog?.commands.find((x) => x.name.toLowerCase() === cp.name) : undefined;
    if (cc && isCostly(cc.description) && !LEGION_COMMANDS.some((l) => l.name === cp!.name) && costAsk !== cp!.name) { setCostAsk(cp!.name); return; }
    const r = await runLegionCommand(raw);
    if (r === 'handled') { setText(''); return; }
    if (running) { toast('Agent is busy — wait or stop it first'); return; }
    setText('');
    const ok = await sendPrompt(raw);
    if (!ok) setText(raw);
  };

  const accept = (m: MenuItem, viaEnter: boolean) => {
    const typed = token?.[1].toLowerCase() === m.name.toLowerCase();
    if (viaEnter && m.group === 'Legion' && (m.immediate || (typed && !m.hint.startsWith('<')))) { void submit('/' + m.name); return; }
    if (viaEnter && m.group === 'Claude Code' && m.costly && !m.hint) { void submit('/' + m.name); return; }
    if (viaEnter && m.group === 'Claude Code' && typed && !m.hint) { void submit('/' + m.name); return; }
    setText(`/${m.name} `);
    requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((n) => (n + 1) % items.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((n) => (n - 1 + items.length) % items.length); return; }
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); accept(items[Math.min(sel, items.length - 1)], false); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); accept(items[Math.min(sel, items.length - 1)], true); return; }
    }
    if (menuOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(true); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  };

  return (
    <div className="composer-wrap">
      <div className={`composer${running ? ' busy' : ''}`}>
        {menuOpen && <SlashMenu items={items} sel={Math.min(sel, Math.max(0, items.length - 1))} setSel={setSel} onPick={(m) => accept(m, false)} />}
        {picker && <ModelPicker model={model} agentName={agentName} onClose={closePicker} />}
        {costAsk && <div className="cost-note" role="alert"><Icon name="shield" size={13} /> <b>/{costAsk}</b> can cost money. Press Enter again to run it, or keep typing to cancel.</div>}
        {argHint && <div className="arg-hint"><code>/{argHint.name}</code><span className="sm-hint">{argHint.hint}</span><span>{argHint.description}</span></div>}
        <textarea ref={ta} rows={1} value={text} placeholder={taskId ? `Reply to ${agentName}` : `Ask ${agentName} to do something`}
          onChange={(e) => { setText(e.target.value); const n = Date.now(); if (n - lastTyping.current > 300) { lastTyping.current = n; window.dispatchEvent(new Event('legion:typing')); } }}
          onKeyDown={onKeyDown} aria-label="Message" aria-expanded={menuOpen} aria-haspopup="listbox" />
        <div className="composer-bar">
          <button type="button" className={`model-pill${picker ? ' open' : ''}`} onClick={() => setPicker((o) => !o)} aria-haspopup="listbox" aria-expanded={picker}
            title="Choose model (Ctrl M). Remembered for this agent.">
            {modelLabel(catalog, model)}<Icon name="down" size={12} />
          </button>
          <span className="composer-hint"><span className="hint-long"><kbd>Enter</kbd> send <kbd>Shift Enter</kbd> newline </span><kbd>/</kbd> commands</span>
          <span className="spacer" />
          {running
            ? <button className="send stop" onClick={() => void cancelSelected()} aria-label="Stop"><Icon name="stop" size={14} /> Stop</button>
            : <button className="send" disabled={!text.trim()} onClick={() => void submit()} aria-label="Send"><Icon name="send" size={14} /></button>}
        </div>
      </div>
    </div>
  );
}
