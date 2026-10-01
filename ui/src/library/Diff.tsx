import { collapseDiff, diffChanged, diffStats, lineDiff } from '../../../src/shared/kg-library';
import type { KgNode } from '../../../src/shared/kg';

/** Before/after of an edit proposal: title, tags and body. Additions are blue and removals red: green stays for selection. */
export function EditDiff({ before, after }: { before: KgNode; after: KgNode }) {
  const lines = collapseDiff(lineDiff(before.body, after.body), 2);
  const bodyChanged = diffChanged(lineDiff(before.body, after.body));
  const st = diffStats(lineDiff(before.body, after.body));
  const addedTags = after.tags.filter((t) => !before.tags.includes(t));
  const removedTags = before.tags.filter((t) => !after.tags.includes(t));
  const titleChanged = before.title !== after.title;
  const nothing = !bodyChanged && !titleChanged && !addedTags.length && !removedTags.length;
  return (
    <div className="lib-diff" aria-label={`Changes to ${before.title}`}>
      <div className="lib-diff-head">
        <span>Replaces <b>{before.title}</b></span>
        <span className="lib-diff-stat"><i className="add">+{st.added}</i> <i className="del">−{st.removed}</i> lines</span>
      </div>
      {titleChanged && (
        <div className="lib-diff-title">
          <div className="del"><span aria-hidden="true">−</span><span className="sr">Removed: </span>{before.title}</div>
          <div className="add"><span aria-hidden="true">+</span><span className="sr">Added: </span>{after.title}</div>
        </div>
      )}
      {(addedTags.length > 0 || removedTags.length > 0) && (
        <div className="lib-diff-tags">
          {removedTags.map((t) => <span key={`d${t}`} className="del">−#{t}</span>)}
          {addedTags.map((t) => <span key={`a${t}`} className="add">+#{t}</span>)}
        </div>
      )}
      {bodyChanged && (
        <pre className="lib-diff-body" tabIndex={0}>
          {lines.map((l, i) => l.kind === 'skip'
            ? <span key={i} className="skip">{`… ${l.count} unchanged line${l.count === 1 ? '' : 's'}`}{'\n'}</span>
            : <span key={i} className={l.kind}><span className="mark" aria-hidden="true">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>{l.text}{'\n'}</span>)}
        </pre>
      )}
      {nothing && <p className="lib-faint lib-diff-none">Same text as the note it replaces.</p>}
    </div>
  );
}
