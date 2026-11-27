// Mounts a React tree in a frame with Attricat's MUI theme, following the
// host's light or dark mode while the frame stays mounted.
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, GlobalStyles, ThemeProvider } from '@mui/material';
import { applyCssVariables, watchColorMode } from '@attricat/frame-theme';
import { makeTheme } from '@attricat/frame-theme/mui';
import type { Attricat } from './api.js';

export function mountFrame(root: HTMLElement, attricat: Attricat, render: () => ReactNode): () => void {
  const app = createRoot(root);
  const stop = watchColorMode(root, attricat, (mode) => {
    applyCssVariables(document.documentElement, mode);
    app.render(
      <ThemeProvider theme={makeTheme(mode)}>
        <CssBaseline />
        <GlobalStyles
          styles={{
            '.bar-piece:focus-visible rect': { stroke: 'var(--ac-action-focus)', strokeWidth: 3 },
          }}
        />
        {render()}
      </ThemeProvider>,
    );
  });
  return () => {
    stop();
    app.unmount();
  };
}
