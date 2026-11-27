// Plan cięcia on a customer order or a production order: the saved plans
// that include the record, read only, with the diagrams of the newest.
import { useEffect, useState } from 'react';
import { Alert, AlertTitle, Box, Button, Chip, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import { Factory, Scissors } from 'lucide-react';
import type { Api, Attricat, PlanSummary } from '../api.js';
import type { Plan } from '../plan.js';
import { GroupPlan } from '../components/GroupPlan.js';
import { Summary } from '../components/Summary.js';
import { format, t } from '../i18n/pl.js';

export function PlanTab({ root, attricat, api }: { root: HTMLElement; attricat: Attricat; api: Api }) {
  const [recordId, setRecordId] = useState(attricat.context.record_id ?? null);
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [selected, setSelected] = useState<{ group: string; piece: number } | null>(null);
  const [stale, setStale] = useState<string[]>([]);

  useEffect(() => {
    const changed = (event: Event) => {
      const next = (event as CustomEvent<{ record_id?: string }>).detail?.record_id ?? null;
      setRecordId((current) => (current === next ? current : next));
    };
    root.addEventListener('attricat:context-changed.v1', changed);
    return () => root.removeEventListener('attricat:context-changed.v1', changed);
  }, [root]);

  useEffect(() => {
    if (!recordId) return;
    let live = true;
    setPlans(null);
    api
      .listPlans(recordId)
      .then((result) => {
        if (!live) return;
        setPlans(result.plans);
        setOpenId(result.plans[0]?.id ?? null);
      })
      .catch(() => live && setPlans([]));
    return () => {
      live = false;
    };
  }, [api, recordId]);

  useEffect(() => {
    if (!openId) return setPlan(null);
    let live = true;
    setStale([]);
    api.getPlan(openId).then((result) => live && setPlan(result.plan as Plan | null)).catch(() => live && setPlan(null));
    api
      .checkPlan(openId)
      .then((result) => live && setStale(result.stale ? result.reasons : []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, openId]);

  if (plans === null) {
    return (
      <Stack direction="row" spacing={2} sx={{ p: 4, alignItems: 'center' }}>
        <CircularProgress size={18} />
      </Stack>
    );
  }
  if (plans.length === 0) {
    return (
      <Box sx={{ p: 4 }}>
        <Stack direction="row" spacing={3} sx={{ alignItems: 'center', mb: 1 }}>
          <Scissors size={20} aria-hidden="true" />
          <Typography variant="h6" component="p">
            {t.tabEmpty}
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {t.tabEmptyHelp}
        </Typography>
      </Box>
    );
  }

  // A production order shows its own group; a customer order the groups
  // with its pieces.
  const ownGroup = plan?.production_orders.find((p) => p.id === recordId)?.group_key;
  const groups = plan
    ? plan.groups.filter((g) => (ownGroup ? g.key === ownGroup : g.pieces.some((piece) => piece.order_id === recordId)))
    : [];

  return (
    <Box sx={{ p: 4 }}>
      {plans.length > 1 && (
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap', mb: 4 }} aria-label={t.tabPlans}>
          {plans.map((summary) => (
            <Chip
              key={summary.id}
              label={summary.created_at ? t.tabCreated(format.date(summary.created_at)) : summary.id}
              variant={summary.id === openId ? 'filled' : 'outlined'}
              color={summary.id === openId ? 'primary' : 'default'}
              onClick={() => setOpenId(summary.id)}
            />
          ))}
        </Stack>
      )}
      {plan && stale.length > 0 && (
        <Alert severity="warning" sx={{ mb: 4 }}>
          <AlertTitle>{t.stale}</AlertTitle>
          {t.staleHelp}
          <Box component="ul" sx={{ m: 0, mt: 1, pl: 5 }}>
            {stale.slice(0, 8).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </Box>
        </Alert>
      )}
      {plan && (
        <Box sx={{ display: 'grid', gap: 4, gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 280px' }, alignItems: 'start' }}>
          <Stack spacing={4}>
            {groups.map((group) => (
              <GroupPlan
                key={group.key}
                group={group}
                selected={selected?.group === group.key ? selected.piece : null}
                onSelect={(piece) => setSelected(piece === null ? null : { group: group.key, piece })}
              />
            ))}
          </Stack>
          <Summary groups={groups}>
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                {plan.production_orders.length > 0 ? t.tabOrdered : t.tabDraft}
              </Typography>
              {plan.production_orders
                .filter((p) => p.id !== recordId)
                .map((order) => (
                  <Paper key={order.id} variant="outlined" sx={{ p: 0 }}>
                    <Button fullWidth startIcon={<Factory size="1em" />} onClick={() => void attricat.navigate({ record_id: order.id })}>
                      {order.number}
                    </Button>
                  </Paper>
                ))}
            </Stack>
          </Summary>
        </Box>
      )}
    </Box>
  );
}
