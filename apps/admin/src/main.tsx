import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

const el = document.getElementById('root');
if (!el) throw new Error('Wurzelelement fehlt');

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
