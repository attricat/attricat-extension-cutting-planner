// One sheet drawn to scale: scrap as the hatched background, the edge trim
// as a shaded margin, parts on the surface color with their number and size,
// remnants with a dashed outline, and for a guillotine the cut lines numbered
// in cutting order. Patterns and labels, not color, tell them apart.
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Box, Typography } from '@mui/material';
import type { DemandPiece } from '../api.js';
import type { SheetLayoutStored } from '../plan.js';
import { format, t } from '../i18n/pl.js';
import { HatchPattern } from './BarDiagram.js';

const MAX_HEIGHT = 420;

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

interface Props {
  layout: SheetLayoutStored;
  sheetLength: number;
  sheetWidth: number;
  stockLabel: string;
  pieces: DemandPiece[];
  guillotine: boolean;
  selected: number | null;
  onSelect: (piece: number | null) => void;
}

export function SheetDiagram({ layout, sheetLength, sheetWidth, stockLabel, pieces, guillotine, selected, onSelect }: Props) {
  const [ref, available] = useWidth();
  const hatch = `sheet-hatch-${useId().replace(/:/g, '')}`;
  // Fit the width, and keep tall sheets from taking the whole screen.
  const scale = available > 0 ? Math.min((available - 2) / sheetLength, MAX_HEIGHT / sheetWidth) : 0;
  const w = sheetLength * scale;
  const h = sheetWidth * scale;
  const X = (mm: number) => 1 + mm * scale;
  const Y = (mm: number) => 1 + mm * scale;
  const trim = layout.edge_trim;

  const onKey = (event: KeyboardEvent, piece: number) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(selected === piece ? null : piece);
    }
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3 }}>
      <Typography
        component="span"
        sx={{ fontFamily: 'var(--ac-font-mono)', fontSize: 12, minWidth: 40, textAlign: 'right', color: 'text.secondary', pt: 1 }}
      >
        ×{layout.count}
      </Typography>
      <Box ref={ref} sx={{ flex: 1, minWidth: 0 }}>
        {scale > 0 && (
          <svg width={w + 2} height={h + 2} role="group" aria-label={t.sheetAria(layout.count, stockLabel)} style={{ display: 'block' }}>
            <defs>
              <HatchPattern id={hatch} />
            </defs>
            <rect x={X(0)} y={Y(0)} width={w} height={h} fill={`url(#${hatch})`} stroke="var(--ac-border-default)" />
            {trim > 0 && (
              <g fill="var(--ac-action-disabled)" opacity={0.9}>
                <title>{`${t.edgeMargin} ${format.mm(trim)} mm`}</title>
                {guillotine ? (
                  <>
                    <rect x={X(0)} y={Y(0)} width={trim * scale} height={h} />
                    <rect x={X(0)} y={Y(0)} width={w} height={trim * scale} />
                  </>
                ) : (
                  <path
                    fillRule="evenodd"
                    d={`M${X(0)},${Y(0)}h${w}v${h}h${-w}Z M${X(trim)},${Y(trim)}v${h - 2 * trim * scale}h${w - 2 * trim * scale}v${-(h - 2 * trim * scale)}Z`}
                  />
                )}
              </g>
            )}
            {layout.remnants.map((r, i) => (
              <g key={`r${i}`}>
                <title>{`${t.remnant} ${format.size(r.length, r.width ?? 0)} mm`}</title>
                <rect
                  x={X(r.x ?? 0)}
                  y={Y(r.y ?? 0)}
                  width={r.length * scale}
                  height={(r.width ?? 0) * scale}
                  fill="var(--ac-background-inset)"
                  stroke="var(--ac-border-strong)"
                  strokeDasharray="4 3"
                />
                {r.length * scale > 120 && (r.width ?? 0) * scale > 24 && (
                  <text
                    x={X((r.x ?? 0) + r.length / 2)}
                    y={Y((r.y ?? 0) + (r.width ?? 0) / 2) + 4}
                    textAnchor="middle"
                    fontFamily="var(--ac-font-mono)"
                    fontSize={11}
                    fill="var(--ac-text-secondary)"
                  >
                    {`${t.remnant} ${format.size(r.length, r.width ?? 0)}`}
                  </text>
                )}
              </g>
            ))}
            {layout.placements.map((p, n) => {
              const piece = pieces[p.piece]!;
              const length = p.rotated ? piece.width ?? 0 : piece.length;
              const width = p.rotated ? piece.length : piece.width ?? 0;
              const pw = length * scale;
              const ph = width * scale;
              const isSelected = selected === p.piece;
              const size = format.size(piece.length, piece.width ?? 0);
              const label = t.partAria(p.piece + 1, piece.item_label, size, piece.order_number) + (p.rotated ? `, ${t.rotated}` : '');
              return (
                <g
                  key={n}
                  tabIndex={0}
                  role="button"
                  aria-pressed={isSelected}
                  aria-label={label}
                  className="bar-piece"
                  onClick={() => onSelect(isSelected ? null : p.piece)}
                  onKeyDown={(event) => onKey(event, p.piece)}
                  style={{ cursor: 'pointer', outline: 'none' }}
                >
                  <title>{label}</title>
                  <rect
                    x={X(p.x)}
                    y={Y(p.y)}
                    width={Math.max(1, pw)}
                    height={Math.max(1, ph)}
                    fill={isSelected ? 'var(--ac-action-selected)' : 'var(--ac-background-surface)'}
                    stroke={isSelected ? 'var(--ac-brand-primary)' : 'var(--ac-border-strong)'}
                    strokeWidth={isSelected ? 2 : 1}
                  />
                  {pw >= 28 && ph >= 16 && (
                    <text
                      x={X(p.x) + pw / 2}
                      y={Y(p.y) + ph / 2 + (pw >= 70 && ph >= 30 ? -2 : 4)}
                      textAnchor="middle"
                      fontFamily="var(--ac-font-mono)"
                      fontSize={11}
                      fill="var(--ac-text-primary)"
                    >
                      {p.piece + 1}
                    </text>
                  )}
                  {pw >= 70 && ph >= 30 && (
                    <text
                      x={X(p.x) + pw / 2}
                      y={Y(p.y) + ph / 2 + 11}
                      textAnchor="middle"
                      fontFamily="var(--ac-font-mono)"
                      fontSize={10}
                      fill="var(--ac-text-secondary)"
                    >
                      {format.size(length, width)}
                    </text>
                  )}
                </g>
              );
            })}
            {guillotine &&
              layout.cut_lines.map(([order, stage, x1, y1, x2, y2]) => {
                // Numbers sit near the start of each line, clear of the
                // part labels in the middle of the parts.
                const vertical = Math.abs(x2 - x1) < Math.abs(y2 - y1);
                const mx = vertical ? X(x1) : X(Math.min(x1, x2)) + 11;
                const my = vertical ? Y(Math.min(y1, y2)) + 11 : Y(y1);
                const long = Math.hypot((x2 - x1) * scale, (y2 - y1) * scale);
                return (
                  <g key={`c${order}`} aria-hidden="true">
                    <line
                      x1={X(x1)}
                      y1={Y(y1)}
                      x2={X(x2)}
                      y2={Y(y2)}
                      stroke="var(--ac-text-secondary)"
                      strokeWidth={stage <= 1 ? 1.5 : 1}
                      strokeDasharray={stage === 3 ? '3 2' : undefined}
                    />
                    {long >= 22 && (
                      <g>
                        <circle cx={mx} cy={my} r={8} fill="var(--ac-background-elevated)" stroke="var(--ac-text-secondary)" strokeWidth={1} />
                        <text x={mx} y={my + 3} textAnchor="middle" fontFamily="var(--ac-font-mono)" fontSize={9} fill="var(--ac-text-primary)">
                          {order}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
          </svg>
        )}
      </Box>
    </Box>
  );
}
