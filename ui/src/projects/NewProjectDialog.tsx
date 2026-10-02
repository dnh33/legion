import { useState } from 'react';
import { PROJECT_LIMITS } from '../../../src/shared/projects';
import { Modal } from '../components/Modal';
import { toast, useStore } from '../store';
import { changeMembers, createProject, openProject } from './projectsStore';
import { instructionsCounter } from './projectsLogic';
import './projects.css';

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const nameOk = name.trim().length > 0 && name.trim().length <= PROJECT_LIMITS.nameChars;
  const counter = instructionsCounter(instructions);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= PROJECT_LIMITS.members ? p : [...p, id]));

  const submit = async () => {
    if (!nameOk || busy) return;
    setBusy(true); setErr('');
    try {
      const p = await createProject(name.trim(), instructions);
      onClose();
      openProject(p.id);
      // members widen what agents can reach, so they go through the app's own confirmation (a native dialog)
      if (picked.length) {
        const ok = await changeMembers(p.id, picked);
        if (!ok) toast('The project was created without members. Add them from its page.', 'info');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="New project" width={600} onClose={onClose}
      footer={<>
        <span className="muted-s" role="status">{nameOk ? '' : name.trim().length > PROJECT_LIMITS.nameChars ? `The name is limited to ${PROJECT_LIMITS.nameChars} characters.` : 'Give the project a name.'}</span>
        <span className="spacer" />
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" onClick={() => void submit()} disabled={!nameOk || busy}>Create project</button>
      </>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label>Name<input data-autofocus value={name} maxLength={PROJECT_LIMITS.nameChars} onChange={(e) => setName(e.target.value)} /></label>
        <label>Instructions (optional)
          <textarea value={instructions} rows={6} aria-describedby="np-count" onChange={(e) => setInstructions(e.target.value)} />
          <span className={`field-note${counter.over ? ' proj-over' : ''}`} id="np-count">{counter.label}. Added to every task in this project, after the agent&rsquo;s own instructions. They never change what an agent is allowed to do.</span>
        </label>
        <fieldset>
          <legend>Members (optional)</legend>
          <ul className="proj-pick">
            {agents.map((a) => (
              <li key={a.id}><label className="proj-check"><input type="checkbox" checked={picked.includes(a.id)} onChange={() => toggle(a.id)} /> <span>{a.emoji} {a.name}</span></label></li>
            ))}
          </ul>
          <span className="field-note">Members can use the project&rsquo;s folder and notes. Legion asks you to confirm in a separate window.</span>
        </fieldset>
        {err && <p className="proj-err" role="alert">{err}</p>}
      </form>
    </Modal>
  );
}
