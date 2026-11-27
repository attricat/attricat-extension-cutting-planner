// A cutting plan as the frame builds it and the server stores it: per
// material group, the pieces, the bars or sheets it may use, the settings,
// and the solver's layouts in a compact form (pieces are indices into
// `pieces`, stock entries indices into `stock`).

import {
  SOLVER_VERSION,
  type BarPlan,
  type BarProblem,
  type OffcutKind,
  type SheetPlan,
  type SheetProblem,
} from '../../solver/src/index.js';
import type { DemandGroup, DemandPiece, Kind, Machine, OrderSummary, Process, ProductionRef, StockPiece } from './api.js';

export interface Settings {
  machineId: string | null;
  kerf: number;
  /** Bars: start trim of a full bar. Sheets: edge trim. */
  startTrim: number;
  /** Laser and plasma: least distance between parts. */
  spacing: number;
  minRemnant: number;
  remnantsFirst: boolean;
  /** Sheets: whether parts may be turned (each part's own flag still applies). */
  rotation: boolean;
  /** Item IDs of bars or sheets planned without a stock limit (to be bought). */
  unlimited: string[];
}

export interface StoredStock extends StockPiece {
  unlimited: boolean;
}

export interface RemnantRect {
  x?: number;
  y?: number;
  length: number;
  width?: number;
}

export interface BarLayoutStored {
  stock: number;
  count: number;
  cuts: number[];
  trim: number;
  kerf: number;
  offcut: number;
  offcut_kind: OffcutKind;
  remnants: RemnantRect[];
}

/** A guillotine cut as [order, stage, x1, y1, x2, y2]. */
export type StoredCut = [number, number, number, number, number, number];

export interface SheetLayoutStored {
  stock: number;
  count: number;
  placements: { piece: number; x: number; y: number; rotated: boolean }[];
  /** Guillotine cut lines in cutting order (bars use `cuts` for pieces). */
  cut_lines: StoredCut[];
  remnants: RemnantRect[];
  edge_trim: number;
}

/**
 * Lengths are millimetres for bars and areas square millimetres for sheets;
 * weights are kilograms, null when a bar or sheet has no weight.
 */
export interface Figures {
  pieces: number;
  stockMeasure: number;
  partsMeasure: number;
  remnantMeasure: number;
  wasteMeasure: number;
  stockKg: number | null;
  partsKg: number | null;
  remnantKg: number | null;
  wasteKg: number | null;
}

interface GroupCommon {
  key: string;
  label: string;
  thickness: number | null;
  machine: { id: string; name: string; process: Process } | null;
  settings: Settings;
  stock: StoredStock[];
  pieces: DemandPiece[];
  unplaced: { piece: number; quantity: number; reason: 'too-long' | 'too-large' | 'no-stock' }[];
  figures: Figures;
  baseline: Figures;
  optimal: boolean;
}

export interface BarGroup extends GroupCommon {
  kind: 'bar';
  layouts: BarLayoutStored[];
}

export interface SheetGroup extends GroupCommon {
  kind: 'sheet';
  mode: 'guillotine' | 'free';
  layouts: SheetLayoutStored[];
}

export type PlanGroup = BarGroup | SheetGroup;

export interface Plan {
  id: string;
  version: 1;
  created_at: string;
  solver_version: string;
  seed: number;
  orders: { id: string; number: string }[];
  groups: PlanGroup[];
  production_orders: ProductionRef[];
}

export const DEFAULT_MIN_REMNANT: Record<Kind, number> = { bar: 500, sheet: 300 };

export function newPlanId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Machines offered for a group, the suitable ones first, and how many suit
 * it: saws for bars (taking the longest bar); for sheets, guillotine, laser
 * then plasma, within their thickness range and taking a sheet.
 */
export function machinesFor(group: DemandGroup, stock: StockPiece[], machines: Machine[]): { machines: Machine[]; suitable: number } {
  let candidates: Machine[];
  let suits: (m: Machine) => boolean;
  if (group.kind === 'bar') {
    const longest = Math.max(0, ...stock.map((bar) => bar.length));
    candidates = machines.filter((m) => m.process === 'saw');
    suits = (m) => m.max_length === null || m.max_length >= longest;
  } else {
    const preference: Process[] = ['guillotine', 'laser', 'plasma'];
    candidates = machines.filter((m) => m.process !== 'saw').sort((a, b) => preference.indexOf(a.process) - preference.indexOf(b.process));
    const thickness = group.thickness;
    const thick = (m: Machine) =>
      thickness === null || ((m.min_thickness === null || thickness >= m.min_thickness) && (m.max_thickness === null || thickness <= m.max_thickness));
    const takesSheet = (m: Machine) =>
      stock.length === 0 ||
      stock.some((s) => {
        const long = Math.max(s.length, s.width ?? 0);
        const short = Math.min(s.length, s.width ?? 0);
        return long <= Math.max(m.max_length ?? Infinity, m.max_width ?? Infinity) && short <= Math.min(m.max_length ?? Infinity, m.max_width ?? Infinity);
      });
    suits = (m) => thick(m) && takesSheet(m);
  }
  const suitable = candidates.filter(suits);
  return { machines: [...suitable, ...candidates.filter((m) => !suits(m))], suitable: suitable.length };
}

export function settingsForMachine(settings: Settings, machine: Machine | undefined): Settings {
  if (!machine) return { ...settings, machineId: null };
  return { ...settings, machineId: machine.id, kerf: machine.kerf, startTrim: machine.edge_trim, spacing: machine.spacing };
}

export function defaultSettings(group: DemandGroup, stock: StockPiece[], machines: Machine[]): Settings {
  const machine = machinesFor(group, stock, machines).machines[0];
  return settingsForMachine(
    {
      machineId: null,
      kerf: 0,
      startTrim: 0,
      spacing: 0,
      minRemnant: DEFAULT_MIN_REMNANT[group.kind],
      remnantsFirst: true,
      rotation: true,
      // With nothing in stock, plan as if every size can be bought.
      unlimited: stock.length > 0 && stock.every((s) => s.available === 0) ? stock.map((s) => s.item_id) : [],
    },
    machine,
  );
}

export function sheetMode(machine: Machine | undefined): 'guillotine' | 'free' {
  return machine && (machine.process === 'guillotine' || machine.guillotine_only) ? 'guillotine' : 'free';
}

export function barProblem(group: DemandGroup, stock: StoredStock[], settings: Settings, seed: number): BarProblem {
  return {
    pieces: group.pieces.map((piece, index) => ({ id: String(index), length: piece.length, quantity: piece.quantity })),
    stock: stock.map((bar, index) => ({ id: String(index), length: bar.length, available: bar.unlimited ? null : bar.available, remnant: bar.remnant })),
    rules: { kerf: settings.kerf, startTrim: settings.startTrim, minRemnant: settings.minRemnant },
    remnantsFirst: settings.remnantsFirst,
    seed,
  };
}

export function sheetProblem(group: DemandGroup, stock: StoredStock[], settings: Settings, mode: 'guillotine' | 'free', seed: number): SheetProblem {
  return {
    pieces: group.pieces.map((piece, index) => ({
      id: String(index),
      length: piece.length,
      width: piece.width ?? 0,
      quantity: piece.quantity,
      rotate: settings.rotation && piece.rotate,
    })),
    stock: stock.map((sheet, index) => ({
      id: String(index),
      length: sheet.length,
      width: sheet.width ?? 0,
      available: sheet.unlimited ? null : sheet.available,
      remnant: sheet.remnant,
    })),
    rules: { mode, kerf: settings.kerf, spacing: settings.spacing, edgeTrim: settings.startTrim, minRemnant: settings.minRemnant },
    remnantsFirst: settings.remnantsFirst,
    seed,
  };
}

export function compactBars(plan: BarPlan): BarLayoutStored[] {
  return plan.layouts.map((layout) => ({
    stock: Number(layout.stockId),
    count: layout.count,
    cuts: layout.cuts.map((cut) => Number(cut.pieceId)),
    trim: layout.trim,
    kerf: layout.kerf,
    offcut: layout.offcut,
    offcut_kind: layout.offcutKind,
    remnants: layout.offcutKind === 'remnant' ? [{ length: layout.offcut }] : [],
  }));
}

export function compactSheets(plan: SheetPlan): SheetLayoutStored[] {
  return plan.layouts.map((layout) => ({
    stock: Number(layout.stockId),
    count: layout.count,
    placements: layout.placements.map((p) => ({ piece: Number(p.pieceId), x: p.x, y: p.y, rotated: p.rotated })),
    cut_lines: layout.cuts.map((c) => [c.order, c.stage, c.x1, c.y1, c.x2, c.y2] as StoredCut),
    remnants: layout.remnants,
    edge_trim: layout.edgeTrim,
  }));
}

const pieceMeasure = (piece: DemandPiece) => piece.length * (piece.width ?? 1);
const stockMeasure = (stock: StockPiece) => stock.length * (stock.width ?? 1);
const remnantMeasure = (remnant: RemnantRect) => remnant.length * (remnant.width ?? 1);

/** Piece indices a layout places. */
export function layoutPieces(kind: Kind, layout: BarLayoutStored | SheetLayoutStored): number[] {
  return kind === 'bar' ? (layout as BarLayoutStored).cuts : (layout as SheetLayoutStored).placements.map((p) => p.piece);
}

export function figures(kind: Kind, layouts: (BarLayoutStored | SheetLayoutStored)[], stock: StoredStock[], pieces: DemandPiece[]): Figures {
  const result: Figures = { pieces: 0, stockMeasure: 0, partsMeasure: 0, remnantMeasure: 0, wasteMeasure: 0, stockKg: 0, partsKg: 0, remnantKg: 0, wasteKg: 0 };
  let weightsKnown = true;
  for (const layout of layouts) {
    const entry = stock[layout.stock]!;
    const parts = layoutPieces(kind, layout).reduce((sum, index) => sum + pieceMeasure(pieces[index]!), 0);
    const remnant = layout.remnants.reduce((sum, r) => sum + remnantMeasure(r), 0);
    const whole = stockMeasure(entry);
    const waste = whole - parts - remnant;
    result.pieces += layout.count;
    result.stockMeasure += layout.count * whole;
    result.partsMeasure += layout.count * parts;
    result.remnantMeasure += layout.count * remnant;
    result.wasteMeasure += layout.count * waste;
    if (entry.weight === null || whole <= 0) {
      weightsKnown = false;
      continue;
    }
    const perUnit = entry.weight / whole;
    result.stockKg! += layout.count * entry.weight;
    result.partsKg! += layout.count * parts * perUnit;
    result.remnantKg! += layout.count * remnant * perUnit;
    result.wasteKg! += layout.count * waste * perUnit;
  }
  if (!weightsKnown) Object.assign(result, { stockKg: null, partsKg: null, remnantKg: null, wasteKg: null });
  return result;
}

/** Adds up figures; measures of bars and sheets cannot be added, so totals are by weight. */
export function addFigures(all: Figures[]): Figures {
  const sum = (key: keyof Figures) => (all.some((f) => f[key] === null) ? null : all.reduce((total, f) => total + (f[key] as number), 0));
  return {
    pieces: sum('pieces') ?? 0,
    stockMeasure: sum('stockMeasure') ?? 0,
    partsMeasure: sum('partsMeasure') ?? 0,
    remnantMeasure: sum('remnantMeasure') ?? 0,
    wasteMeasure: sum('wasteMeasure') ?? 0,
    stockKg: sum('stockKg'),
    partsKg: sum('partsKg'),
    remnantKg: sum('remnantKg'),
    wasteKg: sum('wasteKg'),
  };
}

function common(group: DemandGroup, stockPieces: StockPiece[], machines: Machine[], settings: Settings) {
  const stock = stockPieces.map((s) => ({ ...s, unlimited: settings.unlimited.includes(s.item_id) }));
  const machine = machines.find((m) => m.id === settings.machineId);
  return {
    stock,
    machine,
    base: {
      key: group.key,
      label: group.label,
      thickness: group.thickness,
      machine: machine ? { id: machine.id, name: machine.name, process: machine.process } : null,
      settings,
      stock,
      pieces: group.pieces,
    },
  };
}

export function barGroup(group: DemandGroup, stockPieces: StockPiece[], machines: Machine[], settings: Settings, result: BarPlan, baseline: BarPlan): BarGroup {
  const { stock, base } = common(group, stockPieces, machines, settings);
  const layouts = compactBars(result);
  return {
    ...base,
    kind: 'bar',
    layouts,
    unplaced: result.unplaced.map((u) => ({ piece: Number(u.pieceId), quantity: u.quantity, reason: u.reason })),
    figures: figures('bar', layouts, stock, group.pieces),
    baseline: figures('bar', compactBars(baseline), stock, group.pieces),
    optimal: result.optimal,
  };
}

export function sheetGroup(group: DemandGroup, stockPieces: StockPiece[], machines: Machine[], settings: Settings, result: SheetPlan, baseline: SheetPlan): SheetGroup {
  const { stock, machine, base } = common(group, stockPieces, machines, settings);
  const layouts = compactSheets(result);
  return {
    ...base,
    kind: 'sheet',
    mode: sheetMode(machine),
    layouts,
    unplaced: result.unplaced.map((u) => ({ piece: Number(u.pieceId), quantity: u.quantity, reason: u.reason })),
    figures: figures('sheet', layouts, stock, group.pieces),
    baseline: figures('sheet', compactSheets(baseline), stock, group.pieces),
    optimal: false,
  };
}

export function newPlan(id: string, seed: number, orders: OrderSummary[], groups: PlanGroup[]): Plan {
  return {
    id,
    version: 1,
    created_at: new Date().toISOString(),
    solver_version: SOLVER_VERSION,
    seed,
    orders: orders.map((order) => ({ id: order.id, number: order.number })),
    groups,
    production_orders: [],
  };
}

/** A stored bar layout's cuts with their offsets, for drawing. */
export function cutPositions(layout: BarLayoutStored, pieces: DemandPiece[], kerf: number) {
  let offset = layout.trim;
  return layout.cuts.map((index) => {
    const piece = pieces[index]!;
    const cut = { index, offset, length: piece.length };
    offset += piece.length + kerf;
    return cut;
  });
}

/** How many pieces of each line a group's layouts place. */
export function placedCounts(group: PlanGroup): Map<number, number> {
  const placed = new Map<number, number>();
  for (const layout of group.layouts) {
    for (const index of layoutPieces(group.kind, layout)) placed.set(index, (placed.get(index) ?? 0) + layout.count);
  }
  return placed;
}
