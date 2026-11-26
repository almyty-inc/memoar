import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { applyTheme, readTheme } from './lib/theme';
import './index.css';

applyTheme(readTheme());

const root = document.getElementById('root');

if (!root) {
  throw new Error('Memoar root element was not found');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
