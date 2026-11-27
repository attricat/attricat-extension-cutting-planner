// One bar drawn to scale: start trim, pieces, and the offcut as a remnant
// (dashed outline) or scrap (diagonal hatch). Patterns and labels, not color,
// tell them apart; colors come from the theme's CSS custom properties.
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Box, Typography } from '@mui/material';
import type { DemandPiece } from '../api.js';
import { cutPositions, type BarLayoutStored as StoredLayout } from '../plan.js';
import { format, t } from '../i18n/pl.js';

const HEIGHT = 44;
const LABEL_MIN_WIDTH = 46;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(element);
    setWidth(Math.floor(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function HatchPattern({ id }: { id: string }) {
  return (
    <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="var(--ac-background-inset)" />
      <line x1="0" y1="0" x2="0" y2="6" stroke="var(--ac-border-strong)" strokeWidth="1.5" />
    </pattern>
  );
}

interface Props {
  layout: StoredLayout;
  stockLength: number;
  stockLabel: string;
  pieces: DemandPiece[];
  kerf: number;
  selected: number | null;
  onSelect: (piece: number | null) => void;
}

export function BarDiagram({ layout, stockLength, stockLabel, pieces, kerf, selected, onSelect }: Props) {
  const [ref, width] = useWidth();
  const hatch = `hatch-${useId().replace(/:/g, '')}`;
  const scale = width > 0 ? (width - 2) / stockLength : 0;
  const x = (mm: number) => 1 + mm * scale;
  const cuts = cutPositions(layout, pieces, kerf);
  const offcutStart = stockLength - layout.offcut;

  const onKey = (event: KeyboardEvent, piece: number) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(selected === piece ? null : piece);
    }
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
      <Typography
        component="span"
        sx={{ fontFamily: 'var(--ac-font-mono)', fontSize: 12, minWidth: 40, textAlign: 'right', color: 'text.secondary' }}
        aria-label={t.layoutAria(layout.count, stockLabel)}
      >
        ×{layout.count}
      </Typography>
      <Box ref={ref} sx={{ flex: 1, minWidth: 0 }}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} role="group" aria-label={t.layoutAria(layout.count, stockLabel)} style={{ display: 'block' }}>
            <defs>
              <HatchPattern id={hatch} />
            </defs>
            <rect x={0.5} y={0.5} width={width - 1} height={HEIGHT - 1} rx={2} fill="var(--ac-background-inset)" stroke="var(--ac-border-default)" />
            {layout.trim > 0 && (
              <rect x={x(0)} y={1} width={Math.max(1, layout.trim * scale)} height={HEIGHT - 2} fill={`url(#${hatch})`}>
                <title>{`${t.trim} ${format.mm(layout.trim)} mm`}</title>
              </rect>
            )}
            {cuts.map((cut, n) => {
              const piece = pieces[cut.index]!;
              const w = Math.max(1, cut.length * scale);
              const isSelected = selected === cut.index;
              const label = t.pieceAria(cut.index + 1, piece.item_label, format.mm(cut.length), piece.order_number);
              return (
                <g
                  key={n}
                  tabIndex={0}
                  role="button"
                  aria-pressed={isSelected}
                  aria-label={label}
                  onClick={() => onSelect(isSelected ? null : cut.index)}
                  onKeyDown={(event) => onKey(event, cut.index)}
                  style={{ cursor: 'pointer', outline: 'none' /* focus drawn on the rect */ }}
                  className="bar-piece"
                >
                  <title>{label}</title>
                  <rect
                    x={x(cut.offset)}
                    y={4}
                    width={w}
                    height={HEIGHT - 8}
                    rx={2}
                    fill={isSelected ? 'var(--ac-action-selected)' : 'var(--ac-background-surface)'}
                    stroke={isSelected ? 'var(--ac-brand-primary)' : 'var(--ac-border-strong)'}
                    strokeWidth={isSelected ? 2 : 1}
                  />
                  {w >= LABEL_MIN_WIDTH && (
                    <text
                      x={x(cut.offset) + w / 2}
                      y={HEIGHT / 2 + 4}
                      textAnchor="middle"
                      fontFamily="var(--ac-font-mono)"
                      fontSize={11}
                      fill="var(--ac-text-primary)"
                    >
                      {w >= LABEL_MIN_WIDTH + 30 ? `${cut.index + 1} · ${format.mm(cut.length)}` : format.mm(cut.length)}
                    </text>
                  )}
                </g>
              );
            })}
            {layout.offcut > 0 && (
              <g>
                <title>{`${layout.offcut_kind === 'remnant' ? t.remnant : t.scrap} ${format.mm(layout.offcut)} mm`}</title>
                <rect
                  x={x(offcutStart)}
                  y={layout.offcut_kind === 'remnant' ? 4 : 1}
                  width={Math.max(1, layout.offcut * scale)}
                  height={layout.offcut_kind === 'remnant' ? HEIGHT - 8 : HEIGHT - 2}
                  rx={2}
                  fill={layout.offcut_kind === 'remnant' ? 'var(--ac-background-inset)' : `url(#${hatch})`}
                  stroke={layout.offcut_kind === 'remnant' ? 'var(--ac-border-strong)' : 'none'}
                  strokeDasharray={layout.offcut_kind === 'remnant' ? '4 3' : undefined}
                />
                {layout.offcut * scale >= LABEL_MIN_WIDTH + 40 && (
                  <text
                    x={x(offcutStart) + (layout.offcut * scale) / 2}
                    y={HEIGHT / 2 + 4}
                    textAnchor="middle"
                    fontFamily="var(--ac-font-mono)"
                    fontSize={11}
                    fill="var(--ac-text-secondary)"
                    style={{ paintOrder: 'stroke', stroke: 'var(--ac-background-inset)', strokeWidth: 4 }}
                  >
                    {`${layout.offcut_kind === 'remnant' ? t.remnant : t.scrap} ${format.mm(layout.offcut)}`}
                  </text>
                )}
              </g>
            )}
          </svg>
        )}
      </Box>
    </Box>
  );
}

/** Names each pattern, so nothing is told apart by color alone. */
export function DiagramLegend({ kerf }: { kerf: number }) {
  const hatch = `legend-${useId().replace(/:/g, '')}`;
  const swatch = (content: JSX.Element, text: string) => (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <svg width={28} height={16} aria-hidden="true">
        {content}
      </svg>
      <Typography component="span" variant="caption" color="text.secondary">
        {text}
      </Typography>
    </Box>
  );
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }} aria-label={t.legend}>
      <svg width={0} height={0} style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <HatchPattern id={hatch} />
        </defs>
      </svg>
      {swatch(<rect x={1} y={1} width={26} height={14} rx={2} fill="var(--ac-background-surface)" stroke="var(--ac-border-strong)" />, t.legendPiece)}
      {swatch(
        <rect x={1} y={1} width={26} height={14} rx={2} fill="var(--ac-background-inset)" stroke="var(--ac-border-strong)" strokeDasharray="4 3" />,
        t.remnant,
      )}
      {swatch(<rect x={1} y={1} width={26} height={14} fill={`url(#${hatch})`} />, `${t.scrap} / ${t.trim.toLowerCase()}`)}
      {kerf > 0 && (
        <Typography component="span" variant="caption" color="text.secondary">
          {t.legendKerfNote(format.number(kerf))}
        </Typography>
      )}
    </Box>
  );
}
