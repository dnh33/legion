import { useEffect, useState } from 'react';
import { initBlender } from './blender/blenderStore';
import { EnableBlenderDialog } from './blender/EnableBlenderDialog';
import { initBsv } from './bsv/bsvStore';
import { ChainOverlay } from './bsv/ChainOverlay';
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
import { initLibrary } from './library/libraryStore';
import { LibraryView } from './library/LibraryView';
import { ProjectView } from './projects/ProjectView';
import { initProjects } from './projects/projectsStore';
import { RoomsView } from './rooms/RoomsView';
import { initRooms } from './rooms/roomsStore';
import {
  closeOverlays, closeSettings, getState, init, newTask, openPalette, switchAgentByIndex, toggleMascotLab, toggleOps, toggleSettings, useStore,
} from './store';

/** Ops-panel slide (app.css `.app` grid transition is 180 ms): keep the panel mounted until it has slid out. */
const OPS_SLIDE_MS = 220;

/**
 * True while the Ops panel is open and for one slide after it closes. A closed Ops panel is a 0 px column: nothing in it
 * is visible, so nothing in it should run (the mascot stage, its timers, the VM screenshot poll).
 */
function useOpsMounted(opsOpen: boolean): boolean {
  const [mounted, setMounted] = useState(opsOpen);
  useEffect(() => {
    if (opsOpen) { setMounted(true); return; }
    const t = window.setTimeout(() => setMounted(false), OPS_SLIDE_MS);
    return () => clearTimeout(t);
  }, [opsOpen]);
  return opsOpen || mounted;
}

/**
 * Marks the document `data-win="away"` while the window is hidden or unfocused. Purely ambient CSS animations (the BSV chain line)
 * pause on it: each of their frames is a compositor draw for the whole window, and nobody is looking.
 */
function useWindowAway() {
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => { if (document.hidden || !document.hasFocus()) root.dataset.win = 'away'; else delete root.dataset.win; };
    sync();
    window.addEventListener('blur', sync); window.addEventListener('focus', sync); document.addEventListener('visibilitychange', sync);
    return () => { window.removeEventListener('blur', sync); window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); delete root.dataset.win; };
  }, []);
}

export function App() {
  const opsOpen = useStore((s) => s.opsOpen);
  const palette = useStore((s) => s.palette);
  const doctorOpen = useStore((s) => s.doctorOpen);
  const editor = useStore((s) => s.editor);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const view = useStore((s) => s.view);
  const opsMounted = useOpsMounted(opsOpen);
  useWindowAway();

  useEffect(() => { init(); initRooms(); initBsv(); initBlender(); initLibrary(); initProjects(); }, []);
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
      <main className="center">
        {settingsOpen ? <SettingsPanel /> : (
          <>
            {view === 'chat' && <><Thread /><Composer /></>}
            {view === 'rooms' && <RoomsView />}
            {view === 'graph' && <LibraryView />}
            {view === 'project' && <ProjectView />}
          </>
        )}
      </main>
      <div className="ops-slot" aria-hidden={!opsOpen}>{opsMounted && <OpsPanel />}</div>
      {palette && <CommandPalette />}
      {doctorOpen && <DoctorModal />}
      {editor && <AgentEditor key={editor.id ?? 'new'} id={editor.id} />}
      <TaskMenu />
      <Toasts />
      <ChainOverlay />
      <EnableBlenderDialog />
    </div>
  );
}
