import { useEffect, useRef, type ReactNode } from 'react';
import { Modal } from '../components/Modal';

/** components/Modal.tsx (focus trap, focus restore, aria-modal) plus Escape-to-close, which Modal does not do itself. */
export function Dialog({ title, onClose, width = 560, footer, children }: {
  title: string; onClose: () => void; width?: number; footer?: ReactNode; children: ReactNode;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); } };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);
  return <Modal title={title} onClose={onClose} width={width} footer={footer}>{children}</Modal>;
}
