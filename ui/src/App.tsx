import { useEffect } from 'react';
import { AgentEditor } from './components/AgentEditor';
import { AgentRail } from './components/AgentRail';
import { CommandPalette } from './components/CommandPalette';
import { Composer } from './components/Composer';
import { DoctorModal } from './components/DoctorModal';
import { OpsPanel } from './components/OpsPanel';
import { SettingsPanel } from './components/Settings';
import { TaskMenu } from './components/TaskMenu';
import { Thread } from './components/Thread';
import { TitleBar } from './components/TitleBar';
import { Toasts } from './components/Toasts';
import {
  closeOverlays, closeSettings, getState, init, newTask, openPalette, switchAgentByIndex, toggleMascotLab, toggleOps, toggleSettings, useStore,
} from './store';

export function App() {
  const opsOpen = useStore((s) => s.opsOpen);
  const palette = useStore((s) => s.palette);
  const doctorOpen = useStore((s) => s.doctorOpen);
  const editor = useStore((s) => s.editor);
  const settingsOpen = useStore((s) => s.settingsOpen);

  useEffect(() => { init(); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); toggleMascotLab(); return; }
      if (mod && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); getState().palette ? closeOverlays() : openPalette(); }
      else if (mod && !e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newTask(); }
      else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); window.dispatchEvent(new Event('legion:model-picker')); }
      else if (mod && e.key === ',') { e.preventDefault(); toggleSettings(); }
      else if (mod && e.key === '.') { e.preventDefault(); toggleOps(); }
      else if (e.key === 'Escape') { const s = getState(); if (s.palette || s.doctorOpen || s.editor) { e.preventDefault(); closeOverlays(); } else if (s.settingsOpen && !(e.target as HTMLElement)?.closest?.('input, textarea, select')) { e.preventDefault(); closeSettings(); } }
      else if (e.altKey && !mod && /^[1-9]$/.test(e.key)) { e.preventDefault(); switchAgentByIndex(Number(e.key) - 1); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  return (
    <div className={`app${opsOpen ? '' : ' ops-closed'}`}>
      <TitleBar />
      <AgentRail />
      <main className="center">{settingsOpen ? <SettingsPanel /> : <><Thread /><Composer /></>}</main>
      <div className="ops-slot" aria-hidden={!opsOpen}><OpsPanel /></div>
      {palette && <CommandPalette />}
      {doctorOpen && <DoctorModal />}
      {editor && <AgentEditor key={editor.id ?? 'new'} id={editor.id} />}
      <TaskMenu />
      <Toasts />
    </div>
  );
}
