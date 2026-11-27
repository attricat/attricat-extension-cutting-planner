// One material group's plan: header with the machine, optional settings,
// the bar diagrams and the piece list. Read only when `onSettings` is absent.
import { useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  Collapse,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Button,
  Typography,
} from '@mui/material';
import { ChevronDown, ChevronUp, CircleCheck, TriangleAlert } from 'lucide-react';
import type { Machine } from '../api.js';
import { placedCounts, settingsForMachine, type BarLayoutStored, type PlanGroup, type Settings, type SheetLayoutStored } from '../plan.js';
import { format, t } from '../i18n/pl.js';
import { BarDiagram, DiagramLegend } from './BarDiagram.js';
import { SheetDiagram } from './SheetDiagram.js';

interface Props {
  group: PlanGroup;
  /** The machines offered for this group, suitable ones first. */
  machines?: Machine[];
  /** How many of `machines` suit the group. */
  suitable?: number;
  onSettings?: (settings: Settings) => void;
  selected: number | null;
  onSelect: (piece: number | null) => void;
}

export function GroupPlan({ group, machines = [], suitable = machines.length, onSettings, selected, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const { settings } = group;
  const placed = placedCounts(group);
  const sheet = group.kind === 'sheet';
  const measure = sheet ? format.m2(group.figures.stockMeasure) : format.m(group.figures.stockMeasure);
  const chosenIndex = machines.findIndex((m) => m.id === settings.machineId);

  return (
    <Paper variant="outlined" component="section" aria-label={group.label} sx={{ p: 5 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ alignItems: { sm: 'center' }, mb: 4 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h4" component="h3">
            {group.label}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'var(--ac-font-mono)', fontSize: 12 }}>
            {[sheet ? t.sheets(group.figures.pieces) : t.bars(group.figures.pieces), measure, group.figures.stockKg !== null ? format.kg(group.figures.stockKg) : null]
              .filter(Boolean)
              .map((part, i) => (
                <span key={i} style={{ whiteSpace: 'nowrap' }}>
                  {i > 0 && ' · '}
                  {part}
                </span>
              ))}
          </Typography>
        </Box>
        {group.optimal && <Chip icon={<CircleCheck size="1em" />} label={t.optimal} variant="outlined" color="success" />}
        {onSettings ? (
          <FormControl sx={{ minWidth: 200 }}>
            <InputLabel id={`machine-${group.key}`}>{t.machine}</InputLabel>
            <Select
              labelId={`machine-${group.key}`}
              label={t.machine}
              value={settings.machineId ?? ''}
              onChange={(event) => {
                const machine = machines.find((m) => m.id === event.target.value);
                if (machine) onSettings(settingsForMachine(settings, machine));
              }}
            >
              {machines.map((machine) => (
                <MenuItem key={machine.id} value={machine.id}>
                  {machine.name} · {t.process[machine.process]}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {t.machine}: {group.machine ? `${group.machine.name} · ${t.process[group.machine.process]}` : t.noMachine}
          </Typography>
        )}
        {onSettings && (
          <Button
            variant="outlined"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            endIcon={open ? <ChevronUp size="1em" /> : <ChevronDown size="1em" />}
          >
            {t.settings}
          </Button>
        )}
      </Stack>

      {onSettings && (
        <Collapse in={open}>
          <SettingsPanel group={group} onSettings={onSettings} />
        </Collapse>
      )}

      {onSettings && machines.length === 0 && <Alert severity="warning" sx={{ mb: 4 }}>{t.noMachines}</Alert>}
      {onSettings && chosenIndex >= suitable && <Alert severity="warning" sx={{ mb: 4 }}>{t.machineUnsuitable}</Alert>}
      {group.stock.length === 0 && <Alert severity="warning" sx={{ mb: 4 }}>{t.noStock}</Alert>}
      {group.unplaced.length > 0 && (
        <Alert severity="warning" icon={<TriangleAlert size="1em" />} sx={{ mb: 4 }}>
          {t.unplaced}:{' '}
          {group.unplaced
            .map(
              (entry) =>
                `${entry.quantity} × ${group.pieces[entry.piece]!.item_label} (${
                  entry.reason === 'too-long' ? t.unplacedTooLong : entry.reason === 'too-large' ? t.unplacedTooLarge : t.unplacedNoStock
                })`,
            )
            .join('; ')}
        </Alert>
      )}

      <Stack spacing={sheet ? 6 : 4}>
        {group.layouts.map((layout, index) => {
          const stock = group.stock[layout.stock]!;
          const previous = index > 0 ? group.layouts[index - 1]!.stock : -1;
          const size = stock.width ? format.size(stock.length, stock.width) : format.mm(stock.length);
          return (
            <Box key={index}>
              {(sheet || previous !== layout.stock) && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1, ml: 13 }}>
                  {stock.label} · {size} mm{stock.remnant ? ` · ${t.remnantStock}` : ''}
                </Typography>
              )}
              {group.kind === 'bar' ? (
                <BarDiagram
                  layout={layout as BarLayoutStored}
                  stockLength={stock.length}
                  stockLabel={stock.label}
                  pieces={group.pieces}
                  kerf={settings.kerf}
                  selected={selected}
                  onSelect={onSelect}
                />
              ) : (
                <SheetDiagram
                  layout={layout as SheetLayoutStored}
                  sheetLength={stock.length}
                  sheetWidth={stock.width ?? 0}
                  stockLabel={stock.label}
                  pieces={group.pieces}
                  guillotine={group.mode === 'guillotine'}
                  selected={selected}
                  onSelect={onSelect}
                />
              )}
            </Box>
          );
        })}
      </Stack>
      <Box sx={{ mt: 4 }}>
        <DiagramLegend kerf={sheet ? 0 : settings.kerf} />
        {sheet && group.mode === 'guillotine' && (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
            {t.cutOrderHelp}
          </Typography>
        )}
      </Box>

      <Typography variant="h6" component="h4" sx={{ mt: 6, mb: 2 }}>
        {t.pieceList}
      </Typography>
      <Box sx={{ overflowX: 'auto' }}>
        <Table aria-label={t.pieceList}>
          <TableHead>
            <TableRow>
              <TableCell align="right">{t.colNo}</TableCell>
              <TableCell>{t.colItem}</TableCell>
              <TableCell align="right">{sheet ? t.colSize : t.colLength}</TableCell>
              <TableCell align="right">{t.colQuantity}</TableCell>
              <TableCell>{t.colOrder}</TableCell>
              <TableCell>{t.colCustomer}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {group.pieces.map((piece, index) => (
              <TableRow
                key={piece.line_id}
                selected={selected === index}
                hover
                onClick={() => onSelect(selected === index ? null : index)}
                sx={{ cursor: 'pointer' }}
              >
                <TableCell align="right" sx={{ fontFamily: 'var(--ac-font-mono)' }}>
                  {index + 1}
                </TableCell>
                <TableCell sx={{ minWidth: 180 }}>{piece.item_label}</TableCell>
                <TableCell align="right" sx={{ fontFamily: 'var(--ac-font-mono)' }}>
                  {sheet ? format.size(piece.length, piece.width ?? 0) : format.mm(piece.length)}
                </TableCell>
                <TableCell align="right" sx={{ fontFamily: 'var(--ac-font-mono)' }}>
                  {(placed.get(index) ?? 0) === piece.quantity ? piece.quantity : `${placed.get(index) ?? 0} / ${piece.quantity}`}
                </TableCell>
                <TableCell sx={{ fontFamily: 'var(--ac-font-mono)', whiteSpace: 'nowrap' }}>{piece.order_number}</TableCell>
                <TableCell sx={{ minWidth: 140 }}>{piece.customer ?? ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    </Paper>
  );
}

function NumberField({ label, value, onCommit, helperText }: { label: string; value: number; onCommit: (value: number) => void; helperText?: string }) {
  const [text, setText] = useState(String(value));
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setText(String(value));
  }
  const parsed = Number(text.replace(',', '.'));
  const invalid = text.trim() === '' || !Number.isFinite(parsed) || parsed < 0;
  const commit = () => {
    if (!invalid && parsed !== value) onCommit(parsed);
  };
  return (
    <TextField
      label={label}
      value={text}
      error={invalid}
      helperText={helperText}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === 'Enter' && commit()}
      slotProps={{ htmlInput: { inputMode: 'decimal', style: { fontFamily: 'var(--ac-font-mono)' } } }}
      sx={{ width: 220 }}
    />
  );
}

function SettingsPanel({ group, onSettings }: { group: PlanGroup; onSettings: (settings: Settings) => void }) {
  const { settings } = group;
  return (
    <Box sx={{ p: 4, mb: 4, bgcolor: 'background.inset', border: 1, borderColor: 'divider', borderRadius: 2 }}>
      <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: 'wrap', mb: 3 }}>
        <NumberField label={t.kerf} value={settings.kerf} onCommit={(kerf) => onSettings({ ...settings, kerf })} />
        <NumberField
          label={group.kind === 'sheet' ? t.edgeTrim : t.startTrim}
          value={settings.startTrim}
          onCommit={(startTrim) => onSettings({ ...settings, startTrim })}
        />
        {group.kind === 'sheet' && group.mode === 'free' && (
          <NumberField label={t.spacing} value={settings.spacing} onCommit={(spacing) => onSettings({ ...settings, spacing })} />
        )}
        <NumberField
          label={t.minRemnant}
          value={settings.minRemnant}
          helperText={t.minRemnantHelp}
          onCommit={(minRemnant) => onSettings({ ...settings, minRemnant })}
        />
      </Stack>
      <FormControlLabel
        control={
          <Switch checked={settings.remnantsFirst} onChange={(event) => onSettings({ ...settings, remnantsFirst: event.target.checked })} />
        }
        label={t.remnantsFirst}
      />
      {group.kind === 'sheet' && (
        <FormControlLabel
          control={<Switch checked={settings.rotation} onChange={(event) => onSettings({ ...settings, rotation: event.target.checked })} />}
          label={t.rotation}
        />
      )}
      <Typography variant="h6" component="h4" sx={{ mt: 3, mb: 1 }}>
        {group.kind === 'sheet' ? t.sheetSizes : t.stockSizes}
      </Typography>
      <Stack spacing={1}>
        {group.stock.map((bar) => (
          <Stack key={bar.item_id} direction="row" spacing={3} sx={{ alignItems: 'center' }}>
            <Typography variant="body2" sx={{ minWidth: 220 }}>
              {bar.label}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'var(--ac-font-mono)', fontSize: 12, minWidth: 120 }}>
              {t.inStock(bar.available)}
            </Typography>
            <FormControlLabel
              control={
                <Switch
                  checked={bar.unlimited}
                  onChange={(event) =>
                    onSettings({
                      ...settings,
                      unlimited: event.target.checked
                        ? [...settings.unlimited, bar.item_id]
                        : settings.unlimited.filter((id) => id !== bar.item_id),
                    })
                  }
                />
              }
              label={t.unlimited}
            />
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}
