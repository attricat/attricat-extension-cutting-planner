// Planer cięcia: choose orders, see their pieces grouped by material, and the
// plan for each group with its summary; save it and create production orders.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Factory, FilePlus, RefreshCw, Save } from 'lucide-react';
import {
  CommandRefused,
  type Api,
  type Attricat,
  type DemandGroup,
  type Machine,
  type OrderSummary,
  type ShapedPart,
  type Skipped,
  type StockPiece,
} from '../api.js';
import {
  barGroup,
  barProblem,
  defaultSettings,
  machinesFor,
  newPlan,
  newPlanId,
  sheetGroup,
  sheetMode,
  sheetProblem,
  type PlanGroup,
  type Settings,
} from '../plan.js';
import { solveBarJob, solveSheetJob } from '../solve.js';
import { GroupPlan } from '../components/GroupPlan.js';
import { Summary } from '../components/Summary.js';
import { format, t } from '../i18n/pl.js';

const SEED = 1;

interface Loaded {
  groups: DemandGroup[];
  shaped: ShapedPart[];
  skipped: Skipped[];
  stock: Record<string, StockPiece[]>;
  machines: Machine[];
}

export function App({ attricat, api }: { attricat: Attricat; api: Api }) {
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [settings, setSettings] = useState<Record<string, Settings>>({});
  const [results, setResults] = useState<Record<string, PlanGroup>>({});
  const [computing, setComputing] = useState(false);
  const [planId, setPlanId] = useState(newPlanId);
  const [savedPlanId, setSavedPlanId] = useState<string | null>(null);
  const [production, setProduction] = useState<{ id: string; number: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ group: string; piece: number } | null>(null);
  const run = useRef(0);

  const fail = useCallback(
    (error: unknown) => {
      const message = error instanceof CommandRefused && error.message ? error.message : t.error;
      void attricat.notify({ message, severity: 'error' });
    },
    [attricat],
  );

  useEffect(() => {
    api
      .listOrders()
      .then((result) => {
        setOrders(result.orders);
        setTruncated(result.truncated);
      })
      .catch((error) => {
        setOrders([]);
        fail(error);
      });
  }, [api, fail]);

  const compute = useCallback(async (data: Loaded, all: Record<string, Settings>) => {
    const token = ++run.current;
    setComputing(true);
    const next: Record<string, PlanGroup> = {};
    for (const group of data.groups) {
      const pieces = data.stock[group.key] ?? [];
      const groupSettings = all[group.key]!;
      const stock = pieces.map((p) => ({ ...p, unlimited: groupSettings.unlimited.includes(p.item_id) }));
      if (group.kind === 'bar') {
        const solved = await solveBarJob(barProblem(group, stock, groupSettings, SEED));
        next[group.key] = barGroup(group, pieces, data.machines, groupSettings, solved.plan, solved.baseline);
      } else {
        const mode = sheetMode(data.machines.find((m) => m.id === groupSettings.machineId));
        const solved = await solveSheetJob(sheetProblem(group, stock, groupSettings, mode, SEED));
        next[group.key] = sheetGroup(group, pieces, data.machines, groupSettings, solved.plan, solved.baseline);
      }
    }
    if (token !== run.current) return;
    setResults(next);
    setComputing(false);
  }, []);

  const load = async () => {
    setLoading(true);
    setSelected(null);
    try {
      const demand = await api.loadDemand(chosen);
      const stock = await api.loadStock(demand.groups.map((g) => g.key));
      const data: Loaded = { ...demand, stock: stock.groups, machines: stock.machines };
      const initial = Object.fromEntries(data.groups.map((g) => [g.key, defaultSettings(g, data.stock[g.key] ?? [], data.machines)]));
      setLoaded(data);
      setSettings(initial);
      setPlanId(newPlanId());
      setSavedPlanId(null);
      setProduction([]);
      await compute(data, initial);
    } catch (error) {
      fail(error);
    } finally {
      setLoading(false);
    }
  };

  const changeSettings = (key: string, value: Settings) => {
    if (!loaded) return;
    const next = { ...settings, [key]: value };
    setSettings(next);
    setSavedPlanId(null);
    void compute(loaded, next);
  };

  const groups = useMemo(() => (loaded ? loaded.groups.map((g) => results[g.key]).filter((g): g is PlanGroup => Boolean(g)) : []), [loaded, results]);
  const chosenOrders = (orders ?? []).filter((o) => chosen.includes(o.id));
  const ordered = production.length > 0;

  const save = async () => {
    setBusy(true);
    try {
      await api.savePlan(newPlan(planId, SEED, chosenOrders, groups));
      setSavedPlanId(planId);
      void attricat.notify({ message: t.saved, severity: 'success' });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const createOrders = async () => {
    setBusy(true);
    try {
      if (savedPlanId !== planId) {
        await api.savePlan(newPlan(planId, SEED, chosenOrders, groups));
        setSavedPlanId(planId);
      }
      const result = await api.createProductionOrders(planId);
      setProduction(result.production_orders);
      void attricat.notify({ message: t.created(result.production_orders.length), severity: 'success' });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const visibleOrders = (orders ?? []).filter((order) => {
    const query = filter.trim().toLowerCase();
    return !query || order.number.toLowerCase().includes(query) || (order.customer ?? '').toLowerCase().includes(query);
  });

  return (
    <Box sx={{ p: { xs: 4, md: 6 } }}>
      <Typography variant="h3" component="h1" sx={{ mb: 5 }}>
        {t.plannerTitle}
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gap: 5,
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: '300px minmax(0, 1fr) 300px' },
          alignItems: 'start',
        }}
      >
        <Paper variant="outlined" component="nav" aria-label={t.demand} sx={{ p: 4 }}>
          <Typography variant="h4" component="h2" sx={{ mb: 3 }}>
            {t.demand}
          </Typography>
          <TextField label={t.filterOrders} value={filter} onChange={(e) => setFilter(e.target.value)} fullWidth sx={{ mb: 2 }} />
          {orders === null ? (
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', py: 3 }}>
              <CircularProgress size={18} />
              <Typography variant="body2">{t.ordersLoading}</Typography>
            </Stack>
          ) : orders.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
              {t.ordersEmpty}
            </Typography>
          ) : (
            <List dense disablePadding aria-label={t.orders} sx={{ maxHeight: 420, overflowY: 'auto', mx: -2 }}>
              {visibleOrders.map((order) => {
                const checked = chosen.includes(order.id);
                return (
                  <ListItem key={order.id} disablePadding>
                    <ListItemButton
                      onClick={() => setChosen(checked ? chosen.filter((id) => id !== order.id) : [...chosen, order.id])}
                      dense
                    >
                      <ListItemIcon sx={{ minWidth: 36 }}>
                        <Checkbox edge="start" checked={checked} tabIndex={-1} disableRipple slotProps={{ input: { 'aria-label': order.number } }} />
                      </ListItemIcon>
                      <ListItemText
                        primary={<span style={{ fontFamily: 'var(--ac-font-mono)', fontSize: 13 }}>{order.number}</span>}
                        secondary={[order.customer, order.due_date && `${t.due}: ${format.date(order.due_date)}`].filter(Boolean).join(' · ')}
                      />
                    </ListItemButton>
                  </ListItem>
                );
              })}
            </List>
          )}
          {truncated && (
            <Typography variant="caption" color="text.secondary">
              {t.ordersTruncated}
            </Typography>
          )}
          <Button
            variant="contained"
            fullWidth
            sx={{ mt: 3 }}
            disabled={chosen.length === 0 || loading}
            onClick={load}
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {loading ? t.loadingDemand : t.loadDemand}
          </Button>

          {loaded && (
            <>
              <Typography variant="h6" component="h3" sx={{ mt: 5, mb: 1 }}>
                {t.groups}
              </Typography>
              <Stack spacing={1}>
                {loaded.groups.map((group) => (
                  <Box key={group.key} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                    <Typography variant="body2">{group.label}</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'var(--ac-font-mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {t.pieces(group.pieces.reduce((sum, p) => sum + p.quantity, 0))}
                    </Typography>
                  </Box>
                ))}
              </Stack>
              {loaded.shaped.length > 0 && (
                <>
                  <Typography variant="h6" component="h3" sx={{ mt: 4, mb: 1 }}>
                    {t.shaped}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
                    {t.shapedHelp}
                  </Typography>
                  {loaded.shaped.map((part) => (
                    <Typography key={part.line_id} variant="body2" sx={{ mb: 1 }}>
                      <span style={{ fontFamily: 'var(--ac-font-mono)', fontSize: 12 }}>{part.order_number}</span> {part.item_label}
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: 'var(--ac-font-mono)' }}>
                        {part.quantity} × {format.size(part.length, part.width)} mm · {part.group}
                      </Typography>
                    </Typography>
                  ))}
                </>
              )}
              {loaded.skipped.length > 0 && (
                <>
                  <Typography variant="h6" component="h3" sx={{ mt: 4, mb: 1 }}>
                    {t.skipped}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
                    {t.skippedHelp}
                  </Typography>
                  {loaded.skipped.map((entry) => (
                    <Typography key={entry.line_id} variant="body2" sx={{ mb: 1 }}>
                      <span style={{ fontFamily: 'var(--ac-font-mono)', fontSize: 12 }}>{entry.order_number}</span> {entry.item_label}
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {entry.reason}
                      </Typography>
                    </Typography>
                  ))}
                </>
              )}
            </>
          )}
        </Paper>

        <Stack spacing={5} component="main" aria-label={t.plan} aria-busy={computing}>
          {!loaded && (
            <Paper variant="outlined" sx={{ p: 6 }}>
              <Typography color="text.secondary">{t.chooseOrders}</Typography>
            </Paper>
          )}

          {computing && groups.length === 0 && (
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
              <CircularProgress size={18} />
              <Typography variant="body2">{t.computing}</Typography>
            </Stack>
          )}
          {groups.map((group) => (
            <GroupPlan
              key={group.key}
              group={group}
              {...(loaded ? machinesFor(loaded.groups.find((g) => g.key === group.key)!, loaded.stock[group.key] ?? [], loaded.machines) : {})}
              onSettings={ordered ? undefined : (value) => changeSettings(group.key, value)}
              selected={selected?.group === group.key ? selected.piece : null}
              onSelect={(piece) => setSelected(piece === null ? null : { group: group.key, piece })}
            />
          ))}
        </Stack>

        {groups.length > 0 && (
          <Box sx={{ position: { lg: 'sticky' }, top: 24 }}>
            <Summary groups={groups}>
              {ordered ? (
                <Stack spacing={2}>
                  <Alert severity="success">{t.planOrdered}</Alert>
                  <Typography variant="h6" component="h3">
                    {t.productionOrders}
                  </Typography>
                  {production.map((order) => (
                    <Button key={order.id} variant="outlined" startIcon={<Factory size="1em" />} onClick={() => void attricat.navigate({ record_id: order.id })}>
                      {order.number}
                    </Button>
                  ))}
                  <Button variant="text" startIcon={<FilePlus size="1em" />} onClick={() => void load()}>
                    {t.newPlan}
                  </Button>
                </Stack>
              ) : (
                <Stack spacing={2}>
                  <Button variant="outlined" startIcon={<RefreshCw size="1em" />} disabled={computing || !loaded} onClick={() => loaded && void compute(loaded, settings)}>
                    {t.recompute}
                  </Button>
                  <Button variant="outlined" startIcon={<Save size="1em" />} disabled={busy || computing || savedPlanId === planId} onClick={save}>
                    {savedPlanId === planId ? t.saved : t.savePlan}
                  </Button>
                  <Button variant="contained" startIcon={<Factory size="1em" />} disabled={busy || computing} onClick={createOrders}>
                    {busy ? t.creating : t.createOrders}
                  </Button>
                  {computing && <Chip label={t.computing} variant="outlined" />}
                </Stack>
              )}
            </Summary>
          </Box>
        )}
      </Box>
    </Box>
  );
}
