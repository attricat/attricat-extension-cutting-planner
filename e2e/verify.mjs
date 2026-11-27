// Browser and API verification against a running Attricat with host API 1.2.
//
// Needs the cutting demo pack 0.2 applied with its sample data (blueprints
// prefixed `dm_`; set CUTTING_PREFIX for another prefix), this extension
// side-loaded, configured with the demo's extensions/cutting-planner.json,
// granted and enabled, and an acli session:
//
//   acli --session-file .acli-session auth login default.local --email … --password-stdin
//   ATTRICAT_WEB_URL=http://127.0.0.1:58940 ATTRICAT_SESSION_FILE=.acli-session just e2e
//
// The suite changes data: it saves plans, creates production orders and
// completes one. Screenshots land in dist/e2e/.
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const WEB = process.env.ATTRICAT_WEB_URL;
const SESSION_FILE = process.env.ATTRICAT_SESSION_FILE;
if (!WEB || !SESSION_FILE) {
  console.error('Set ATTRICAT_WEB_URL and ATTRICAT_SESSION_FILE (an acli --session-file).');
  process.exit(2);
}
const PREFIX = process.env.CUTTING_PREFIX ?? 'dm';
const EXTENSION = 'attricat-extension-cutting-planner';
const SHOTS = 'dist/e2e';
mkdirSync(SHOTS, { recursive: true });
const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
const headers = {
  cookie: `attricat_session=${session.session}; attricat_csrf=${session.csrf}`,
  'x-attricat-csrf': session.csrf,
  'content-type': 'application/json',
};

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function api(method, path, body) {
  const response = await fetch(`${WEB}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const installation = (await api('GET', `/extensions/${EXTENSION}`)).installation;
check('extension is enabled', installation.state === 'enabled', installation.state);

async function command(command_id, payload, contribution = 'cutting-planner') {
  return api('POST', `/extensions/${EXTENSION}/${contribution}/command`, {
    release_id: installation.installed_release_id,
    command_id,
    payload,
  });
}

const DEFAULT_CONTEXT = (await api('GET', '/contexts')).find((c) => c.code === 'default').id;
async function setValue(recordId, code, value) {
  // Status edits need the record's last update as a precondition.
  const { record: { updated_at } } = await api('GET', `/v1/records/${recordId}`);
  return api('PUT', `/v1/records/${recordId}`, {
    expected_updated_at: updated_at,
    values: [{ kind: 'scalar', attribute_code: code, context_id: DEFAULT_CONTEXT, value }],
  });
}
async function incoming(recordId, source, field) {
  const result = await api('POST', `/v1/records/${recordId}/incoming-relationships`, {
    relationships: [{ source_blueprint: `${PREFIX}_${source}`, field }],
    page: { size: 100, cursor: null },
  });
  return result.items ?? [];
}

// ------------------------------------------------------------------ server --
const { orders } = await command('list-orders', {});
const demoOrders = orders.filter((order) => /^ZK\/2026\/10[1-5]$/.test(order.number));
check('list-orders offers the demo orders with customers', demoOrders.length === 5 && demoOrders.every((o) => o.customer), orders.map((o) => o.number).join(', '));
const demand = await command('load-demand', { order_ids: demoOrders.map((o) => o.id) });
const barGroups = demand.groups.filter((g) => g.kind === 'bar');
const sheetGroups = demand.groups.filter((g) => g.kind === 'sheet');
check('load-demand groups bars by section and grade, sheets by grade and thickness', barGroups.length === 3 && sheetGroups.length === 2, demand.groups.map((g) => g.label).join(', '));
check('shaped parts are listed apart', demand.shaped.length === 1 && /Kołnierz/.test(demand.shaped[0].item_label));
check('a part that must not turn keeps its flag', sheetGroups.some((g) => g.pieces.some((p) => /Osłona/.test(p.item_label) && p.rotate === false)));
const stock = await command('load-stock', { group_keys: demand.groups.map((g) => g.key) });
check('load-stock finds stock for every group', demand.groups.every((g) => stock.groups[g.key]?.length > 0));
check('load-stock offers remnants first', Object.values(stock.groups).filter((list) => list[0]?.remnant).length >= 2);
check('a sheet without a weight gets one from the grade density', Object.values(stock.groups).flat().some((s) => /1250×2500/.test(s.label) && Math.abs(s.weight - 73.594) < 0.01));
check('load-stock lists every kind of machine', ['saw', 'guillotine', 'laser', 'plasma'].every((p) => stock.machines.some((m) => m.process === p)));

// ----------------------------------------------------------------- browser --
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, locale: 'pl-PL' });
const { hostname } = new URL(WEB);
await context.addCookies([
  { name: 'attricat_session', value: session.session, domain: hostname, path: '/' },
  { name: 'attricat_csrf', value: session.csrf, domain: hostname, path: '/' },
]);
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));

const frameWith = async (text, timeout = 90_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const body = await frame.locator('body').innerText({ timeout: 500 });
        if (body.includes(text)) return frame;
      } catch {
        // Frames come and go while the host mounts contributions.
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`no extension frame contains ${text}`);
};

const step = async (label, run) => {
  try {
    await run();
    check(label, true);
  } catch (error) {
    check(label, false, error.message.split('\n')[0]);
  }
};

let planner;
let created = [];
let planId;
try {
  await step('planner page loads the orders', async () => {
    await page.goto(`${WEB}/extensions/${EXTENSION}/cutting-planner`);
    planner = await frameWith('ZK/2026/101');
  });

  await step('choosing orders draws a plan for every bar and sheet group', async () => {
    for (const order of demoOrders) await planner.getByRole('checkbox', { name: order.number }).check();
    await planner.getByRole('button', { name: 'Wczytaj detale' }).click();
    await planner.getByRole('heading', { name: 'Podsumowanie' }).waitFor({ timeout: 90_000 });
    for (const group of demand.groups) await planner.getByRole('heading', { name: group.label, exact: true }).waitFor();
    if ((await planner.locator('g.bar-piece').count()) === 0) throw new Error('no pieces drawn');
  });

  await step('the solver runs in a Worker', async () => {
    const where = await planner.evaluate(() => document.documentElement.dataset.solver);
    if (where !== 'worker') throw new Error(`solver ran on: ${where}`);
  });

  await step('the 3 mm group goes to the guillotine with numbered cuts', async () => {
    const section = planner.getByRole('region', { name: sheetGroups.find((g) => g.thickness === 3).label });
    await section.getByText(/Gilotyna hydrauliczna/).first().waitFor();
    if ((await section.locator('svg circle').count()) === 0) throw new Error('no cut numbers');
  });

  await step('the 10 mm group goes past the guillotine to a thermal cutter', async () => {
    const section = planner.getByRole('region', { name: sheetGroups.find((g) => g.thickness === 10).label });
    const text = await section.innerText();
    if (/Gilotyna/.test(text) || !/laser|plazma/.test(text)) throw new Error(text.slice(0, 120));
  });

  await step('shaped parts are listed for the CAM', async () => {
    await planner.getByRole('heading', { name: 'Detale kształtowe' }).waitFor();
    await planner.getByText(/Kołnierz z otworami/).first().waitFor();
  });

  await step('the plan saves material against cutting in order', async () => {
    const summary = await planner.getByRole('complementary', { name: 'Podsumowanie' }).innerText();
    const saving = summary.match(/Oszczędność\s+(-?[\d\s,]+) kg/);
    if (!saving || Number(saving[1].replace(/\s/g, '').replace(',', '.')) <= 0) throw new Error(`saving: ${saving?.[1]}`);
  });

  await step('selecting a piece highlights it in the list', async () => {
    await planner.locator('g.bar-piece').first().click();
    await planner.locator('tr.Mui-selected').first().waitFor({ timeout: 5_000 });
  });

  await page.screenshot({ path: `${SHOTS}/planner-light.png`, fullPage: true });
  const sheetSection = planner.getByRole('region', { name: sheetGroups.find((g) => g.thickness === 3).label });
  await sheetSection.screenshot({ path: `${SHOTS}/sheet-guillotine-light.png` }).catch(() => undefined);

  await step('the planner follows dark mode', async () => {
    await page.getByRole('button', { name: /Dark mode|Tryb ciemny/ }).click();
    await planner.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === 'dark', null, { timeout: 10_000 });
    const surface = await planner.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ac-background-surface').trim());
    if (surface.toLowerCase() !== '#131d31') throw new Error(`surface ${surface}`);
    await page.waitForTimeout(500);
    await sheetSection.screenshot({ path: `${SHOTS}/sheet-guillotine-dark.png` }).catch(() => undefined);
    await page.screenshot({ path: `${SHOTS}/planner-dark.png`, fullPage: true });
    await page.getByRole('button', { name: /Light mode|Tryb jasny/ }).click();
  });

  await step('a saved plan goes out of date when an order line changes', async () => {
    await planner.getByRole('button', { name: 'Zapisz plan' }).click();
    await planner.getByRole('button', { name: 'Plan zapisany.' }).waitFor({ timeout: 30_000 });
    planId = (await command('list-plans', {})).plans[0].id;
    const before = await command('check-plan', { plan_id: planId });
    if (before.stale) throw new Error(`fresh plan stale: ${before.reasons.join('; ')}`);
    const line = demand.groups[0].pieces[0];
    await setValue(line.line_id, 'quantity', line.quantity + 1);
    try {
      const after = await command('check-plan', { plan_id: planId });
      if (!after.stale) throw new Error('not stale after the change');
    } finally {
      await setValue(line.line_id, 'quantity', line.quantity);
    }
  });

  await step('creating production orders writes them with materials, products, remnants and scrap', async () => {
    await planner.getByRole('button', { name: 'Utwórz zlecenie produkcyjne' }).click();
    await planner.getByRole('heading', { name: 'Zlecenia produkcyjne' }).waitFor({ timeout: 90_000 });
    const plan = (await command('get-plan', { plan_id: planId })).plan;
    created = plan.production_orders;
    if (created.length !== demand.groups.length) throw new Error(`created ${created.length}`);
    const materials = await incoming(created[0].id, 'production_material', 'production_order');
    const outputs = await incoming(created[0].id, 'production_output', 'production_order');
    if (!materials.length || !outputs.length) throw new Error('missing lines');
    const remnants = await Promise.all(
      plan.groups.map(async (group) => {
        const order = created.find((p) => p.group_key === group.key);
        const expected = group.layouts.reduce((n, l) => n + l.remnants.length * l.count, 0);
        const outputs = await incoming(order.id, 'production_output', 'production_order');
        return { expected, outputs: outputs.length, products: new Set(group.layouts.flatMap((l) => l.placements ? l.placements.map((p) => p.piece) : l.cuts)).size };
      }),
    );
    // Products per line, one line per remnant, and scrap.
    const short = remnants.find((r) => r.outputs < r.products + r.expected);
    if (short) throw new Error(`outputs ${short.outputs} < ${short.products} products + ${short.expected} remnants`);
    if (!remnants.some((r) => r.expected > 0)) throw new Error('no remnants booked');
  });

  await step('creating them again writes nothing new', async () => {
    const again = await command('create-production-orders', { plan_id: planId });
    if (again.production_orders.map((p) => p.id).join() !== created.map((p) => p.id).join()) throw new Error('different orders');
  });

  await step('completing a production order brings its remnants into stock for the next plan', async () => {
    const plan = (await command('get-plan', { plan_id: planId })).plan;
    const group = plan.groups.find((g) => g.kind === 'bar' && g.layouts.some((l) => l.remnants.length));
    if (!group) throw new Error('no bar group with a remnant');
    const order = created.find((p) => p.group_key === group.key);
    const before = new Set(((await command('load-stock', { group_keys: [group.key] })).groups[group.key] ?? []).filter((s) => s.remnant).map((s) => s.item_id));
    await setValue(order.id, 'status', 'approved');
    await setValue(order.id, 'status', 'completed');
    const after = await command('load-stock', { group_keys: [group.key] });
    const fresh = after.groups[group.key].filter((s) => s.remnant && !before.has(s.item_id));
    if (!fresh.length) throw new Error('no new remnant in stock');
    const expected = group.layouts.flatMap((l) => l.remnants.map((r) => r.length));
    if (!fresh.every((r) => expected.some((length) => Math.abs(length - r.length) < 0.01))) throw new Error('remnant lengths differ');
  });

  await step('the Plan cięcia tab shows the plan on a customer order', async () => {
    const order = demoOrders.find((o) => o.number === 'ZK/2026/105');
    await page.goto(`${WEB}/records/${order.id}`);
    await page.getByRole('tab', { name: 'Plan cięcia' }).click();
    const tab = await frameWith('Podsumowanie');
    await tab.locator('g.bar-piece').first().waitFor({ timeout: 30_000 });
    const headings = await tab.getByRole('heading', { level: 3 }).allInnerTexts();
    const own = demand.groups.filter((g) => g.pieces.some((p) => p.order_id === order.id)).map((g) => g.label);
    const shown = headings.filter((text) => demand.groups.some((g) => g.label === text));
    if (shown.join() !== own.join()) throw new Error(`groups shown: ${shown.join(', ')}; expected ${own.join(', ')}`);
    await page.screenshot({ path: `${SHOTS}/tab-order.png`, fullPage: true });
  });

  await step('on a production order the tab shows only its material group', async () => {
    await page.goto(`${WEB}/records/${created[0].id}`);
    await page.getByRole('tab', { name: 'Plan cięcia' }).click();
    const tab = await frameWith('Podsumowanie');
    const headings = await tab.getByRole('heading', { level: 3 }).allInnerTexts();
    const groupHeadings = headings.filter((text) => demand.groups.some((g) => g.label === text));
    if (groupHeadings.length !== 1) throw new Error(`groups shown: ${groupHeadings.join(', ')}`);
  });

  await step('the cutting sheet downloads as a PDF from the production order', async () => {
    const plan = (await command('get-plan', { plan_id: planId })).plan;
    const sheetGroup = plan.groups.find((g) => g.kind === 'sheet' && g.mode === 'guillotine') ?? plan.groups[0];
    const order = created.find((p) => p.group_key === sheetGroup.key);
    await page.goto(`${WEB}/records/${order.id}`);
    await page.getByRole('button', { name: 'Karta cięcia…' }).click();
    const dialog = await frameWith('Utwórz kartę cięcia');
    await dialog.getByRole('button', { name: 'Utwórz kartę cięcia' }).click();
    await dialog.getByRole('button', { name: 'Pobierz kartę cięcia' }).waitFor({ timeout: 120_000 });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      dialog.getByRole('button', { name: 'Pobierz kartę cięcia' }).click(),
    ]);
    const path = `${SHOTS}/karta-ciecia.pdf`;
    await download.saveAs(path);
    const bytes = readFileSync(path);
    if (bytes.subarray(0, 8).toString() !== '%PDF-1.7') throw new Error('not a PDF');
    if (!bytes.toString('latin1').includes('%%EOF')) throw new Error('truncated PDF');
  });

  check('no console errors in the frames', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log(failures ? `${failures} check(s) failed` : 'All checks passed');
process.exit(failures ? 1 : 0);
