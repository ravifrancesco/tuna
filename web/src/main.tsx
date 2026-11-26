import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import './styles.css';
import { App } from './App';
import { language } from './i18n';
import { restoreSide } from './components/Resizer';
import { startTV } from './lib/tv';
import './lib/radioNew';

document.documentElement.lang = language;
startTV();
restoreSide();

const queryClient = new QueryClient({
  defaultOptions: {
    // "always": the server is often on the home network, with or without the internet; and with no
    // connection at all, a failed request is what takes the apps to their downloads.
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000, networkMode: 'always' },
    mutations: { networkMode: 'always' },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
