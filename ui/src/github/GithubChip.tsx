import { Icon } from '../components/icons';
import { chipLabel, chipTone } from './areaState';
import { toggleGithub, useGithub } from './githubStore';
import './github.css';

/**
 * Title-bar button for the GitHub area. The dot shows the state in its shape as well as its colour: an empty ring when GitHub is not connected,
 * a filled dot when it is, a square when something needs a look. Sits in .tb-right before the CI chip. Hidden when Settings, GitHub says so;
 * the "Open GitHub" command always works.
 */
export function GithubChip() {
  const shown = useGithub((s) => s.iconShown);
  const open = useGithub((s) => s.open);
  const view = useGithub((s) => s.view);
  if (!shown) return null;
  const tone = chipTone(view);
  const label = chipLabel(view);
  return (
    <button type="button" className={`tb-gh tone-${tone}${open ? ' on' : ''}`} aria-expanded={open} aria-haspopup="dialog" aria-label={`${label}. ${open ? 'Close' : 'Open'} the GitHub panel`} title={label} onClick={toggleGithub}>
      <Icon name="github" size={15} />
      <i className="tb-gh-dot" aria-hidden="true" />
    </button>
  );
}
