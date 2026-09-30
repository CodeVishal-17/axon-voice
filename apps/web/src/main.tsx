import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/global.css';
import './styles/sections.css';

const root = document.getElementById('root');
if (!root) throw new Error('The page is missing its root element.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
