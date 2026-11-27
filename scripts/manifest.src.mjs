// Not used at runtime: generates manifest.json, so the long JSON schemas stay
// readable. Run `node scripts/manifest.src.mjs` after changing it.
import { writeFile } from 'node:fs/promises';

const str = { type: 'string', minLength: 1, maxLength: 128 };
const strs = { type: 'array', items: str, maxItems: 32 };
const uuid = { type: 'string', minLength: 36, maxLength: 36 };
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const blueprintOnly = (more = {}) => obj({ blueprint: str, ...more }, ['blueprint']);
const strFields = (...names) => Object.fromEntries(names.map((name) => [name, str]));

const pieceSources = { type: 'array', minItems: 1, maxItems: 16, items: obj({ blueprint: str, via: str }, ['blueprint']) };
const configurationSchema = obj(
  {
    context: str,
    orders: blueprintOnly({ ...strFields('number', 'customer', 'status', 'due_date'), open_statuses: strs }),
    order_lines: blueprintOnly(strFields('order', 'item', 'quantity')),
    bars: obj(
      { pieces: pieceSources, stock: { ...strs, minItems: 1 }, length: str, section: { ...strs, minItems: 1 }, weight: str },
      ['pieces', 'stock', 'section'],
    ),
    sheets: obj(
      {
        pieces: pieceSources,
        stock: { ...strs, minItems: 1 },
        ...strFields('length', 'width', 'thickness', 'weight', 'rotate', 'shaped'),
        match: { ...strs, minItems: 1 },
        density: obj(strFields('via', 'attribute'), ['via', 'attribute']),
      },
      ['pieces', 'stock', 'match'],
    ),
    remnants: blueprintOnly({ ...strFields('name', 'source', 'length', 'width', 'weight'), copy: strs }),
    stock_levels: blueprintOnly(strFields('item', 'quantity', 'reserved', 'per_piece')),
    machines: blueprintOnly({
      ...strFields('name', 'process', 'kerf', 'spacing', 'edge_trim', 'guillotine_only', 'min_thickness', 'max_thickness', 'max_width', 'max_length'),
      processes: obj({ saw: strs, guillotine: strs, laser: strs, plasma: strs }),
    }),
    production: obj(
      {
        order: blueprintOnly({ ...strFields('number', 'status', 'customer_orders', 'machine', 'plan'), initial_status: { type: 'string', maxLength: 128 } }),
        material: blueprintOnly({ ...strFields('order', 'item', 'quantity'), by_weight: { type: 'boolean' } }),
        output: blueprintOnly({
          ...strFields('order', 'item', 'quantity'),
          kind: obj(strFields('attribute', 'product', 'scrap', 'remnant'), ['product', 'scrap']),
        }),
        scrap_item: obj(strFields('blueprint', 'attribute', 'value'), ['blueprint', 'attribute', 'value']),
      },
      ['order', 'material', 'output'],
    ),
  },
  ['orders', 'order_lines', 'stock_levels', 'machines', 'production'],
);

const anyObject = { type: 'object' };
const command = (id, request_schema, max_response_bytes) => ({
  id,
  handler: id,
  request_schema,
  response_schema: anyObject,
  ...(max_response_bytes ? { max_response_bytes } : {}),
});
const planId = { type: 'string', pattern: '^[A-Za-z0-9-]{8,40}$' };

const manifest = {
  manifest_version: 1,
  name: 'Planer cięcia',
  version: '0.2.0',
  description: 'Planuje cięcie sztang i profili z magazynu, rysuje każdą sztangę w skali, porównuje odpad z cięciem po kolei i tworzy zlecenia produkcyjne z planu.',
  icons: { 48: 'assets/icon-48.svg' },
  attricat: { id: 'attricat-extension-cutting-planner', host_api: '>=1.2.0, <2.0.0' },
  permissions: [
    'attricat.read',
    'attricat.write',
    'storage.extension',
    'configuration.read',
    'logging.write',
    'client.commands',
    'client.events',
    'client.navigation',
    'client.notification',
    'client.record_tab',
    'client.record_action',
    'client.action_dialog',
    'client.operations.start',
    'client.operations.read',
    'artifacts.write',
  ],
  artifacts: [
    { id: 'server', kind: 'server_wasm', path: 'dist/server.wasm' },
    { id: 'planner', kind: 'client_frame', path: 'dist/planner.js' },
    { id: 'plan-tab', kind: 'client_frame', path: 'dist/plan-tab.js' },
    { id: 'cutting-sheet-dialog', kind: 'client_frame', path: 'dist/cutting-sheet-dialog.js' },
  ],
  configuration: { version: 1, schema: configurationSchema },
  server: {
    commands: [
      command('list-orders', obj({})),
      command('load-demand', obj({ order_ids: { type: 'array', items: uuid, minItems: 1, maxItems: 50 } }, ['order_ids'])),
      command('load-stock', obj({ group_keys: { type: 'array', items: { type: 'string', maxLength: 1024 }, maxItems: 200 } }, ['group_keys'])),
      // The plan is the frame's own document; the server checks its ID and size.
      command('save-plan', obj({ plan: { type: 'object', required: ['id', 'groups'], properties: { id: planId } } }, ['plan'])),
      command('get-plan', obj({ plan_id: planId }, ['plan_id'])),
      command('list-plans', obj({ record_id: uuid })),
      command('check-plan', obj({ plan_id: planId }, ['plan_id'])),
      command('create-production-orders', obj({ plan_id: planId }, ['plan_id'])),
    ],
    operations: [
      {
        id: 'cutting-sheet',
        handler: 'cutting-sheet',
        request_schema: obj({}),
        max_request_bytes: 256,
        max_checkpoint_bytes: 4096,
        interactive: { version: 1, max_selection: 1 },
      },
    ],
  },
  ui: [
    { id: 'cutting-planner', version: 1, kind: 'route', artifact: 'planner', title: 'Planer cięcia' },
    { id: 'cutting-planner-nav', version: 1, kind: 'navigation', route: 'cutting-planner', title: 'Planer cięcia' },
    { id: 'plan-tab', version: 1, kind: 'tab', artifact: 'plan-tab', outlet: 'record_tab', view: 'detail', title: 'Plan cięcia' },
    { id: 'cutting-sheet-dialog', version: 1, kind: 'dialog', artifact: 'cutting-sheet-dialog', outlet: 'action_dialog', title: 'Karta cięcia' },
    {
      id: 'cutting-sheet',
      version: 1,
      kind: 'action',
      outlet: 'record_action',
      view: 'detail',
      title: 'Karta cięcia…',
      icon: 'download',
      invoke: { dialog: 'cutting-sheet-dialog' },
    },
  ],
};

await writeFile(new URL('../manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
