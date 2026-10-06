/** Small controls the Armory rows and dialogs share: the three-state choice and the ⋯ menu. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../components/icons';
import { setSkillState, uniqueLabel, useArmory } from './armoryStore';
import { STATE_OPTIONS } from '../../../src/shared/armory-view';
import type { ArmorySkill } from '../../../src/shared/armory-view';
import '../house/house.css';
import './armory.css';

/**
 * "Agents decide" / "Only when I ask" / "Off" as a real radio group: native inputs, so arrow keys, Tab and screen readers behave
 * the way they do everywhere. A skill that acts on Claude Code itself has no choice: it stays off, and its row says why.
 */
export function StateRadio({ skill, caption, reasonId }: { skill: ArmorySkill; caption?: string; reasonId?: string }) {
  const name = useId();
  const hintBase = useId();
  const switching = useArmory((s) => s.switching.includes(skill.id));
  // "debug (built-in)" and "debug (superpowers)" when two skills share a name, so a screen reader can tell the groups apart.
  const label = useArmory(() => uniqueLabel(skill));
  if (skill.offReason) return <span className="arm-fixed" aria-describedby={reasonId}>Off</span>;
  return (
    <div className={`arm-states${switching ? ' busy' : ''}`} role="radiogroup" aria-label={caption ? `${caption}: ${label}` : `How agents use ${label}`} title={switching ? 'Saving…' : undefined}>
      {STATE_OPTIONS.map((o) => (
        <label key={o.value} className={`arm-state v-${o.value}${skill.state === o.value ? ' on' : ''}`}>
          {/* Never disabled while it saves, and a change meanwhile is queued by the store (the newest wins), so focus and the checked choice always agree. */}
          <input type="radio" name={name} value={o.value} checked={skill.state === o.value} aria-describedby={`${hintBase}-${o.value}`}
            onChange={() => { void setSkillState(skill.id, o.value); }} />
          <span className="arm-statetext">{o.label}</span>
        </label>
      ))}
      {/* The one-line meaning of each choice, outside the labels so it never becomes part of a choice's name. */}
      {STATE_OPTIONS.map((o) => <span key={o.value} id={`${hintBase}-${o.value}`} hidden>{o.hint}</span>)}
    </div>
  );
}

export interface MenuItem { key: string; label: string; run: () => void; danger?: boolean; busy?: boolean }

/**
 * The ⋯ menu. Focus goes to the first item when it opens and back to the button when it closes; Esc, Tab and a click outside close it.
 * An item that opens a dialog hands focus back to the button first, so the dialog returns focus to a button that is still there.
 */
export function RowMenu({ label, items, trigger }: { label: string; items: MenuItem[]; trigger?: { className: string; content: React.ReactNode } }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  // Opens downward; when the menu would run past the bottom of the window (the last rows of a list) it opens upward, so every item stays on screen.
  useLayoutEffect(() => {
    if (!open) { setUp(false); return; }
    const b = box.current?.getBoundingClientRect();
    const t = btn.current?.getBoundingClientRect();
    if (b && t) setUp(b.bottom > window.innerHeight - 8 && t.top - b.height - 4 > 8);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // preventScroll: the menu is already placed (down or up, decided in the layout effect above), so focusing must never scroll the list under it.
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const away = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  if (!items.length) return null;
  const onKey = (e: React.KeyboardEvent): void => {
    const els = Array.from(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus({ preventScroll: true }); return; }
    if (e.key === 'Tab') { setOpen(false); return; }
    const to = e.key === 'ArrowDown' ? (at + 1) % els.length : e.key === 'ArrowUp' ? (at - 1 + els.length) % els.length : e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : -1;
    if (to >= 0) { e.preventDefault(); els[to]?.focus({ preventScroll: true }); }
  };
  return (
    <span className="arm-menuwrap">
      <button ref={btn} type="button" className={trigger?.className ?? 'btn-ghost sm arm-more'} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}>
        {trigger ? trigger.content : <span aria-hidden="true" className="arm-dots">{'⋯'}</span>}
      </button>
      {open ? (
        <div ref={box} id={id} className={`arm-menu${up ? ' up' : ''}`} role="menu" aria-label={label} onKeyDown={onKey}>
          {items.map((it) => (
            <button key={it.key} type="button" role="menuitem" tabIndex={-1} className={`arm-menuitem${it.danger ? ' danger' : ''}`} aria-disabled={it.busy || undefined}
              onClick={() => { if (it.busy) return; btn.current?.focus({ preventScroll: true }); setOpen(false); it.run(); }}>
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

/** A warning or notice line with an icon, for banners that say something is off. */
export function Note({ icon = 'shield', children }: { icon?: string; children: React.ReactNode }) {
  return <p className="arm-note"><Icon name={icon} size={12} /> <span>{children}</span></p>;
}
