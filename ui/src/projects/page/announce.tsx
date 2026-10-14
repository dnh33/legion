/** One polite live region for the page: answers, holds, restores and queue changes are announced here (spec 8). */
import { useEffect, useState } from 'react';

let push: ((m: string) => void) | null = null;
export function announce(message: string): void { push?.(message); }

export function LiveRegion() {
  const [text, setText] = useState('');
  useEffect(() => {
    push = (m) => { setText(''); window.setTimeout(() => setText(m), 30); };
    return () => { push = null; };
  }, []);
  return <div className="pg-sr" role="status" aria-live="polite" aria-atomic="true">{text}</div>;
}
