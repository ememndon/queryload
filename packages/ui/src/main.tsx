import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Bundled, self-hosted fonts (D76). @fontsource ships the woff2 locally and
// Vite inlines/bundles them — no network font loading, ever.
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/500.css';
import '@fontsource/source-serif-4/600.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing from index.html');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
