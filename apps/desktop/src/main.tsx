import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { initI18n } from './shared/i18n';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root introuvable');

void initI18n().then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
