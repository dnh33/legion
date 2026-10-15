import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startKbdNav } from './a11y/kbdNav';
import { applyFocusRings, readFocusRings } from './a11y/focusRings';
import { startSounds } from './sound/soundService';
import './fonts/fonts.css';
import './styles/tokens.css';
import './styles/app.css';

startKbdNav();
applyFocusRings(readFocusRings());
startSounds();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
