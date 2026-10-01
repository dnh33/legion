export type MascotState = 'idle' | 'listening' | 'thinking' | 'hacking' | 'awaiting' | 'victory' | 'error' | 'sleeping' | 'annoyed';
export interface MascotLayer { id: string; pivot: number[] | null; z: string; markup: string; alarm?: number[]; flip?: 'none' }
export interface MascotData {
  name: string; crop: number[]; defs: string; layers: MascotLayer[]; codeScroll: number;
  /** head-and-shoulders crop that holds the whole halo at any rotation (data-crop-rail) */
  cropRail?: number[];
  /** anchor of the awaiting "!" badge (data-badge) and of the VM cloud (data-vm) */
  badge?: number[]; vm?: number[];
}
export type VerbStep = { p: 'lean' | 'nod' | 'scan' | 'flutter' | 'flare' | 'wave'; at?: number; dur?: number; [k: string]: unknown };
export interface Verb { id: string; w?: number; cd?: number; when?: 'idle' | 'quip' | 'victory'; noBlink?: number; steps: VerbStep[] }
export interface Persona {
  name: string; tempo?: number; quips: string[]; annoyedQuip?: string;
  haloFlare?: number; haloMotion?: 'spin' | 'swing'; plumeLight?: boolean; plumeSway?: number; sleepPlume?: number;
  /** rail crop for art that declares none (the Relic) */
  cropRail?: number[];
  verbs?: Verb[];
}
export interface MascotHandle {
  el: HTMLDivElement;
  readonly state: MascotState;
  readonly verbs: string[];
  setState(s: MascotState): void;
  setVm(on: boolean): void;
  say(text: string, ms?: number): void;
  trick(name: 'spin' | 'nod' | 'flicker'): void;
  /** plays a persona verb by id; false when the persona has none */
  play(id: string): boolean;
  /** test hook: freeze the motion clock at t seconds and draw that pose; returns the compiled track count */
  motionAt(t: number): number;
  /** how the painted SMIL is driven: compiled tracks on the motion clock, SMIL elements left to the browser, clock rate */
  readonly motion: { tracks: number; native: number; hz: number };
  destroy(): void;
}
export interface MascotOptions {
  quips?: string[]; annoyedQuip?: string; track?: boolean; onPoke?: () => void;
  /** agent-rail performance mode: rail crop, no endless animation while quiet, shared loop, no pokes */
  rail?: boolean;
  /** rail crop with the full stage behaviour (Ops panel busts) */
  railCrop?: boolean;
  cropRail?: number[];
  persona?: Persona;
  /** element whose pointerenter/leave drives the hover lean (the whole rail row) */
  hoverEl?: HTMLElement;
  /** stage motion clock rate in Hz (default STAGE_MOTION_HZ); 0 leaves the art's SMIL to the browser */
  motionHz?: number;
}
export const STATES: MascotState[];
/** elements removed from the painted art at render time; empty it to restore them */
export const HIDE_ELEMENTS: { bust: string; layer: string; selector: string; why: string }[];
export const STAGE_MOTION_HZ: number;
export function createMascot(host: HTMLElement, data: MascotData, opts?: MascotOptions): MascotHandle;
export function runtimeStats(): { items: number; queued: number; frames: number; hidden: boolean; rafPending: boolean };
