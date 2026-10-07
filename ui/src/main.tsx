import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startKbdNav } from './a11y/kbdNav';
import './fonts/fonts.css';
import './styles/tokens.css';
import './styles/app.css';

startKbdNav();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
