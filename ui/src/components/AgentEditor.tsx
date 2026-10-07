import { useEffect, useRef, useState } from 'react';
import type { AgentProfile, ApprovalMode, ModelChoice, VmSize } from '../../../src/shared/types';
import { AUTO_INFO, groupModels, modelList } from '../models';
import { closeOverlays, loadCatalog, openSettings, removeAgent, saveAgent, useStore } from '../store';
import { providerModelGroups, loadProviders, useProviders } from '../providers/providersStore';
import { Modal } from './Modal';
import { AgentSkills, settingOf, valueOf } from '../armory/AgentSkills';
import { MAX_AGENT_SKILLS } from '../../../src/shared/armory-view';
import { revealSkill } from '../armory/armoryStore';
import { connectorsShellWarning } from '../../../src/shared/connectors-view';

export function AgentEditor({ id, focus }: { id: string | null; focus?: 'skills' }) {
  const existing = useStore((s) => s.agents.find((a) => a.id === id));
  const [name, setName] = useState(existing?.name ?? '');
  const [emoji, setEmoji] = useState(existing?.emoji ?? '✦');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(existing?.systemPrompt ?? '');
  const [model, setModel] = useState<ModelChoice>(existing?.model ?? 'auto');
  const [approval, setApproval] = useState<ApprovalMode>(existing?.approval ?? 'ask');
  const [vmOn, setVmOn] = useState(existing?.vm.enabled ?? false);
  const [size, setSize] = useState<VmSize>(existing?.vm.size ?? 'default');
  const [idle, setIdle] = useState(existing?.vm.idleStopMinutes ?? 15);
  const [github, setGithub] = useState(existing?.connectors?.includes('github') ?? false);
  const [skills, setSkills] = useState(() => valueOf(existing?.skills));
  const skillsTooMany = skills.mode === 'choose' && skills.ids.length > MAX_AGENT_SKILLS;
  // Leaving (Esc, the X, a click outside, or "Open in the Armory") must not throw away a Skills choice that was not saved without asking.
  const startSkills = useRef(settingOf(valueOf(existing?.skills)));
  const nowSkills = settingOf(skills);
  const skillsDirty = JSON.stringify(Array.isArray(nowSkills) ? [...nowSkills].sort() : nowSkills) !== JSON.stringify(Array.isArray(startSkills.current) ? [...startSkills.current].sort() : startSkills.current);
  // Every field counts, not only Skills: the first values are kept, and anything that differs from them asks before it is thrown away.
  const fields = JSON.stringify([name, emoji, description, systemPrompt, model, approval, vmOn, size, idle, github]);
  const startFields = useRef(fields);
  const dirty = skillsDirty || fields !== startFields.current;
  const [leaving, setLeaving] = useState<null | { to: 'close' } | { to: 'armory'; skill: string }>(null);
  const keepBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (leaving) keepBtn.current?.focus(); }, [leaving]);
  const openArmory = (skill: string): void => { revealSkill(skill); openSettings('armory'); };
  const requestClose = (): void => {
    if (leaving) { setLeaving(null); return; }
    if (dirty) setLeaving({ to: 'close' }); else closeOverlays();
  };
  // "Choose skills for Marshal" lands on the Skills section, not on the name field.
  useEffect(() => {
    if (focus !== 'skills') return;
    const el = document.querySelector<HTMLElement>('[data-skills-focus]');
    el?.scrollIntoView?.({ block: 'center' });
    el?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const catalog = useStore((s) => s.catalog);
  useEffect(() => { if (!catalog) void loadCatalog(); void loadProviders(); }, []);
  const provView = useProviders((x) => x.view);
  const provGroups = providerModelGroups(provView);
  const onProvider = /^[a-z][a-z0-9-]{1,31}:./.test(model) && !model.startsWith('arn:');
  const { models, fallback } = modelList(catalog);
  const grouped = groupModels(catalog);
  const opts = models.some((m) => m.value === model) || model === 'auto' ? models : [...models, { value: model, displayName: model, description: '' }];
  const known = [...grouped.current, ...grouped.more].some((m) => m.value === model) || model === 'auto' || provGroups.some((g) => g.models.some((m) => `${g.id}:${m}` === model));
  const desc = model === 'auto' ? AUTO_INFO : opts.find((m) => m.value === model)?.description;
  const trial = useStore((s) => s.boatHealth?.trial.limited === true);
  const sizeNote = size === 'default'
    ? 'Default works on every boat.dev plan. Changes apply the next time the VM is started.'
    : trial
      ? `Your boat.dev account is on a free trial, which does not allow ${size === 'large' ? 'Large' : 'this size'}. Legion will use Default and tell you.`
      : 'Bigger sizes need a paid boat.dev plan. On a free trial Legion falls back to Default and tells you.';
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy || skillsTooMany) return;
    setBusy(true);
    const body: Partial<AgentProfile> & { name: string } = {
      name: name.trim(), emoji: emoji.trim() || '●', description: description.trim(), systemPrompt, model, approval, connectors: github ? ['github'] : [], skills: settingOf(skills),
      vm: { enabled: vmOn, size, idleStopMinutes: Math.max(1, Math.round(idle) || 15) },
    };
    await saveAgent(id, body);
    setBusy(false);
  };

  return (
    <Modal title={id ? `Edit ${existing?.name ?? 'agent'}` : 'New agent'} width={600} onClose={requestClose}
      footer={<>
        {id && id !== 'zealot' && (confirmDel
          ? <><span className="muted-s">Delete this agent?</span><button className="btn danger" onClick={() => void removeAgent(id)}>Yes, delete</button><button className="btn-ghost" onClick={() => setConfirmDel(false)}>No</button></>
          : <button className="btn-ghost danger" onClick={() => setConfirmDel(true)}>Delete</button>)}
        <span className="spacer" />
        <button type="button" className="btn-ghost" onClick={requestClose}>Cancel</button>
        <button className="btn primary" onClick={() => void submit()} disabled={!name.trim() || busy || skillsTooMany}>{id ? 'Save' : 'Create agent'}</button>
      </>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="row">
          <label className="f-emoji">Emoji<input value={emoji} maxLength={4} onChange={(e) => setEmoji(e.target.value)} /></label>
          <label className="grow">Name<input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Researcher" /></label>
        </div>
        <label>Description<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line: what this agent is for" /></label>
        <label>System prompt<textarea rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="Appended to Claude Code’s system prompt." /></label>
        <div className="row">
          <label className="grow">Model
            <select value={model} onChange={(e) => setModel(e.target.value as ModelChoice)}>
              <option value="auto">Auto {'\u00b7'} Sonnet or Opus per task</option>
              {!known && <option value={model}>{model}</option>}
              <optgroup label={grouped.more.length ? 'Current models' : 'Models'}>{grouped.current.map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}</optgroup>
              {grouped.more.length > 0 && <optgroup label="More models">{grouped.more.map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}</optgroup>}
              {provGroups.map((g) => <optgroup key={g.id} label={`${g.label} (not Claude)`}>{g.models.map((m) => <option key={`${g.id}:${m}`} value={`${g.id}:${m}`}>{m}</option>)}</optgroup>)}
            </select>
            {onProvider && <span className="field-note">Runs outside Claude, on {provView?.providers.find((x) => model.startsWith(x.id + ':'))?.label ?? 'a provider'}: Legion's tools and your MCP servers only, no built-in file, shell or web tools. See Settings, Providers.</span>}
            <span className="field-note">{desc}{fallback && catalog?.error ? ' Couldn\u2019t load the full model list from Claude Code.' : ''}</span>
          </label>
          <label className="grow">Approvals
            <select value={approval} onChange={(e) => setApproval(e.target.value as ApprovalMode)}>
              <option value="ask">Ask before Bash, edits, MCP</option><option value="auto-edits">Allow edits, ask for Bash/MCP</option><option value="full">Full access, never ask</option>
            </select>
          </label>
        </div>
        <AgentSkills agentId={id} agentName={name} value={skills} onChange={setSkills}
          onOpenArmory={(sid) => { if (skillsDirty) setLeaving({ to: 'armory', skill: sid }); else openArmory(sid); }} />
        {leaving ? (
          <div className="arm-discard" role="alertdialog" aria-label="Unsaved changes">
            <span>{leaving.to === 'close' ? 'Throw away your changes? They are not saved.' : 'Open the Armory and throw away your Skills choice? It is not saved.'}</span>
            <button type="button" className="btn sm danger" onClick={() => { if (leaving.to === 'close') closeOverlays(); else openArmory(leaving.skill); }}>Discard</button>
            <button ref={keepBtn} type="button" className="btn sm" onClick={() => setLeaving(null)}>Keep editing</button>
          </div>
        ) : null}
        <fieldset>
          <legend>Connectors</legend>
          <label className="check-row"><input type="checkbox" checked={github} onChange={(e) => setGithub(e.target.checked)} /> Let this agent read GitHub (repositories, issues, pull requests, CI)</label>
          <span className="field-note">Read only. Connect GitHub first in Settings, GitHub. A run started from Claude Code or another MCP client never gets connectors.</span>
          {connectorsShellWarning({ connectors: github, approval, onProvider, vmOn }) && <p className="field-note" role="alert"><b>Warning.</b> {connectorsShellWarning({ connectors: github, approval, onProvider, vmOn })}</p>}
        </fieldset>
        <fieldset>
          <legend>Computer (boat.dev VM)</legend>
          <label className="check-row"><input type="checkbox" checked={vmOn} onChange={(e) => setVmOn(e.target.checked)} /> Let this agent start a VM on demand</label>
          <div className="row" style={{ opacity: vmOn ? 1 : 0.5 }}>
            <label className="grow">Size
              <select disabled={!vmOn} value={size} onChange={(e) => setSize(e.target.value as VmSize)} aria-describedby="vm-size-note">
                <option value="small">Small</option><option value="default">Default (works on every plan)</option><option value="large">Large (paid plan)</option>
              </select>
              <span className="field-note" id="vm-size-note">{sizeNote}</span>
            </label>
            <label className="grow">Stop after idle (min)<input disabled={!vmOn} type="number" min={1} value={idle} onChange={(e) => setIdle(Number(e.target.value))} /></label>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
