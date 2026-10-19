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
import { nativeTaskListOn } from '../../../src/shared/task-list-setting';
import { agentGithubLevel } from '../../../src/shared/github-area';
import type { GithubLevel } from '../../../src/shared/github-area';
import { accessPatch } from '../github/agentAccess';
import { useArea } from '../github/useArea';
import { GithubAccess } from '../github/GithubAccess';
import { APPROVAL_CHOICES, CHOICE_HELP, SEED_TAG, agentProjectLines, approvalPatch, choiceOf, mayRaiseMode, seedWords, type ApprovalChoice } from '../gates/agentFollowLogic';
import { PENDING_TEXT, useGatesView } from '../gates/useGatesView';

export function AgentEditor({ id, focus }: { id: string | null; focus?: 'skills' }) {
  const existing = useStore((s) => s.agents.find((a) => a.id === id));
  const [name, setName] = useState(existing?.name ?? '');
  const [emoji, setEmoji] = useState(existing?.emoji ?? '✦');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(existing?.systemPrompt ?? '');
  const [model, setModel] = useState<ModelChoice>(existing?.model ?? 'auto');
  // A new agent starts on Follow project; a saved agent shows what it has. Only a change here is sent on save (approvalPatch).
  const [choice, setChoice] = useState<ApprovalChoice>(() => choiceOf(existing));
  // the mode the agent keeps as its own: what it was saved with, or Ask. Following a project leaves it where it was.
  const approval: ApprovalMode = choice === 'project' ? (existing?.approval ?? 'ask') : choice;
  const projects = useStore((s) => s.projects);
  const gatesView = useGatesView().view;
  const followLines = agentProjectLines({ id, approval, source: choice === 'project' ? 'project' : 'own' }, projects, gatesView);
  const [vmOn, setVmOn] = useState(existing?.vm.enabled ?? false);
  const [size, setSize] = useState<VmSize>(existing?.vm.size ?? 'default');
  const [idle, setIdle] = useState(existing?.vm.idleStopMinutes ?? 15);
  const [ghLevel, setGhLevel] = useState<GithubLevel>(() => agentGithubLevel(existing ?? {}));
  const [ghRepos, setGhRepos] = useState<string[]>(() => existing?.githubWrite ?? []);
  const [area, retryArea] = useArea();
  const github = ghLevel !== 'none';
  const [hostOn, setHostOn] = useState(existing?.host?.enabled ?? false);
  const [hostRoot, setHostRoot] = useState(existing?.host?.rootDir ?? '');
  const [hostTimeout, setHostTimeout] = useState(existing?.host?.timeoutSeconds === undefined ? '' : String(existing.host.timeoutSeconds));
  const [hostEnv, setHostEnv] = useState<'allow' | 'masked' | 'block'>(existing?.host?.envFiles ?? 'masked');
  const [skills, setSkills] = useState(() => valueOf(existing?.skills));
  // shown as the effective setting; saved only once the owner changes it, so an untouched agent keeps following the default
  const [taskList, setTaskList] = useState(() => nativeTaskListOn(existing ?? { id: '' }));
  const startTaskList = useRef(taskList);
  const skillsTooMany = skills.mode === 'choose' && skills.ids.length > MAX_AGENT_SKILLS;
  // Leaving (Esc, the X, a click outside, or "Open in the Armory") must not throw away a Skills choice that was not saved without asking.
  const startSkills = useRef(settingOf(valueOf(existing?.skills)));
  const nowSkills = settingOf(skills);
  const skillsDirty = JSON.stringify(Array.isArray(nowSkills) ? [...nowSkills].sort() : nowSkills) !== JSON.stringify(Array.isArray(startSkills.current) ? [...startSkills.current].sort() : startSkills.current);
  // Every field counts, not only Skills: the first values are kept, and anything that differs from them asks before it is thrown away.
  const fields = JSON.stringify([name, emoji, description, systemPrompt, model, choice, vmOn, size, idle, ghLevel, ghRepos, hostOn, hostRoot, hostTimeout, hostEnv, taskList]);
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
  const known = [...grouped.current, ...grouped.older].some((m) => m.value === model) || model === 'auto' || provGroups.some((g) => g.models.some((m) => `${g.id}:${m}` === model));
  const desc = model === 'auto' ? AUTO_INFO : opts.find((m) => m.value === model)?.description;
  const trial = useStore((s) => s.boatHealth?.trial.limited === true);
  const sizeNote = size === 'default'
    ? 'Default works on every boat.dev plan. Changes apply the next time the VM is started.'
    : trial
      ? `Your boat.dev account is on a free trial, which does not allow ${size === 'large' ? 'Large' : 'this size'}. Legion will use Default and tell you.`
      : 'Bigger sizes need a paid boat.dev plan. On a free trial Legion falls back to Default and tells you.';
  const [busy, setBusy] = useState(false);
  // set while the app's native question about asking less can be open
  const [waiting, setWaiting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy || skillsTooMany) return;
    setBusy(true);
    setWaiting(!!window.legion?.agentModeChange && mayRaiseMode(existing, choice, projects, gatesView));
    // The timeout field holds what the owner typed; round and clamp it the same range the server enforces (1..3600).
    const secs = hostTimeout.trim() === '' ? undefined : Math.min(3600, Math.max(1, Math.round(Number(hostTimeout.trim())) || 120));
    const body: Omit<Partial<AgentProfile>, 'taskList'> & { name: string; taskList?: 'on' | 'off' | null } = {
      name: name.trim(), emoji: emoji.trim() || '●', description: description.trim(), systemPrompt, model, ...approvalPatch(existing, choice), ...accessPatch(ghLevel, ghRepos), skills: settingOf(skills),
      vm: { enabled: vmOn, size, idleStopMinutes: Math.max(1, Math.round(idle) || 15) },
      // Absent host = off; a present host always says so explicitly (server.ts parseHost requires `enabled`).
      host: hostOn
        ? { enabled: true, ...(hostRoot.trim() ? { rootDir: hostRoot.trim() } : {}), ...(secs !== undefined ? { timeoutSeconds: secs } : {}), ...(hostEnv !== 'masked' ? { envFiles: hostEnv } : {}) }
        : { enabled: false },
      // changed back to what the default gives: clear the explicit choice (null), so the agent follows the default again
      ...(taskList !== startTaskList.current ? { taskList: taskList === nativeTaskListOn({ id: existing?.id ?? '' }) ? null : taskList ? 'on' as const : 'off' as const } : {}),
    };
    await saveAgent(id, body);
    setWaiting(false);
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
              <optgroup label={grouped.older.length ? 'Current models' : 'Models'}>{grouped.current.map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}</optgroup>
              {grouped.older.length > 0 && <optgroup label="Older models">{grouped.older.map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}</optgroup>}
              {provGroups.map((g) => <optgroup key={g.id} label={`${g.label} (not Claude)`}>{g.models.map((m) => <option key={`${g.id}:${m}`} value={`${g.id}:${m}`}>{m}</option>)}</optgroup>)}
            </select>
            {onProvider && <span className="field-note">Runs outside Claude, on {provView?.providers.find((x) => model.startsWith(x.id + ':'))?.label ?? 'a provider'}: Legion's tools and your MCP servers only, no built-in file, shell or web tools. See Settings, Providers.</span>}
            <span className="field-note">{desc}{fallback && catalog?.error ? ' Couldn\u2019t load the full model list from Claude Code.' : ''}</span>
          </label>
          <label className="grow">Approvals
            <select value={choice} onChange={(e) => setChoice(e.target.value as ApprovalChoice)}>
              {APPROVAL_CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <span className="field-note">{CHOICE_HELP[choice]}</span>
            {followLines && <span className="field-note" role="status">{followLines}</span>}
            {choice === choiceOf(existing) && seedWords(existing) && <span className="field-note seed-note" data-testid="seed-note"><span className="chip-pill">{SEED_TAG}</span> {seedWords(existing).slice(SEED_TAG.length + 2)}</span>}
            {waiting && <span className="field-note" role="status">{PENDING_TEXT}</span>}
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
          <GithubAccess level={ghLevel} onLevel={setGhLevel} repos={ghRepos} onRepos={setGhRepos} area={area} onRetry={retryArea} />
          {connectorsShellWarning({ connectors: github, approval, onProvider, vmOn }) && <p className="field-note" role="alert"><b>Warning.</b> {connectorsShellWarning({ connectors: github, approval, onProvider, vmOn })}</p>}
        </fieldset>
        <fieldset>
          <legend>Task list</legend>
          <label className="check-row"><input type="checkbox" checked={taskList} onChange={(e) => setTaskList(e.target.checked)} /> Keep a task list on Claude (Claude Code's own task tools)</label>
          <span className="field-note">On by default for the lead. Newer Claude models plan without a written list; turn this on for agents that run long, multi-step work. Runs on other providers always have a task list.</span>
        </fieldset>
        <fieldset>
          <legend>Shell (your computer)</legend>
          <label className="check-row"><input type="checkbox" checked={hostOn} onChange={(e) => setHostOn(e.target.checked)} /> Let this agent run commands and read/write files on your computer</label>
          <span className="field-note">Off by default. When on, the agent gets its own shell inside the scope root below. Its approval mode still decides whether each call asks you, and Gates (Settings, Gates) refine when it asks. This switch decides whether the agent gets the tools at all.</span>
          <div className="row" style={{ opacity: hostOn ? 1 : 0.5 }}>
            <label className="grow">Scope root<input disabled={!hostOn} value={hostRoot} onChange={(e) => setHostRoot(e.target.value)} placeholder="Leave empty for this agent’s own workspace folder" spellCheck={false} /></label>
            <label className="grow">Command timeout (s)<input disabled={!hostOn} type="number" min={1} max={3600} value={hostTimeout} placeholder="120" onChange={(e) => setHostTimeout(e.target.value.replace(/[^\d]/g, ''))} /><span className="field-note">A command killed after this many seconds. 1 to 3600; 120 by default.</span></label>
          </div>
          <label style={{ opacity: hostOn ? 1 : 0.5 }}>.env files
            <select disabled={!hostOn} value={hostEnv} onChange={(e) => setHostEnv(e.target.value as 'allow' | 'masked' | 'block')}>
              <option value="masked">Masked: names shown, values hidden, no writes</option>
              <option value="block">Blocked: no reading, writing or commands that name one</option>
              <option value="allow">Allowed: read and write as written</option>
            </select>
            <span className="field-note">Masked hides every value from all of this agent's tool output. .env.example and other templates are ordinary files.</span>
          </label>
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
