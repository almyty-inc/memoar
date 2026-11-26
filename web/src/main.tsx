import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import { applyTheme, readTheme, watchSystemTheme } from './lib/theme';
import './index.css';

applyTheme(readTheme());
watchSystemTheme();

const root = document.getElementById('root');

if (!root) {
  throw new Error('Memoar root element was not found');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
