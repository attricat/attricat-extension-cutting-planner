// The frame's `attricat` object and the server commands it calls. Response
// types mirror server/component/src/*.rs.

export interface Attricat {
  context: { record_id?: string; record_ids?: string[]; context_id?: string; blueprint_id?: string; blueprint_version?: number };
  theme?: { color_mode?: string };
  command(detail: { command_id: string; payload: unknown }): Promise<unknown>;
  navigate(detail: { record_id: string; tab?: string }): Promise<unknown>;
  notify(detail: { message: string; severity?: 'success' | 'info' | 'warning' | 'error' }): Promise<unknown>;
  operations?: {
    start(detail: { operation_id: string; input: unknown; idempotency_key: string }): Promise<{ run_id: string }>;
    get(detail: { run_id: string }): Promise<Run>;
    download(detail: { run_id: string; artifact_id: string }): Promise<unknown>;
  };
  dialog?: { close(): Promise<unknown> };
}

export interface Run {
  id: string;
  status: string;
  artifacts?: { id: string; name?: string }[];
  outputs_expired?: boolean;
  error?: { message?: string } | string | null;
}

export interface OrderSummary {
  id: string;
  number: string;
  customer: string | null;
  status: string | null;
  due_date: string | null;
}

export interface DemandPiece {
  line_id: string;
  order_id: string;
  order_number: string;
  customer: string | null;
  item_id: string;
  item_label: string;
  length: number;
  /** Sheets only. */
  width: number | null;
  quantity: number;
  rotate: boolean;
}

export type Kind = 'bar' | 'sheet';

export interface DemandGroup {
  key: string;
  kind: Kind;
  label: string;
  thickness: number | null;
  pieces: DemandPiece[];
}

export interface ShapedPart {
  line_id: string;
  order_number: string;
  item_label: string;
  group: string;
  length: number;
  width: number;
  quantity: number;
}

export interface Skipped {
  line_id: string;
  order_number: string;
  item_label: string;
  reason: string;
}

export interface StockPiece {
  item_id: string;
  label: string;
  length: number;
  /** Sheets only. */
  width: number | null;
  available: number;
  weight: number | null;
  remnant: boolean;
}

export type Process = 'saw' | 'guillotine' | 'laser' | 'plasma';

export interface Machine {
  id: string;
  name: string;
  process: Process;
  kerf: number;
  spacing: number;
  edge_trim: number;
  guillotine_only: boolean;
  min_thickness: number | null;
  max_thickness: number | null;
  max_width: number | null;
  max_length: number | null;
}

export interface ProductionRef {
  id: string;
  number: string;
  group_key: string;
}

export interface PlanSummary {
  id: string;
  created_at: string | null;
  orders: { id: string; number: string }[];
  production_orders: ProductionRef[];
  groups: string[];
}

/** A server answer that may instead carry a message for the user. */
interface Refusable {
  ok?: boolean;
  message?: string | null;
}

export class CommandRefused extends Error {}

export function createApi(attricat: Attricat) {
  async function call<T>(command_id: string, payload: unknown): Promise<T> {
    const result = (await attricat.command({ command_id, payload })) as T & Refusable;
    if (result && typeof result === 'object' && result.ok === false) throw new CommandRefused(result.message ?? '');
    return result;
  }
  return {
    listOrders: () => call<{ orders: OrderSummary[]; truncated: boolean }>('list-orders', {}),
    loadDemand: (order_ids: string[]) =>
      call<{ groups: DemandGroup[]; shaped: ShapedPart[]; skipped: Skipped[] }>('load-demand', { order_ids }),
    loadStock: (group_keys: string[]) =>
      call<{ groups: Record<string, StockPiece[]>; machines: Machine[]; truncated: boolean }>('load-stock', { group_keys }),
    checkPlan: (plan_id: string) => call<{ stale: boolean; reasons: string[] }>('check-plan', { plan_id }),
    savePlan: (plan: unknown) => call<{ ok: boolean }>('save-plan', { plan }),
    getPlan: (plan_id: string) => call<{ plan: unknown }>('get-plan', { plan_id }),
    listPlans: (record_id?: string) => call<{ plans: PlanSummary[] }>('list-plans', record_id ? { record_id } : {}),
    createProductionOrders: (plan_id: string) =>
      call<{ ok: boolean; production_orders: ProductionRef[] }>('create-production-orders', { plan_id }),
  };
}

export type Api = ReturnType<typeof createApi>;
