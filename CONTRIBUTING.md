# Contributing

pi-ask-user-enhanced is an unofficial fork of [pi-ask-user](https://github.com/edlsh/pi-ask-user) by Enzo Lucchesi. It is maintained on a best-effort basis.

## Issues and pull requests

Issues and small pull requests are welcome here. Please open an issue first for anything larger than a fix, so we can agree on the behavior before you write code.

If a bug also happens with upstream `npm:pi-ask-user`, it may be better reported [upstream](https://github.com/edlsh/pi-ask-user/issues). Upstream accepts issues, not outside pull requests.

When reporting a bug, include the pi-ask-user-enhanced version (shown at the bottom of the prompt), the Pi version, your terminal, the display mode, any `PI_ASK_USER_*` variables or `ask-user.json` settings, the tool arguments, and steps to reproduce. Remove private question or answer content first.

## Development setup

Use Node.js 22.19.0 or newer and Bun 1.3.14 or newer. Bun runs the tests and manages the pinned development dependencies.

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`bun run check` runs:

- `bun run test`: unit tests (host and UI modules are mocked).
- `bun run typecheck`: strict TypeScript checks for source and tests.
- `bun run check:host`: loads the extension through the real installed Pi host and checks its schema, dialog fallback and event contract, without a model request.
- `bun run check:docs`: validates the JSON examples in the docs against the schema the real host registers.
- `bun run check:package`: checks the package contains exactly its intended files.

CI runs these on Node.js 22 and 24 with Pi 0.74.0 (the supported minimum), 1.0.2 and 1.5.0.

## Pull request guidelines

- Keep changes small, and explain the behavior and how you tested it.
- Include a regression test for a bug fix. New behavior goes in `enhanced.test.ts`; change an upstream test only when the behavior intentionally differs, and say why.
- Keep enhanced code in `enhanced-ui.ts` where possible. The less `index.ts` differs from upstream, the easier upstream releases are to merge.
- For UI changes, also check a real terminal: overlay and inline mode, narrow and wide terminals, resizing, long context, custom text and comments, timeout and abort, and non-ASCII text.
- Don't change event payload redaction.

## Releases and upstream

Releases are tagged `enhanced-vX.Y.Z`; the version in `package.json` is `<upstream>-enhanced.X.Y.Z`. Each release updates `package.json`, the version in `README.md` and `ENHANCED.md`, the version test in `enhanced.test.ts`, the hashes in `.pi-ask-user-enhanced-v1.json`, and the changelog in `ENHANCED.md`.

The history continues from upstream's own commits, so a new upstream release merges directly:

```bash
git remote add upstream https://github.com/edlsh/pi-ask-user.git
git fetch upstream --tags
git merge v0.18.0   # the upstream release tag
```
