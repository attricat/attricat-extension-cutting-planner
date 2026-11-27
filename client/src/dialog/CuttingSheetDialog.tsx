// Karta cięcia: starts the cutting sheet run for the production order the
// action was opened on, follows it, and downloads the PDF. The host draws
// the dialog's title and close control.
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { Download, FileText } from 'lucide-react';
import type { Attricat, Run } from '../api.js';
import { newPlanId } from '../plan.js';
import { t } from '../i18n/pl.js';

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const POLL_MS = 1500;

type State = { phase: 'idle' } | { phase: 'working' } | { phase: 'ready'; run: Run } | { phase: 'failed'; message: string };

export function CuttingSheetDialog({ attricat }: { attricat: Attricat }) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const key = useRef<string | null>(null);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  const follow = async (runId: string) => {
    for (;;) {
      const run = await attricat.operations!.get({ run_id: runId });
      if (!live.current) return;
      if (!ACTIVE.has(run.status)) {
        if (run.status === 'completed' && run.artifacts?.length) setState({ phase: 'ready', run });
        else setState({ phase: 'failed', message: t.sheetFailed });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  };

  const start = async () => {
    setState({ phase: 'working' });
    // Keep the key until the start succeeds: a retry returns the same run.
    key.current ??= newPlanId();
    try {
      const { run_id } = await attricat.operations!.start({ operation_id: 'cutting-sheet', input: {}, idempotency_key: key.current });
      key.current = null;
      await follow(run_id);
    } catch {
      if (live.current) setState({ phase: 'failed', message: t.sheetFailed });
    }
  };

  const download = async (run: Run) => {
    const artifact = run.artifacts![0]!;
    try {
      await attricat.operations!.download({ run_id: run.id, artifact_id: artifact.id });
    } catch {
      setState({ phase: 'failed', message: t.sheetExpired });
    }
  };

  return (
    <Box sx={{ p: 5, maxWidth: 560 }}>
      <Stack direction="row" spacing={3} sx={{ alignItems: 'flex-start', mb: 4 }}>
        <FileText size={24} aria-hidden="true" />
        <Typography variant="body2" color="text.secondary">
          {t.sheetIntro}
        </Typography>
      </Stack>
      <Box role="status" aria-live="polite" sx={{ mb: 4 }}>
        {state.phase === 'working' && (
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
            <CircularProgress size={18} />
            <Typography variant="body2">{t.sheetWorking}</Typography>
          </Stack>
        )}
        {state.phase === 'ready' && <Alert severity="success">{t.sheetReady}</Alert>}
        {state.phase === 'failed' && <Alert severity="error">{state.message}</Alert>}
      </Box>
      <Stack direction="row" spacing={2}>
        {state.phase === 'ready' ? (
          <Button variant="contained" startIcon={<Download size="1em" />} onClick={() => void download(state.run)}>
            {t.sheetDownload}
          </Button>
        ) : (
          <Button variant="contained" disabled={state.phase === 'working'} onClick={() => void start()}>
            {t.sheetCreate}
          </Button>
        )}
        {attricat.dialog && (
          <Button variant="outlined" onClick={() => void attricat.dialog!.close()}>
            {t.close}
          </Button>
        )}
      </Stack>
    </Box>
  );
}
