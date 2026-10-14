/** Where the pre-drawn taskbar number icons live and how they map to Windows display scales. Pure; the drawing script uses the same table. */
export const OVERLAY_SIZES: ReadonlyArray<{ px: number; scale: number }> = [
  { px: 16, scale: 1 },
  { px: 20, scale: 1.25 },
  { px: 24, scale: 1.5 },
];
export const overlayFile = (key: string, px: number): string => `overlay-${key}-${px}.png`;
