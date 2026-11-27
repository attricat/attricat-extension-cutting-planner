# Cutting planner: design note

Status: 2026-11-27. Stages 1 to 3 are built and verified end to end against
Attricat 1.11 (host API 1.2) with the cutting demo pack 0.2 (`e2e/verify.mjs`):
bars on the saw, sheets on the guillotine, laser and plasma, the cutting
sheet, and remnants as stock. Stage 4 (CAM exchange) waits for the
customer's CAM software and sample files; shaped parts are already listed
apart. Heat tracking is not built (see [Open questions](#open-questions)).

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
   the open orders to plan, and sees the pieces grouped by material: grade
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

A pack's machine blueprint carries `kerf_mm`, `part_spacing_mm`,
`edge_trim_mm`, `guillotine_only` (boolean), `min_thickness_mm`,
`max_thickness_mm`, `max_width_mm`, `max_length_mm` and a `process`
(those are the default codes; the configuration can name others, and maps
the pack's process values to saw, guillotine, laser and plasma). The cutting
demo pack has them; the first workspace's pack needs them added.

As built: a saw's edge trim is cut from the start of each full bar. A
guillotine squares the two start edges of a full sheet (x = 0 and y = 0) as
its first two cuts; the other edges stay as they are. A laser or plasma keeps
the edge trim from all four edges. Remnants need no start trim on a saw or
guillotine (their cut ends are clean); a laser or plasma trims them too. A
machine with `guillotine_only` plans like a guillotine whatever its process.

The planner suggests, for bars, the first saw whose largest length takes the
longest bar; for sheets, a guillotine, then a laser, then a plasma, whose
thickness range holds the group's thickness and whose table takes a sheet.
Machines that do not suit are still offered, after the suitable ones, with a
warning when chosen.

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
| Heat | The heat on the receipts of the material, for remnants and for orders that need one heat per part. Not built yet. |

Pieces whose shape is not a rectangle (a drawing with holes or curves) are
listed separately as **Detale kształtowe** and go to the CAM exchange; the
user can also mark a rectangular part as shaped.

## The algorithms

All three run in the browser, in a Worker started from a Blob URL (the
frame's CSP allows `blob:` scripts and sets no `worker-src`; confirmed in
the browser, and the planner falls back to the page if a Worker cannot
start). They are deterministic:
the same input and seed give the same plan, so a saved plan can be
recomputed and compared. That rules out a wall-clock budget: the solver's
work is bounded by an effort count (randomised constructions and
improvement rounds) sized to finish in well under two seconds.

- **Bars (one dimension).** First-fit decreasing and a bar-by-bar fill (each
  bar takes the subset of the remaining pieces that fills it best, a bounded
  subset sum, on the stock length it fills best) as starts, repeated with
  seeded tie-breaking, then improved by repeated bin completion: the emptiest
  bar and a few others are dissolved and refilled, keeping any result that is
  no worse, so free length gathers in one bar until it empties. Cutting in
  order is also a candidate, so a plan is never worse than the baseline. When
  every bar has the same length, the plan is checked against the Martello–Toth
  lower bound and marked optimal when it meets it. (An exact solver over cut
  patterns was dropped: on random orders more effort barely improves the
  plan, so the remaining gap to the bound is mostly the bound.) Kerf is added
  per cut (the last cut may run off the end when less than a kerf is left),
  full bars are trimmed at the start and remnants are not, and an end piece
  at least the minimum remnant length is a remnant, shorter ones scrap.
  Identical bars are grouped ("×12").
- **Guillotine (two dimensions, straight cuts only).** Three-stage strip
  packing: first-stage cuts across the sheet make strips, second-stage cuts
  split a strip into parts, and a third-stage trim shortens a part shallower
  than its strip. A part joins the strip where it wastes least, or opens a
  new strip with its longer or its shorter side across (both are tried).
  The result carries every cut as a line with its stage and its number in
  cutting order (edge trim, then each strip and its parts), which the
  drawing and the cutting sheet show.
- **Laser and plasma rectangles (two dimensions, free).** MaxRects, packing
  towards the start of the sheet (so the rest stays one long remnant) or by
  best short side fit (both are tried), with every part inflated by the
  spacing (at least the kerf) and the sheet shrunk by the edge trim.
- Both fill one sheet at a time on the stock size it fills best (parts plus
  a kept remnant), from five part orderings and seeded perturbations.
  Rotation by 90° is allowed unless the part's own flag or the group's
  setting forbids it. The end of the sheet past the last strip (guillotine)
  or the last part (laser, plasma) is a remnant when both its sides reach
  the minimum remnant size.

Every plan is scored the same way: material used (sheets or bars, and their
weight), the share of it in parts, remnants kept, and scrap. The baseline is
cutting the lines in order, each on the next sheet or bar that still fits
(next fit), with the same machine rules. Remnants in stock are tried before
full sheets and bars, smallest first.

The solver is a plain TypeScript module with no DOM or Attricat imports,
tested on its own with fixed cases and property tests (no overlaps, every
piece placed once or reported, kerf and spacing respected, inside the
trimmed sheet, stock limits kept, guillotine plans separable by straight
end-to-end cuts, never worse than cutting in order).

## Architecture

| Part | Kind | What it does |
|---|---|---|
| `Planer cięcia` page | `route` contribution, Frame UI | The full planner: choosing orders, groups, diagrams, settings, summary, creating production orders. Reached from a `navigation` contribution. |
| `Plan cięcia` tab | `record_tab`, Frame UI | On customer orders and production orders: the plan for that record, read only. Shown on blueprints whose detail view lists `attricat-extension-cutting-planner/plan-tab`. |
| Server component | `server_wasm` on `attricat:host@1.2.0` (`outcome-extension` world) | Commands the frames call: `list-orders` (open orders), `load-demand` (pieces of the chosen orders, grouped, and shaped parts apart), `load-stock` (bars, sheets and remnants for the groups, and the machines), `save-plan`, `get-plan`, `list-plans` (optionally those that include a record), `check-plan` (out of date?) and `create-production-orders`. It reads with `attricat.read` and writes with `attricat.command.v1` intents, keyed by plan ID so a retry never makes a second production order. A command that fails returns `{ok: false, message}` with the reason, so the frame can show it. |
| Cutting sheet | `cutting-sheet` interactive operation, `action_dialog` frame, `record_action` | The printable karta cięcia. Operations start only from an action dialog, so **Karta cięcia…** is a record action on production orders (listed in the blueprint's detail view as `attricat-extension-cutting-planner/cutting-sheet`) that opens a dialog; the dialog starts the run for that one record (`max_selection: 1`), follows it and downloads the PDF through `attricat.operations`. The run finds the plan that made the production order in storage, renders the PDF, and appends it 64 KiB per batch. |

Why Frame UI: the diagrams are SVG drawn to scale with interaction, which the
UI kit of Native UI cannot build. The frame gets Attricat's color mode through
`attricat.theme` and restyles on `attricat:theme-changed.v1`.

Reading through the host (checked in Core's code): `attricat.read` `page`
lists one blueprint revision 100 records at a time, by blueprint ID and
version, with no attribute filter and no values; values come from a `record`
read per record, and relationships from `incoming` (records linking to one
record). So `load-demand` reads the chosen orders, their lines through
`incoming`, and each line's item and specification; `load-stock` pages the
stock items once per plan and filters by group in the command. Writes are an
`attricat.command.v1` batch of up to 100 intents, each with an `intent_key`
that makes a retry `already_applied`, which is what keys production orders
by plan ID. A `record_tab` frame gets the blueprint ID and version, not its
code; the tab does not need it, because `list-plans` finds plans by record
ID, whether the record is a customer order or a production order.

Three things the host does that the reads work around (found on the dev
server):

- An extension's resolved read expands no relationship: its value is
  `{items: [], truncated: true}`. Relationship targets come from the
  record's direct values (`relationship_target_record_id` per attribute ID,
  mapped to codes with the blueprint revision's attributes), preferring a
  value in the planner's context over one in another.
- Relationship labels are not returned either, so the server builds them as
  the host does: the target blueprint's `dropdown_option` fields joined by
  its separator.
- `page` lists one revision, and records stay on the revision they were
  saved with until migrated, so the server pages every revision up to the
  latest published one.

Why commands for data: a frame can read records only through
`attricat.request` (`GET` of single records and `/api/records`, 1 MiB per
response) and cannot write. Loading demand and stock and creating production
orders go through the extension's own server commands, which use the typed
`attricat.read` (`page`, `incoming`, `record`) and validated write intents.

Plans are kept in the extension's storage (`storage.extension`), one key
per plan (`plan:<id>`), with the inputs, the machine settings used, the
solver version and seed, and the result; cuts are stored as indices into the
group's pieces to stay well inside the 64 KiB value limit, and the server
refuses a plan over 60 KiB with a message to split the orders. A plan can be
saved again until production orders are created from it, and then no more.
The production order records the plan ID, and the plan records its
production orders, so the tab and the cutting sheet can find it.

A saved plan without production orders goes out of date when an order line's
quantity changes or disappears, or when the bars or sheets it needs (those
not planned as purchases) are no longer free in stock. `check-plan` compares
them, and the **Plan cięcia** tab shows **Plan nieaktualny** with the reasons
and a pointer to recompute in the planner. Once production orders exist,
using up the stock is the point, so the check stops.

The configuration (see `scripts/manifest.src.mjs` for its schema and
`server/component/src/config.rs` for the defaults) names:

- the blueprints of orders and order lines, and the open statuses;
- `bars`: the items cut from bars and the relationship to their
  specification (`via`), the bar blueprints, the attributes that must match
  between a piece and a bar (`section`, such as section and grade), and the
  length and weight attributes;
- `sheets`: the same for parts and sheets, with `match` (such as grade and
  thickness), width and thickness, a weight or a `density` on a related
  record (kg/dm³, such as the grade's) to compute it, and the part's
  `rotate` and `shaped` flags;
- `remnants`: the remnant blueprint, its relationship to the bar or sheet it
  came from, its length, width and weight, and the attributes it copies from
  that bar or sheet so it matches the same pieces;
- stock levels (with an optional reservation, and `per_piece` when stock is
  kept in kilograms);
- machines, with the process values for each kind;
- production orders (number, status written at creation, machine, customer
  orders, plan ID), material lines (`by_weight` for kilograms), output lines
  with their kind values (product, remnant, scrap) and the scrap item.

Attribute codes default to the common names, so a pack names only what
differs. `bars` and `sheets` are each optional. The demo pack's
configuration is its `extensions/cutting-planner.json`.

## Screens

The visual language is Attricat's: the frame uses React with MUI and the
theme and tokens of the SDK's `@attricat/frame-theme` package, Lucide icons,
Inter, and IBM Plex Mono for dimensions, codes and quantities (system fonts
when those are not installed: the frame's content security policy loads no
fonts). The SVG diagrams take their colors from the package's CSS custom
properties. Light and dark are both designed and checked.

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

Settings that change a plan (machine, kerf, start or edge trim, spacing for
a laser or plasma, rotation for sheets, minimum remnant, use remnants first,
and per stock size **Bez limitu (dokup)** to plan bars or sheets still to be
bought) are in a collapsible **Ustawienia** panel above each group,
prefilled from the machine. A group with nothing in stock starts with every
size unlimited.

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
- Guillotine plans number the cut lines in cutting order, the number near
  the start of each line (clear of the part labels); first and second-stage
  cuts are solid, trims dashed. Edge trim is a shaded margin (the start
  edges on a guillotine, every edge on a laser or plasma).
- Sheets are drawn whole, scaled to the column and at most 420 px tall,
  scrap as the hatched background with parts and remnants on it.
- Bars: one strip per bar, the cuts as vertical lines with lengths in mono
  above, kerf too small to draw shown in the legend instead.
- Keyboard: parts are focusable in reading order, with their size, order and
  line as accessible names.

### Plan cięcia (the record tab)

Read only. On a customer order: the plans that include it (newest first),
with the diagrams and summary of the groups that hold its pieces, and links
to the production orders made from the plan. On a production order: its own
group's diagrams and summary; the cutting sheet is the record's
**Karta cięcia…** action. A saved plan whose inputs changed shows **Plan
nieaktualny** with the reasons. With no plan, an empty state: "To zamówienie nie ma jeszcze planu cięcia" and how to
plan it. There is no **Otwórz w planerze**: `attricat.navigate` opens only
records, so a frame cannot open the planner page with an order chosen.

### Karta cięcia (the cutting sheet)

A4 PDF per production order: header with the production order number,
machine, material, customer orders, plan and its date, the settings used
and the material used; each layout's diagram with its count and a box to
tick per repeat (up to ten); a legend and, for guillotine plans, how to read
the cut order; the piece list (number, item, dimensions, quantity, order and
customer); fields to sign; page numbers. Drawn in grayscale, legible when
printed. Heat is not on it until heats are tracked.

Built without libraries beyond compression: a small PDF writer in the
server component embeds IBM Plex Sans (text) and IBM Plex Mono (figures) as
Type0 fonts, subset to the glyphs used, with a ToUnicode map so Polish text
prints, copies and searches correctly. Plex Sans stands in for Inter, which
is not published as a TrueType file the build can embed. The fonts come from
IBM's npm packages (SIL Open Font License, `server/component/fonts/OFL.txt`),
converted by `scripts/woff-to-ttf.mjs`. A typical sheet is 50–70 KB.

## What a plan becomes

**Utwórz zlecenie produkcyjne** creates, per machine and material group:

- a production order (planned, linked to its customer orders and machine);
- **materials**: the sheets or bars and remnants used, in their stock unit
  (kilograms for sheets, through the unit conversion);
- **output, products**: the cut elements or finished products, in pieces,
  per order line;
- **output, remnants**: each remnant kept, as a remnant item with its
  dimensions and the attributes of its bar or sheet (heat once tracked);
- **output, scrap**: the rest, in kilograms (material weight less parts and
  remnants).

Approving the order reserves the material and completing it moves stock, as
the pack does today; Stock Valuation then prices remnants and scrap.

As built: one production order per material group, numbered
`PC/<first 8 characters of the plan ID>/<n>`, in the configured initial
status, linked to the machine, to every customer order with a piece in the
group, and to the plan ID. Materials are whole bars or sheets per stock item
(their weight instead when the line is in kilograms, `by_weight`); products
are pieces per order line. With remnants configured, each remnant kept
becomes a remnant record (named after the material and its size, linked to
the bar or sheet it came from, with that record's copied attributes and its
share of the weight) and an output line of one piece; the pack's completion
of the production order brings it into stock, and the next plan offers it
first. Scrap is the material's weight less the pieces and the kept
remnants, written only when every bar or sheet has a weight and a scrap item
is configured. Without remnants configured, remnants are part of the scrap.

## Delivery stages

1. **Bars and profiles** on the saw: one-dimensional solver, the page with
   bar diagrams, the summary and comparison, production orders from a plan.
   Done.
2. **Rectangles from sheets** on the guillotine, laser and plasma, each with
   its machine's rules; the machine settings in the pack; the cutting sheet.
   Done (machine settings in the demo pack; the first workspace's pack still
   needs them).
3. **Remnants as stock**: a remnant item with dimensions and material in the
   pack, remnants received on completion and offered first by the next plan.
   Done, without heat.
4. **CAM exchange for shaped parts**: export of the shaped parts (CSV or the
   CAM's own job format) and import of the CAM's nesting report (sheets used,
   parts made, remnants), booked as for stage 2. Waiting for the CAM
   software's name and sample files; shaped parts are already listed apart
   as **Detale kształtowe**.

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
- Whether some orders need all parts from one heat, and so whether heats
  should be tracked on remnants and planned per heat (not built).
- Whether any finish (brushed, foil) forbids rotating parts.

For Attricat Core, answered 2026-11-27 from Core's code and docs:

- One extension may have several `route` frames and a `record_tab` frame (the
  example extension has two routes and a tab).
- Frame artifacts have no size limit of their own; the archive is limited to
  32 MiB compressed, 128 MiB unpacked and 256 entries.
- `page` does not filter by attribute value (see [Architecture](#architecture)).
- Operations start only from an action dialog, with its record selection
  and up to 64 KiB of input (see the cutting sheet in Architecture).
- A frame can start a Worker from a Blob URL (confirmed in the browser).
- Run outputs are appended at most 64 KiB per batch key, so a larger file
  takes several batches.
