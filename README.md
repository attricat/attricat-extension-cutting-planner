# attricat-extension-cutting-planner

An Attricat extension that plans cutting bars, profiles and sheets from stock
and remnants, for a saw, a guillotine shear, a laser and a plasma cutter. It
draws each layout to scale, compares the waste with cutting in order, and
turns an accepted plan into a production order with its materials, products,
remnants and scrap.

Status: stages 1 to 3 work end to end: bars on a saw, sheets on a guillotine,
laser and plasma, the cutting sheet PDF, and remnants as stock. Stage 4 (CAM
exchange for shaped parts) waits for the customer's CAM software. Read
[docs/design.md](docs/design.md) for the design, the decisions and what is
open. The UI is Polish only for now.

## What is in it

| Part | Where |
| --- | --- |
| Solvers for bars and for sheets (guillotine and free): plain TypeScript, no DOM or Attricat imports, deterministic for a seed | `solver/` |
| **Planer cięcia** page, **Plan cięcia** record tab and **Karta cięcia** dialog (Frame UI, React and MUI with the SDK's `@attricat/frame-theme`) | `client/` |
| Server component on `attricat:host@1.2.0`: loading orders, pieces and stock, storing and checking plans, creating production orders with remnants, rendering the cutting sheet PDF | `server/component/` |
| Fonts embedded in the cutting sheet (IBM Plex, SIL Open Font License) and the script that converted them | `server/component/fonts/`, `scripts/woff-to-ttf.mjs` |
| Manifest, generated from `scripts/manifest.src.mjs` | `manifest.json` |
| Browser and API checks against a running Attricat | `e2e/verify.mjs` |

The extension is generic: its configuration names the blueprints and
attributes it reads and writes (schema in `scripts/manifest.src.mjs`,
defaults in `server/component/src/config.rs`). A record tab appears on a
blueprint whose detail view lists it, and so does the cutting sheet action
on production orders:

```yaml
views:
  detail:
    type: stack
    extensions:
      - attricat-extension-cutting-planner/cutting-sheet   # production orders
      - attricat-extension-cutting-planner/plan-tab        # customer and production orders
```

## Build and test

Node.js 24+, pnpm, Rust with the `wasm32-unknown-unknown` target,
`wasm-tools` and `just`. `@attricat/frame-theme` comes from the
[attricat-extension-sdk](https://github.com/attricat/attricat-extension-sdk)
v0.1.3 release.

```sh
pnpm install
just check   # solver and client typecheck and tests, Rust fmt and tests
just pack    # dist/attricat-extension-cutting-planner-<version>.tar.zst
```

## Verify against a running Attricat

Unit tests are not enough; check against Attricat with host API 1.2:

1. Apply a pack with orders, bars, sheets, remnants, machines and
   production orders, with its sample data. The suite expects the cutting
   demo pack 0.2 (blueprints prefixed `dm_`, or set `CUTTING_PREFIX`; orders
   `ZK/2026/101`–`105`).
2. Side-load the archive, configure it (the demo pack's
   `extensions/cutting-planner.json`), grant every permission in
   `manifest.json` and enable it.
3. Run the suite with an `acli` session:

   ```sh
   acli --session-file .acli-session auth login default.local --email "$EMAIL" --password-stdin
   ATTRICAT_WEB_URL=http://127.0.0.1:<web-port> ATTRICAT_SESSION_FILE=.acli-session just e2e
   ```

   It must report `All checks passed`. It changes data: it saves plans,
   creates production orders and completes one. Screenshots of the planner
   in both color modes, of a guillotine sheet and of the tab, and the
   downloaded cutting sheet, land in `dist/e2e/`.

## License

MIT. See [LICENSE](LICENSE). The IBM Plex fonts in `server/component/fonts/`
are under the SIL Open Font License 1.1 (`server/component/fonts/OFL.txt`).
