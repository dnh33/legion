export type MascotState = 'idle' | 'listening' | 'thinking' | 'hacking' | 'awaiting' | 'victory' | 'error' | 'sleeping' | 'annoyed';
export interface MascotData { name: string; crop: number[]; defs: string; layers: { id: string; pivot: number[] | null; z: string; markup: string }[]; codeScroll: number }
export interface MascotHandle {
  el: HTMLDivElement;
  readonly state: MascotState;
  setState(s: MascotState): void;
  setVm(on: boolean): void;
  say(text: string, ms?: number): void;
  trick(name: 'spin' | 'nod' | 'flicker'): void;
  destroy(): void;
}
export const STATES: MascotState[];
export function createMascot(host: HTMLElement, data: MascotData, opts?: { quips?: string[]; annoyedQuip?: string; track?: boolean; onPoke?: () => void }): MascotHandle;
