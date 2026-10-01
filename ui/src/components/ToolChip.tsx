import { useState } from 'react';
import type { ChatMessage } from '../../../src/shared/types';
import { shortTool, toolPreview, tryPretty } from '../util';
import { Icon } from './icons';

export function ToolGroup({ items }: { items: ChatMessage[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const openMsg = items.find((m) => m.id === open);
  return (
    <div className="toolgroup">
      <div className="chips">
        {items.map((m) => (
          <button key={m.id} className={`chip${open === m.id ? ' open' : ''}`} onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id} title={m.text}>
            <Icon name="tool" size={12} />
            <b>{shortTool(m.toolName)}</b>
            <span>{toolPreview(m.text)}</span>
            <Icon name="chevron" size={11} />
          </button>
        ))}
      </div>
      {openMsg && <pre className="chip-detail">{tryPretty(openMsg.text)}</pre>}
    </div>
  );
}
