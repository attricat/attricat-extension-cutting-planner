# Cutting planner: design note

Status: draft, 2026-11-27. Nothing is built yet.

The cutting planner is an Attricat extension that plans how to cut the pieces
of one or more orders from stock bars, sheets and usable remnants. It draws
each bar and sheet with its pieces, shows the material used and wasted,
and turns an accepted plan into a production order with its materials, its
output, the remnants worth keeping and the scrap.

The UI is in Polish only for now (see [Language](#language)).

## Goals

- **Less waste, visibly.** Every plan shows the material used, the material
  wasted, and the same figures for cutting the pieces one after another
  without a plan. That comparison is what makes the planner worth opening.
- **One planner for every cutting machine.** A saw cuts bars and profiles. A
  guillotine shear cuts sheets with straight cuts across the whole sheet. A
  laser and a plasma cutter cut any path. Each machine has its own rules (see
  [Machines](#machines)); the planner applies them instead of having a mode
  per machine.
- **Remnants are stock.** A usable piece left over is received into stock
  with its dimensions and its heat, and the next plan offers it before a full
  sheet or bar.
- **No retyping.** Pieces come from order lines, stock from stock levels,
  and the accepted plan becomes a production order in one action.
- **A shop-floor document.** The operator gets a cutting sheet (karta cięcia)
  with the diagrams, piece list and cut order.

## Non-goals

- **True-shape nesting.** Parts with holes, curves and irregular outlines are
  nested by the laser's and plasma's own CAM software, which does it well and
  knows the machine. The planner hands those parts over and reads the result
  back (stage 4), but never nests shapes itself.
- **Machine control.** No G-code, no machine connection.
- **Production scheduling.** When a plan is cut, and on which day, stays with
  production orders.

## Who uses it, and how

1. The production planner opens **Planer cięcia** from the navigation, picks
   the open orders to plan (or opens it from an order's **Plan cięcia** tab
   with that order selected), and sees the pieces grouped by material: grade
   and thickness for sheets, section and grade for bars.
2. For each group the planner suggests a machine from the thickness and the
   machines' limits. The user can change it.
3. The plan is computed in the browser in about a second and drawn at once.
   The user can change a machine, a stock size, a setting such as kerf, or
   exclude a remnant, and the drawing updates.
4. **Utwórz zlecenie produkcyjne** turns the accepted plan into one production
   order per machine and material group, with its materials, products,
   remnants and scrap, and links the plan to it.
5. The operator prints the cutting sheet from the production order.
6. Completing the production order, as today, issues the material and
   receives the products, remnants and scrap. Stock valuation prices them.

## Machines

Each machine record carries the settings the planner needs. They belong on
the machine, where people can see and change them, not in the extension's
JSON configuration.

| Setting | Saw | Guillotine | Laser | Plasma |
|---|---|---|---|---|
| Kerf (szerokość rzazu) | 2–4 mm | 0 | 0.2–0.5 mm | 2–4 mm |
| Spacing between parts (odstęp) | n/a | 0 | 3–10 mm | 8–15 mm |
| Edge trim (obcięcie krawędzi) | bar start | first cut | 5–10 mm | 10–15 mm |
| Cuts | straight, across the bar | straight, across the whole sheet (guillotine only) | any | any |
| Thickness range | n/a | up to the shear's limit | thin to medium | medium to thick |
| Largest sheet or bar | bar length | table width | table size | table size |

The figures are typical, not defaults to ship: each machine record holds its
own. The planner uses only what the machine says, so a fourth kind of machine
needs no code.

Pack change: the machine blueprint gets `kerf_mm`, `part_spacing_mm`,
`edge_trim_mm`, `guillotine_only` (boolean), `min_thickness_mm` (next to the
existing `max_thickness_mm`), `max_width_mm`, `max_length_mm`, and a
`process` enum (`saw`, `guillotine`, `laser`, `plasma`) beside the free-text
`kind`.

## What the planner reads

The extension is generic: its configuration names the blueprints and
attributes it reads and writes, as the Fakturownia and Stock Valuation
extensions do, so it works with any pack that has the same concepts. For the
first workspace these are:

| Concept | Where it comes from |
|---|---|
| Pieces to cut | Customer order lines whose item is a cut element (thickness, width, length, grade, drawing) or a finished product whose specification is a profile (section and length) or a base plate (thickness, width, length). |
| Stock material | Sheets (thickness × width × length, grade) and profiles (section, bar length, grade) with their stock items. Sheets are kept in kilograms, so the number of sheets is the stock level divided by the sheet's weight (its unit conversion to a sheet, or the computed weight). |
| Remnants | A remnant item per usable piece (stage 3), with its dimensions, grade and heat. |
| Density | The material grade's `density`, to weigh parts, remnants and scrap. |
| Machines | The machine records and the settings above. |
| Heat | The heat on the receipts of the material, for remnants and for orders that need one heat per part. |

Pieces whose shape is not a rectangle (a drawing with holes or curves) are
listed separately as **Detale kształtowe** and go to the CAM exchange; the
user can also mark a rectangular part as shaped.

## The algorithms

All three run in the browser, in a Worker where the frame allows it, with a
time budget of about two seconds. They are deterministic: the same input and
seed give the same plan, so a saved plan can be recomputed and compared.

- **Bars (one dimension).** First-fit decreasing as a start, improved by
  repeated bin completion; small instances (up to a few hundred cuts) are
  solved exactly by dynamic programming over cut patterns. Kerf is added per
  cut, the bar's start is trimmed, and an end piece at least the minimum
  remnant length is a remnant, shorter ones scrap. Identical bars are grouped
  ("×12").
- **Guillotine (two dimensions, straight cuts only).** Staged strip packing:
  the sheet is cut into strips across, the strips into pieces, and optionally
  a third stage trims pieces in a strip. Several orderings and split rules are
  tried and the best kept. The result is a cut tree, so the plan shows the cut
  order (1, 2, 3…) the shear operator follows.
- **Laser and plasma rectangles (two dimensions, free).** MaxRects (best short
  side fit and bottom-left, several orderings), with every part inflated by
  half the part spacing and the sheet shrunk by the edge trim. Rotation by 90°
  is allowed unless the part or its finish forbids it.

Every plan is scored the same way: material used (sheets or bars, and their
weight), the share of it in parts, remnants kept, and scrap. The baseline is
cutting the lines in order, each on the next sheet or bar that still fits
(next fit), with the same machine rules. Remnants in stock are tried before
full sheets and bars, smallest first.

The solver is a plain TypeScript module with no DOM or Attricat imports,
tested on its own with fixed cases and property tests (no overlaps, every
piece placed once, kerf and spacing respected, guillotine plans cuttable).

## Architecture

| Part | Kind | What it does |
|---|---|---|
| `Planer cięcia` page | `route` contribution, Frame UI | The full planner: choosing orders, groups, diagrams, settings, summary, creating production orders. Reached from a `navigation` contribution. |
| `Plan cięcia` tab | `record_tab`, Frame UI | On customer orders and production orders: the plan for that record, read only, with **Otwórz w planerze**. |
| Server component | `server_wasm` on `attricat:host@1.2.0` | Commands the frames call: `load-demand` (pieces from the chosen orders), `load-stock` (stock sheets, bars and remnants for a group), `save-plan`, `create-production-orders`. It reads with `attricat.read` and writes with `attricat.command.v1` intents, keyed by plan ID so a retry never makes a second production order. |
| Cutting sheet | Server operation with a PDF artifact | The printable karta cięcia, downloaded through `attricat.operations`. |

Why Frame UI: the diagrams are SVG drawn to scale with interaction, which the
UI kit of Native UI cannot build. The frame gets Attricat's color mode through
`attricat.theme` and restyles on `attricat:theme-changed.v1`.

Why commands for data: a frame can read records only through
`attricat.request` (`GET` of single records and `/api/records`, 1 MiB per
response) and cannot write. Loading demand and stock and creating production
orders go through the extension's own server commands, which use the typed
`attricat.read` (`page`, `incoming`, `record`) and validated write intents.

Plans are kept in the extension's storage (`storage.extension`), keyed by
plan ID, with the inputs, the machine settings used, the solver version and
seed, and the result. The production order records the plan ID, so the tab
and the cutting sheet can find it. A plan whose inputs have changed since
(stock used elsewhere, an order line edited) is marked out of date and offers
to recompute.

## Screens

The visual language is Attricat's (`attricat/design`: `STYLE.md`, `tokens/`,
`mui/`): the frame uses React with MUI and the `@attricat/design` theme,
Lucide icons, Inter, and IBM Plex Mono for dimensions, codes and quantities.
The diagrams follow `marketing/diagrams.md`. Light and dark are both designed
and checked.

### Planer cięcia (the page)

A three-column workspace on a data screen's density:

- **Left, Zapotrzebowanie (demand).** Open orders with a checkbox each,
  filterable by customer and date. Below, the chosen orders' pieces grouped
  by material (e.g. "S235JR · 5 mm"), each group with its piece count and
  weight. Shaped parts are listed apart.
- **Centre, the plan.** One section per group: a header with the group, the
  machine (a select) and the stock size chosen, then the diagrams, sheets
  stacked vertically, bars as horizontal strips. Identical layouts are drawn
  once with "×N". Choosing a piece highlights it and its order line.
- **Right, Podsumowanie (summary).** For the whole plan and per group:
  sheets or bars used, weight, utilisation (wykorzystanie materiału), remnants
  kept, scrap; and the same for cutting in order, with the difference in
  kilograms and in percent. Below it the actions: **Przelicz**, **Zapisz
  plan**, **Utwórz zlecenie produkcyjne**.

Settings that change a plan (machine, stock size, kerf, edge trim, rotation,
minimum remnant, use remnants first) are in a collapsible **Ustawienia** panel
above each group, prefilled from the machine.

### The diagrams

- Drawn to scale in SVG on the `background.inset` canvas with a 1 px
  `border.default` outline for the sheet or bar.
- Parts: `background.surface` fill, 1 px `border.strong` outline, a number in
  the part and its size in mono ("120 × 80"), shown when it fits and in a
  tooltip when it does not. The selected part takes `brand.primary` for its
  border and a light `action.selected` fill.
- Remnants: dashed border and the label **Pozostałość** with its size.
  Scrap: a diagonal hatch and the label **Złom**. Neither is told apart by
  color alone; the legend names each pattern.
- Guillotine plans number the cut lines in cutting order; laser and plasma
  plans show the edge trim as a shaded margin.
- Bars: one strip per bar, the cuts as vertical lines with lengths in mono
  above, kerf too small to draw shown in the legend instead.
- Keyboard: parts are focusable in reading order, with their size, order and
  line as accessible names.

### Plan cięcia (the record tab)

Read only. On a customer order: the plans that include it and their status,
with the diagrams of its pieces. On a production order: its plan's diagrams
and summary, and **Pobierz kartę cięcia**. With no plan, an empty state:
"To zamówienie nie ma jeszcze planu cięcia" and **Otwórz w planerze**.

### Karta cięcia (the cutting sheet)

A4 PDF per production order: header with order numbers, machine, material
and heat; each layout's diagram with its count; the piece list (number,
dimensions, quantity, order and customer); the cut order for guillotine
plans; and fields to tick and sign. Drawn in grayscale, legible when printed.

## What a plan becomes

**Utwórz zlecenie produkcyjne** creates, per machine and material group:

- a production order (planned, linked to its customer orders and machine);
- **materials**: the sheets or bars and remnants used, in their stock unit
  (kilograms for sheets, through the unit conversion);
- **output, products**: the cut elements or finished products, in pieces,
  per order line;
- **output, remnants**: each remnant kept, as a remnant item with its
  dimensions, grade and heat (stage 3; until then, remnants are booked as
  scrap);
- **output, scrap**: the rest, in kilograms (material weight less parts and
  remnants).

Approving the order reserves the material and completing it moves stock, as
the pack does today; Stock Valuation then prices remnants and scrap.

## Delivery stages

1. **Bars and profiles** on the saw: one-dimensional solver, the page with
   bar diagrams, the summary and comparison, production orders from a plan.
2. **Rectangles from sheets** on the guillotine, laser and plasma, each with
   its machine's rules; the machine settings in the pack; the cutting sheet.
3. **Remnants as stock**: a remnant item with dimensions, grade and heat in
   the pack, remnants received on completion and offered first by the next
   plan.
4. **CAM exchange for shaped parts**: export of the shaped parts (CSV or the
   CAM's own job format) and import of the CAM's nesting report (sheets used,
   parts made, remnants), booked as for stage 2. Needs the CAM software's
   name and sample files.

Stages 1 to 3 need nothing from the customer beyond the machine settings.

## Language

Polish only for now: every string in the frames, the commands' messages, the
manifest titles and the cutting sheet is Polish, and the manifest carries no
English translations. Strings still live in one module (`client/src/i18n/pl.ts`)
so English can be added later without touching components. Terms:

| English | Polish |
|---|---|
| Cutting planner | Planer cięcia |
| Cutting plan | Plan cięcia |
| Cutting sheet | Karta cięcia |
| Demand | Zapotrzebowanie |
| Sheet / bar | Arkusz / sztanga |
| Part / shaped part | Detal / detal kształtowy |
| Remnant | Pozostałość (użytkowa) |
| Scrap | Złom |
| Kerf | Szerokość rzazu |
| Spacing between parts | Odstęp między detalami |
| Edge trim | Obcięcie krawędzi |
| Material utilisation | Wykorzystanie materiału |
| Cutting in order (baseline) | Cięcie po kolei |
| Rotation allowed | Obrót dozwolony |
| Guillotine / laser / plasma / saw | Gilotyna / laser / plazma / piła |

## Open questions

For the customer:

- Which CAM software drives the laser and the plasma, and can they send a
  sample job file and nesting report? (Stage 4.)
- The real settings of each machine: kerf, spacing, edge trim, table size,
  thickness range.
- Stock sizes they buy (sheets, bar lengths), and the smallest remnant worth
  keeping, per material.
- Whether some orders need all parts from one heat.
- Whether any finish (brushed, foil) forbids rotating parts.

For Attricat Core, to verify before building:

- Whether one extension can have both a `route` frame and a `record_tab`
  frame ("each extension can use a frame outlet once").
- Whether the opaque frame may start a Worker for the solver, and the size
  limit for a `client_frame` artifact (React with MUI is about 150 kB
  gzipped).
- Whether `attricat.read` `page` filters by attribute value, to load only the
  stock of one grade and thickness, or the command must page and filter.
- How the server component builds the cutting sheet PDF (an operation
  artifact) within the host's limits.
