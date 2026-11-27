// Material used and wasted for the plan, against cutting in order.
import type { ReactNode } from 'react';
import { Box, Divider, Paper, Stack, Typography } from '@mui/material';
import type { Kind } from '../api.js';
import { addFigures, type Figures, type PlanGroup } from '../plan.js';
import { format, t } from '../i18n/pl.js';

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 3, py: 0.5 }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: 'var(--ac-font-mono)', fontWeight: strong ? 600 : 400, textAlign: 'right', whiteSpace: 'nowrap' }}>
        {value}
      </Typography>
    </Box>
  );
}

/** Kilograms when every weight is known, else metres (bars) or square metres (sheets), else a dash. */
function amount(kg: number | null, measure: number, kind: Kind | null): string {
  if (kg !== null) return format.kg(kg);
  if (kind === 'bar') return format.m(measure);
  if (kind === 'sheet') return format.m2(measure);
  return '—';
}

function utilisation(figures: Figures, kind: Kind | null): number {
  if (figures.stockKg !== null && figures.partsKg !== null && figures.stockKg > 0) return figures.partsKg / figures.stockKg;
  if (kind !== null && figures.stockMeasure > 0) return figures.partsMeasure / figures.stockMeasure;
  return 0;
}

function FiguresBlock({ figures, kind, counts }: { figures: Figures; kind: Kind | null; counts: string }) {
  return (
    <>
      <Row label={kind === 'sheet' ? t.sheetsUsed : kind === 'bar' ? t.barsUsed : `${t.barsUsed} / ${t.sheetsUsed.toLowerCase()}`} value={counts} />
      <Row label={t.material} value={amount(figures.stockKg, figures.stockMeasure, kind)} />
      <Row label={t.utilisation} value={format.percent(utilisation(figures, kind))} strong />
      <Row label={t.remnants} value={amount(figures.remnantKg, figures.remnantMeasure, kind)} />
      <Row label={t.scrapLabel} value={amount(figures.wasteKg, figures.wasteMeasure, kind)} />
    </>
  );
}

function counts(groups: PlanGroup[], pick: (g: PlanGroup) => Figures): string {
  const bars = groups.filter((g) => g.kind === 'bar').reduce((n, g) => n + pick(g).pieces, 0);
  const sheets = groups.filter((g) => g.kind === 'sheet').reduce((n, g) => n + pick(g).pieces, 0);
  return [groups.some((g) => g.kind === 'bar') ? format.mm(bars) : null, groups.some((g) => g.kind === 'sheet') ? format.mm(sheets) : null]
    .filter(Boolean)
    .join(' / ');
}

export function Summary({ groups, children }: { groups: PlanGroup[]; children?: ReactNode }) {
  const kinds = new Set(groups.map((g) => g.kind));
  const kind: Kind | null = kinds.size === 1 ? [...kinds][0]! : null;
  const plan = addFigures(groups.map((g) => g.figures));
  const baseline = addFigures(groups.map((g) => g.baseline));
  const byWeight = plan.stockKg !== null && baseline.stockKg !== null;
  const saved = byWeight ? baseline.stockKg! - plan.stockKg! : baseline.stockMeasure - plan.stockMeasure;
  const base = byWeight ? baseline.stockKg! : baseline.stockMeasure;
  const savedText = byWeight ? format.kg(saved) : amount(null, saved, kind);

  return (
    <Paper variant="outlined" component="aside" aria-label={t.summary} sx={{ p: 5 }}>
      <Typography variant="h4" component="h2" sx={{ mb: 3 }}>
        {t.summary}
      </Typography>
      <Typography variant="overline" component="h3" color="text.secondary">
        {t.wholePlan}
      </Typography>
      <FiguresBlock figures={plan} kind={kind} counts={counts(groups, (g) => g.figures)} />
      <Divider sx={{ my: 3 }} />
      <Typography variant="overline" component="h3" color="text.secondary">
        {t.baseline}
      </Typography>
      <FiguresBlock figures={baseline} kind={kind} counts={counts(groups, (g) => g.baseline)} />
      <Divider sx={{ my: 3 }} />
      {(byWeight || kind !== null) && (
        <Row label={t.saving} value={`${savedText} · ${format.percent(base > 0 ? saved / base : 0)}`} strong />
      )}
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
        {t.savingHelp}
      </Typography>
      {groups.length > 1 && (
        <Stack spacing={1} sx={{ mt: 3 }}>
          {groups.map((group) => (
            <Box key={group.key}>
              <Typography variant="body2" color="text.secondary">
                {group.label}
              </Typography>
              <Typography variant="body2" sx={{ fontFamily: 'var(--ac-font-mono)', textAlign: 'right' }}>
                {group.kind === 'sheet' ? t.sheets(group.figures.pieces) : t.bars(group.figures.pieces)} ·{' '}
                {format.percent(utilisation(group.figures, group.kind))}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
      {children && <Box sx={{ mt: 5 }}>{children}</Box>}
    </Paper>
  );
}
