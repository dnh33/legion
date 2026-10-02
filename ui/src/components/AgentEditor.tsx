import { useEffect, useState } from 'react';
import type { AgentProfile, ApprovalMode, ModelChoice, VmSize } from '../../../src/shared/types';
import { AUTO_INFO, groupModels, modelList } from '../models';
import { loadCatalog, removeAgent, saveAgent, useStore } from '../store';
import { providerModelGroups, loadProviders, useProviders } from '../providers/providersStore';
import { Modal } from './Modal';

export function AgentEditor({ id }: { id: string | null }) {
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
    if (!name.trim() || busy) return;
    setBusy(true);
    const body: Partial<AgentProfile> & { name: string } = {
      name: name.trim(), emoji: emoji.trim() || '●', description: description.trim(), systemPrompt, model, approval,
      vm: { enabled: vmOn, size, idleStopMinutes: Math.max(1, Math.round(idle) || 15) },
    };
    await saveAgent(id, body);
    setBusy(false);
  };

  return (
    <Modal title={id ? `Edit ${existing?.name ?? 'agent'}` : 'New agent'} width={600}
      footer={<>
        {id && id !== 'zealot' && (confirmDel
          ? <><span className="muted-s">Delete this agent?</span><button className="btn danger" onClick={() => void removeAgent(id)}>Yes, delete</button><button className="btn-ghost" onClick={() => setConfirmDel(false)}>No</button></>
          : <button className="btn-ghost danger" onClick={() => setConfirmDel(true)}>Delete</button>)}
        <span className="spacer" />
        <button className="btn primary" onClick={() => void submit()} disabled={!name.trim() || busy}>{id ? 'Save' : 'Create agent'}</button>
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
