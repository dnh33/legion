import { useEffect, useState } from 'react';
import type { AgentProfile, ApprovalMode, GateContext, GateRule, GateSuggestion, GateVerdict, GatesConfig, GateWhen, SettingsView } from '../../../src/shared/types';
import type { Project } from '../../../src/shared/projects';
import { dismissGateSuggestion, errText, loadGateSuggestions, rememberGate, saveSettings, useStore } from '../store';
import { Icon } from '../components/icons';
import {
  CONTEXT_CHIPS, GATE_PRESETS, GATES_EMPTY, SUGGEST_AFTER, TOOL_CHIPS, VERDICT_TEXT,
  consequenceLine, gateSentence, gateTestResult, newGateId, presetRule, ruleHostless, toggleIn,
  type GateTestResult,
} from './gatesLogic';
import { GatesBanner, GatesPresets, EVERYTHING } from './GatesPresets';
import { PermissionGates } from './PermissionGates';
import { QaGates, RailsList } from './RailsList';
import { ActivityView } from './ActivityView';
import { useGatesAction, useGatesView } from './useGatesView';
import { AGENT_MODE_HELP, AGENT_MODE_LABEL } from './presetsLogic';
import './gates.css';

const THEN_BADGE: Record<GateVerdict, { text: string }> = {
  allow: { text: '\u2714 Never ask' },
  ask: { text: '\u270b Ask' },
  deny: { text: '\u26d4 Block' },
};
const SOURCE_TEXT: Record<GateRule['source'], string> = { preset: 'from a preset', card: 'from a card', user: 'yours' };

/** The builder's state: every chip list, before it becomes a GateWhen. Nobody ever sees the stored JSON. */
interface Draft { agents: string[]; tools: string[]; commands: string[]; paths: string[]; exceptPaths: string[]; projects: string[]; contexts: GateContext[]; then: GateVerdict }
const emptyDraft = (then: GateVerdict = 'ask'): Draft => ({ agents: [], tools: [], commands: [], paths: [], exceptPaths: [], projects: [], contexts: [], then });

function draftWhen(d: Draft): GateWhen {
  return {
    ...(d.agents.length ? { agents: d.agents } : {}),
    ...(d.tools.length ? { tools: d.tools } : {}),
    ...(d.commands.length ? { commands: d.commands } : {}),
    ...(d.paths.length ? { paths: d.paths } : {}),
    ...(d.exceptPaths.length ? { exceptPaths: d.exceptPaths } : {}),
    ...(d.projects.length ? { projects: d.projects } : {}),
    ...(d.contexts.length ? { contexts: d.contexts } : {}),
  };
}

function toDraft(r: GateRule): Draft {
  const w = r.when;
  return {
    agents: [...(w.agents ?? [])], tools: [...(w.tools ?? [])], commands: [...(w.commands ?? [])],
    paths: [...(w.paths ?? [])], exceptPaths: [...(w.exceptPaths ?? [])], projects: [...(w.projects ?? [])],
    contexts: [...(w.contexts ?? [])] as GateContext[], then: r.then,
  };
}

/** A one-line chips input: type, Enter or Add, remove with the x. Used for commands and paths. */
function Chips({ label, hint, items, onAdd, onRemove, placeholder }: {
  label: string; hint?: string; items: readonly string[]; onAdd: (v: string) => void; onRemove: (v: string) => void; placeholder: string;
}) {
  const [text, setText] = useState('');
  const add = () => { const v = text.trim(); if (v) { onAdd(v); setText(''); } };
  return (
    <div className="gate-chips">
      <div className="gate-chip-row">
        {items.map((it) => (
          <span key={it} className="gate-chip">{it}<button type="button" aria-label={`Remove ${it}`} disabled={items.length <= 1} onClick={() => onRemove(it)}><Icon name="x" size={10} /></button></span>
        ))}
        <input value={text} placeholder={placeholder} aria-label={label} spellCheck={false}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
      </div>
      {text.trim() && <button type="button" className="btn-ghost sm" onClick={add}><Icon name="plus" size={12} /> Add {text.trim()}</button>}
      {hint && <span className="set-hint">{hint}</span>}
    </div>
  );
}

/** Who / What / Where / Then, with the live sentence at the top, the same string that becomes the stored label. */
export function GateBuilder({ draft, setDraft, agents, projects, projectOf, mode, onCancel, onSave, saveLabel }: {
  draft: Draft; setDraft: (d: Draft) => void;
  agents: readonly AgentProfile[]; projects: readonly Project[]; projectOf: (id: string) => string; mode: ApprovalMode;
  onCancel: () => void; onSave: () => void; saveLabel: string;
}) {
  const nameOf = (id: string) => { const a = agents.find((x) => x.id === id); return a ? `${a.emoji} ${a.name}` : id; };
  const chip = (on: boolean) => (on ? 'gate-chip on' : 'gate-chip');
  return (
    <div className="set-card gate-builder" aria-label="Rule builder">
      <p className="gate-preview" role="status">{gateSentence(draftWhen(draft), draft.then, nameOf, projectOf)}</p>
      <div className="set-field"><span className="set-label">Who</span>
        <div className="gate-chip-row" role="group" aria-label="Who this affects">
          <button type="button" className={chip(!draft.agents.length)} aria-pressed={!draft.agents.length} onClick={() => setDraft({ ...draft, agents: [] })}>Any agent</button>
          {agents.map((a) => (
            <button key={a.id} type="button" className={chip(draft.agents.includes(a.id))} aria-pressed={draft.agents.includes(a.id)} onClick={() => setDraft({ ...draft, agents: toggleIn(draft.agents, a.id) })}>{a.emoji} {a.name}</button>
          ))}
        </div>
      </div>
      <div className="set-field"><span className="set-label">What</span>
        <div className="gate-chip-row" role="group" aria-label="What this affects">
          {TOOL_CHIPS.map((t) => (
            <button key={t.id} type="button" className={chip(draft.tools.includes(t.id))} aria-pressed={draft.tools.includes(t.id)} onClick={() => setDraft({ ...draft, tools: toggleIn(draft.tools, t.id) })}>{t.label}</button>
          ))}
        </div>
        {draft.tools.includes('shell') && (
          <Chips label="Commands" items={draft.commands} placeholder="git *"
            onAdd={(v) => setDraft({ ...draft, commands: toggleIn(draft.commands, v) })}
            onRemove={(v) => setDraft({ ...draft, commands: draft.commands.filter((c) => c !== v) })}
            hint={'`*` means anything after this. A compound command (git push && rm x) needs every part to match for Never ask; one matching part is enough for Ask or Block.'} />
        )}
        {(draft.tools.includes('edits') || draft.tools.includes('reads')) && (
          <Chips label="Paths" items={draft.paths} placeholder="src/**"
            onAdd={(v) => setDraft({ ...draft, paths: toggleIn(draft.paths, v) })}
            onRemove={(v) => setDraft({ ...draft, paths: draft.paths.filter((c) => c !== v) })}
            hint={'Gitignore-style: src/** is everything under src, *.env is any .env at any depth.'} />
        )}
        {draft.paths.length > 0 && (
          <Chips label="Except paths" items={draft.exceptPaths} placeholder="src/generated/**"
            onAdd={(v) => setDraft({ ...draft, exceptPaths: toggleIn(draft.exceptPaths, v) })}
            onRemove={(v) => setDraft({ ...draft, exceptPaths: draft.exceptPaths.filter((c) => c !== v) })}
            hint="Carved out of the paths above." />
        )}
      </div>
      <div className="set-field"><span className="set-label">Where (optional)</span>
        {projects.length > 0 && (
          <div className="gate-chip-row" role="group" aria-label="Projects">
            {projects.map((p) => (
              <button key={p.id} type="button" className={chip(draft.projects.includes(p.id))} aria-pressed={draft.projects.includes(p.id)} onClick={() => setDraft({ ...draft, projects: toggleIn(draft.projects, p.id) })}>{p.name}</button>
            ))}
          </div>
        )}
        <div className="gate-chip-row" role="group" aria-label="Run contexts">
          {CONTEXT_CHIPS.map((c) => (
            <button key={c.id} type="button" title={c.why} className={chip(draft.contexts.includes(c.id))} aria-pressed={draft.contexts.includes(c.id)} onClick={() => setDraft({ ...draft, contexts: toggleIn(draft.contexts, c.id) as GateContext[] })}>{c.label}</button>
          ))}
        </div>
      </div>
      <div className="set-field"><span className="set-label">Then</span>
        <div className="seg" role="radiogroup" aria-label="What happens">
          {(['allow', 'ask', 'deny'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={draft.then === v} className={draft.then === v ? 'on' : ''} onClick={() => setDraft({ ...draft, then: v })}>{THEN_BADGE[v].text}</button>
          ))}
        </div>
        <span className="set-hint" role="status">{consequenceLine(draft.then, mode)}</span>
      </div>
      <div className="set-actions">
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn primary" onClick={onSave}>{saveLabel}</button>
      </div>
    </div>
  );
}

/** One rule, as a sentence card. */
export function GateRuleCard({ r, nameOf, projectOf, hostless, busy, confirmDelete, onToggle, onEdit, onDelete, onCancelDelete }: {
  r: GateRule; nameOf: (id: string) => string; projectOf: (id: string) => string; hostless: boolean; busy: boolean; confirmDelete: boolean;
  onToggle: (r: GateRule) => void; onEdit: (r: GateRule) => void; onDelete: (r: GateRule) => void; onCancelDelete: () => void;
}) {
  return (
    <li className={`gate-card${r.enabled ? '' : ' off'}`}>
      <div className="gate-card-head">
        <span className={`gate-then ${r.then}`}>{THEN_BADGE[r.then].text}</span>
        <b className="gate-sentence">{gateSentence(r.when, r.then, nameOf, projectOf)}</b>
      </div>
      <div className="gate-card-meta">
        <span className="muted-s">{SOURCE_TEXT[r.source]}{r.enabled ? '' : ' \u00b7 off'}</span>
        <span className="muted-s">Affects: {r.when.agents?.length ? r.when.agents.map(nameOf).join(', ') : 'every agent'}</span>
        {hostless && <span className="muted-s" role="note">No agent here has the host shell on (agent editor, Shell), so this rule does nothing yet.</span>}
        <span className="gate-card-actions">
          <label className="set-check gate-toggle"><input type="checkbox" checked={r.enabled} disabled={busy} onChange={() => onToggle(r)} /><span>On</span></label>
          {confirmDelete
            ? <><span className="muted-s">Delete this gate?</span>
                <button type="button" className="btn sm danger" onClick={() => onDelete(r)}>Yes, delete</button>
                <button type="button" className="btn-ghost sm" onClick={onCancelDelete}>Keep</button></>
            : <><button type="button" className="btn-ghost sm" onClick={() => onEdit(r)}>Edit</button>
                <button type="button" className="btn-ghost sm danger" onClick={() => onDelete(r)}>Delete</button></>}
        </span>
      </div>
    </li>
  );
}

const TEST_TOOLS = [
  { id: 'bash', label: 'Shell (Bash)', toolName: 'Bash', kind: 'command', placeholder: 'git push origin main' },
  { id: 'host', label: 'Host shell', toolName: 'mcp__host__shell', kind: 'command', placeholder: 'npm run build' },
  { id: 'write', label: 'File edit (Write)', toolName: 'Write', kind: 'path', placeholder: 'src/app.ts' },
  { id: 'read', label: 'File read (Read)', toolName: 'Read', kind: 'path', placeholder: 'README.md' },
  { id: 'web', label: 'Web fetch', toolName: 'WebFetch', kind: 'none', placeholder: '(no command or path)' },
] as const;

/**
 * "Try it": type a command, pick an agent, see the verdict the SAME decideGate would return, the rules exactly
 * as stored, nothing executed (a dry run of the real decision).
 */
export function GateTester({ rules, agents }: { rules: readonly GateRule[]; agents: readonly AgentProfile[] }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [toolId, setToolId] = useState<string>('bash');
  const [text, setText] = useState('');
  const [result, setResult] = useState<GateTestResult | null>(null);
  const agent = agents.find((a) => a.id === agentId);
  const mode: ApprovalMode = agent?.approval ?? 'ask';
  const tool = TEST_TOOLS.find((t) => t.id === toolId) ?? TEST_TOOLS[0];
  const run = () => {
    const input: Record<string, unknown> = tool.kind === 'command' ? { command: text } : tool.kind === 'path' ? { path: text } : {};
    setResult(gateTestResult(rules, { toolName: tool.toolName, input, agentId, mode }));
  };
  return (
    <div className="set-card gate-tester" aria-label="Try it">
      <h4>Try it</h4>
      <p className="muted-s">Nothing runs. This is the same check the engine makes before a tool call.</p>
      <div className="set-inline">
        <label className="grow">Agent
          <select value={agentId} onChange={(e) => { setAgentId(e.target.value); setResult(null); }}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}
          </select>
        </label>
        <label className="grow">Tool
          <select value={toolId} onChange={(e) => { setToolId(e.target.value); setResult(null); }}>
            {TEST_TOOLS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
      </div>
      <div className="set-inline">
        <input className="grow" value={text} placeholder={tool.placeholder} spellCheck={false} aria-label={tool.kind === 'path' ? 'Path' : 'Command'}
          disabled={tool.kind === 'none'} onChange={(e) => { setText(e.target.value); setResult(null); }} />
        <button type="button" className="btn" onClick={run} disabled={tool.kind !== 'none' && !text.trim()}>Test</button>
      </div>
      <span className="set-hint">This agent{'\u2019'}s mode: <b>{AGENT_MODE_LABEL[mode]}</b>. {AGENT_MODE_HELP[mode]}{mode === 'full' ? ' Ask rules are off in Full. Block rules still apply.' : ''}</span>
      {result && <GateTestOut result={result} />}
    </div>
  );
}

/** The tester's readout: the verdict, every rule that matched, and the honest line when nothing decided it. */
export function GateTestOut({ result }: { result: GateTestResult }) {
  return (
    <div className={`gate-test-out v-${result.verdict}`} role="status">
      <b>{VERDICT_TEXT[result.verdict]}</b>
      <span className="muted-s">{result.matched.length ? `${result.matched.length} matching gate${result.matched.length === 1 ? '' : 's'}` : 'No gate matched. Your mode decides, exactly as without gates.'}</span>
      <ul>
        {result.matched.map((r) => (
          <li key={r.id}><span className={`gate-then ${r.then}`}>{THEN_BADGE[r.then].text}</span> {r.label}{r.enabled ? '' : ' (off)'}
            {!r.enabled && <span className="muted-s"> This rule is switched off, so it did not decide anything.</span>}</li>
        ))}
      </ul>
    </div>
  );
}

/** The rails, always on. Kept as the page's one rails block. */
export function GateRails() {
  return <RailsList />;
}

/**
 * Rules earned from the owner's own answers: a call allowed often enough is offered as the rule its card's Remember
 * would make. Offered only; nothing is added until the owner clicks Add rule.
 */
export function GateSuggestions({ items, nameOf, busy, onAdd, onDismiss }: {
  items: readonly GateSuggestion[]; nameOf: (id: string) => string; busy: boolean;
  onAdd: (s: GateSuggestion) => void; onDismiss: (s: GateSuggestion) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="set-card gate-suggest" aria-label="Suggested gates">
      <h4><Icon name="check" size={13} /> Suggested from your answers</h4>
      <ul className="gate-list">
        {items.map((s) => (
          <li key={s.key} className="gate-card">
            <div className="gate-card-head">
              <span className="gate-then allow">{THEN_BADGE.allow.text}</span>
              <b className="gate-sentence">{gateSentence(s.when, 'allow', nameOf)}</b>
            </div>
            <div className="gate-card-meta">
              <span className="muted-s">You allowed this {s.count} times.</span>
              <span className="gate-card-actions">
                <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => onDismiss(s)}>Dismiss</button>
                <button type="button" className="btn sm" disabled={busy} onClick={() => onAdd(s)}>Add rule</button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Settings -> Gates: sentence rule cards, the Who/What/Where/Then builder, the dry-run tester and the locked
 * rails. Every action saves straight away (the same pattern as Settings -> MCP): the next tool call picks the
 * change up, no restart.
 */
export function GatesSection({ s }: { s: SettingsView }) {
  const agents = useStore((st) => st.agents);
  const projects = useStore((st) => st.projects);
  const tasks = useStore((st) => st.tasks);
  const { view, loadError, reload, apply } = useGatesView();
  const [scope, setScope] = useState(EVERYTHING);
  const presetsAct = useGatesAction(apply);
  const fineAct = useGatesAction(apply);
  const gatesBusy = presetsAct.pending || fineAct.pending;
  // A project that was removed while it was chosen: back to the app default.
  const scopeNow = scope === EVERYTHING || projects.some((p) => p.id === scope) ? scope : EVERYTHING;
  const gates: GatesConfig = s.gates ?? { rules: [], presetsVersion: 0 };
  const rules = gates.rules;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [rmId, setRmId] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<GateSuggestion[]>([]);
  // Learned suggestions are a hint: a failed load shows none and says nothing.
  const loadSuggested = () => { loadGateSuggestions().then(setSuggested, () => setSuggested([])); };
  const learn = gates.learn !== false;
  useEffect(loadSuggested, [rules, learn]);
  const setLearn = async (on: boolean) => {
    setBusy(true); setError(null);
    try { await saveSettings({ gates: { ...gates, learn: on } }); }
    catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  const nameOf = (id: string) => { const a = agents.find((x) => x.id === id); return a ? `${a.emoji} ${a.name}` : id; };
  const projectOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const save = async (next: GateRule[], after?: () => void) => {
    setBusy(true); setError(null);
    try { await saveSettings({ gates: { ...gates, rules: next } }); after?.(); }
    catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  const editing = editId ? rules.find((r) => r.id === editId) : undefined;
  const builderMode: ApprovalMode = (draft.agents[0] ? agents.find((a) => a.id === draft.agents[0])?.approval : agents[0]?.approval) ?? 'ask';

  const startAdd = () => { setDraft(emptyDraft()); setEditId(null); setAdding(true); };
  const commitAdd = () => {
    const when = draftWhen(draft);
    const r: GateRule = { id: newGateId(), enabled: true, then: draft.then, when, label: gateSentence(when, draft.then, nameOf, projectOf), source: 'user' };
    void save([...rules, r], () => setAdding(false));
  };
  const commitEdit = () => {
    if (!editing) return;
    const when = draftWhen(draft);
    void save(rules.map((x) => (x.id === editing.id ? { ...x, when, then: draft.then, label: gateSentence(when, draft.then, nameOf, projectOf) } : x)), () => setEditId(null));
  };
  const addPreset = (i: number) => {
    const r = presetRule(GATE_PRESETS[i]!);
    // A preset keeps its own sentence; only the id is fresh.
    void save([...rules, r]);
  };
  // Same path as the approval card's Remember: reads the stored rules first, so no other rule is lost.
  const addSuggested = async (s: GateSuggestion) => {
    setBusy(true); setError(null);
    try { await rememberGate({ id: newGateId(), enabled: true, then: 'allow', when: s.when, label: gateSentence(s.when, 'allow', nameOf), source: 'card' }); }
    catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  const dismissSuggested = (s: GateSuggestion) => {
    setSuggested((xs) => xs.filter((x) => x.key !== s.key));
    dismissGateSuggestion(s.key).catch((e: unknown) => setError(errText(e)));
  };

  return (
    <div className="set-section">
      {loadError && !view && <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{loadError}</span></div>}
      {view && (
        <>
          <GatesBanner view={view} projects={projects} busy={gatesBusy} run={presetsAct.run} onReloaded={reload} />
          <GatesPresets view={view} scope={scopeNow} setScope={setScope} projects={projects} agents={agents} busy={gatesBusy} note={presetsAct.note} run={presetsAct.run} />
          <PermissionGates view={view} scope={scopeNow} busy={gatesBusy} note={fineAct.note} run={fineAct.run} />
        </>
      )}
      <QaGates />
      <RailsList />
      <div className="gate-head-note" role="note"><b>Mode first, gates on top.</b> Each agent{'\u2019'}s approval mode (agent editor) decides the default. Gates adjust it here for one agent, one command or one project. Block rules apply even to Full; Ask rules never fire there.</div>
      <div className="set-card gate-list-card">
        <h3>Gates</h3>
        {rules.length === 0 && !adding && !editing && <div className="set-empty"><b>No gates yet.</b><span>{GATES_EMPTY}</span></div>}
        {rules.length > 0 && (
          <ul className="gate-list">
            {rules.map((r) => (
              editId === r.id ? (
                <li key={r.id} className="gate-card editing">
                  <GateBuilder draft={draft} setDraft={setDraft} agents={agents} projects={projects} projectOf={projectOf} mode={builderMode}
                    onCancel={() => setEditId(null)} onSave={commitEdit} saveLabel="Save gate" />
                </li>
              ) : (
                <GateRuleCard key={r.id} r={r} nameOf={nameOf} projectOf={projectOf} hostless={ruleHostless(r.when, agents)} busy={busy}
                  confirmDelete={rmId === r.id}
                  onToggle={(x) => void save(rules.map((y) => (y.id === x.id ? { ...y, enabled: !y.enabled } : y)))}
                  onEdit={(x) => { setDraft(toDraft(x)); setEditId(x.id); setAdding(false); setRmId(null); }}
                  onDelete={(x) => { if (rmId === x.id) void save(rules.filter((y) => y.id !== x.id), () => setRmId(null)); else setRmId(x.id); }}
                  onCancelDelete={() => setRmId(null)} />
              )
            ))}
          </ul>
        )}
        {adding && (
          <GateBuilder draft={draft} setDraft={setDraft} agents={agents} projects={projects} projectOf={projectOf} mode={builderMode}
            onCancel={() => setAdding(false)} onSave={commitAdd} saveLabel="Add gate" />
        )}
        {!adding && !editing && (
          <div className="set-actions">
            {GATE_PRESETS.map((p, i) => (
              <button key={p.id} type="button" className="btn-ghost" disabled={busy} title={p.label} onClick={() => addPreset(i)}><Icon name="plus" size={12} /> {p.title}</button>
            ))}
            <button type="button" className="btn" onClick={() => startAdd()}><Icon name="plus" size={13} /> New gate</button>
          </div>
        )}
        {error && <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{error}</span></div>}
      </div>
      <label className="set-check gate-learn">
        <input type="checkbox" aria-label="Suggest gates from my answers" checked={learn} disabled={busy}
          onChange={() => void setLearn(!learn)} />
        <span>Suggest gates from my answers <span className="muted-s">After you allow the same kind of call {SUGGEST_AFTER} times, it is offered here as a gate. Off keeps no record of your answers.</span></span>
      </label>
      <GateSuggestions items={learn ? suggested : []} nameOf={nameOf} busy={busy} onAdd={(x) => void addSuggested(x)} onDismiss={dismissSuggested} />
      <GateTester rules={rules} agents={agents} />
      <ActivityView projects={projects} tasks={tasks} />
    </div>
  );
}
