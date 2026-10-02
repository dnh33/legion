import { memo, useEffect, useRef, useState } from 'react';
import { markdownToPlainText } from '../chat/plaintext';
import { copyText } from '../util';
import { Icon } from './icons';

/**
 * Micro menu under a finished assistant reply: Copy as Markdown (the message's own source text) or as plain text (what the bubble shows,
 * without Markdown syntax). Always in the DOM so the keyboard reaches it; CSS shows it on hover or focus-within (and always on touch).
 * The "Copied" note is plain text, with no motion. State is local: opening, copying or confirming never re-renders the message list.
 */
export const CopyMenu = memo(function CopyMenu({ text }: { text: string }) {
  const [note, setNote] = useState('');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (kind: 'md' | 'plain') => {
    const ok = await copyText(kind === 'md' ? text : markdownToPlainText(text));
    setNote(ok ? (kind === 'md' ? 'Copied Markdown' : 'Copied text') : 'Copy failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(''), 1800);
  };
  return (
    <div className={`msg-actions${note ? ' noted' : ''}`} role="toolbar" aria-label="Copy this reply">
      <Icon name="copy" size={12} />
      <button type="button" className="ma-btn" aria-label="Copy as Markdown" title="Copy the reply as Markdown (the original source)" onClick={() => void copy('md')}>Markdown</button>
      <button type="button" className="ma-btn" aria-label="Copy as plain text" title="Copy the reply as plain text (no Markdown syntax)" onClick={() => void copy('plain')}>Plain text</button>
      <span className="ma-note" role="status" aria-live="polite">{note}</span>
    </div>
  );
});
