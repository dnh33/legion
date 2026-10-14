import { useCallback, useEffect, useState } from 'react';
import { loadArea } from './areaApi';
import { AREA_LOADING } from './areaState';
import type { AreaState } from './areaState';

/** The GitHub area list with its loading and error states; `retry` asks again. */
export function useArea(): [AreaState, () => void] {
  const [area, setArea] = useState<AreaState>(AREA_LOADING);
  const [n, setN] = useState(0);
  useEffect(() => { let live = true; setArea(AREA_LOADING); void loadArea().then((a) => { if (live) setArea(a); }); return () => { live = false; }; }, [n]);
  return [area, useCallback(() => setN((x) => x + 1), [])];
}
