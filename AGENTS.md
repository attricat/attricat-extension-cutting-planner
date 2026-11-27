# Agent instructions

- Start from [docs/design.md](docs/design.md); keep it current when a decision
  changes.
- Polish only for now: every user-facing string (frames, command messages,
  manifest titles, the cutting sheet) is Polish, kept in one strings module so
  English can be added later. The manifest has no English translations.
- Keep the extension generic: blueprints and attributes come from its
  configuration. Never store anything specific to a customer here: names,
  data, account details, tokens or business rules. Customer packs configure
  it from their own repositories.
- The solver is plain TypeScript with no DOM or Attricat imports, deterministic
  for a seed, and tested on its own.
- Server component: target the released `attricat:host@1.2.0` ABI, with WIT
  copied verbatim from the
  [attricat-extension-sdk](https://github.com/attricat/attricat-extension-sdk)
  `wit/` directory, never from Core's unreleased `wit-host/`. See
  `attricat-extension-example` for the layout (`client/`, `server/`,
  `justfile`, `scripts/`).
- Use Node.js 24+ and pnpm; no Python tooling.
- Verify against a running Attricat with host API 1.2: unit tests and packing
  are not enough.
- Commit and push only when asked.

## Attricat design system

The canonical Attricat visual identity is maintained in
[attricat/design](https://github.com/attricat/design). Before creating or
significantly modifying UI, consult its STYLE.md. Use its design tokens and
MUI theme. Do not introduce new colors, typography scales, spacing systems,
border-radius conventions or visual patterns unless there is a specific reason
to extend the design system. Check both modes.
