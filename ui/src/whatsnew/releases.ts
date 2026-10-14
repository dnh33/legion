/**
 * What's new tips, declared per release as data. A release with no entry here shows nothing after its update.
 * `anchor` is a CSS selector for a `data-tip` attribute on the element the tip explains; a tip whose anchor is not on
 * screen waits until its view opens (or is left out). Plain English, no em dashes.
 */
export type TipPlacement = 'top' | 'bottom' | 'left' | 'right';
export interface Tip { id: string; anchor: string; text: string; placement: TipPlacement }
export interface Release { version: string; tips: Tip[] }

export const RELEASES: Release[] = [
  {
    version: '0.3.0',
    tips: [
      { id: 'project-tabs', anchor: '[data-tip="project-tabs"]', placement: 'bottom', text: 'Your project now has its own page. Overview, Board, Tasks, Rooms and Settings are tabs here.' },
      { id: 'allow-hold', anchor: '[data-tip="allow-button"]', placement: 'top', text: 'Allow now waits a few seconds. Press Undo if you tapped it by mistake.' },
      { id: 'project-away', anchor: '[data-tip="project-away"]', placement: 'bottom', text: 'Choose what happens while you are away: pause, a budget, and notifications.' },
      { id: 'app-notifications', anchor: '[data-tip="settings-notifications"]', placement: 'bottom', text: 'Legion can notify you and mark the taskbar. Set quiet hours here.' },
      { id: 'spending', anchor: '[data-tip="settings-spending"]', placement: 'bottom', text: 'See what your agents spent, by project.' },
    ],
  },
];

export function tipsFor(version: string): Tip[] {
  return RELEASES.find((r) => r.version === version)?.tips ?? [];
}
