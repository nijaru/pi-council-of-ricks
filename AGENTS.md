# Council of Ricks

Pi extension that spawns parallel independent reviewers for second opinions.

## Architecture

Single-file TypeScript extension (`index.ts`). No external dependencies beyond pi's built-in packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`).

Each reviewer runs as an isolated `pi --mode json -p --no-session` subprocess. Temp system prompt files are written to os.tmpdir() and cleaned up after each run.

## Key Decisions

- **Subprocess over inline**: Each reviewer needs genuinely independent context. Subprocess isolation prevents cross-contamination.
- **Structured output format**: Reviewers return `VERDICT: APPROVE|CONCERNS|BLOCK` + `NOTES:` bullets. Simple to parse, easy to read.
- **No quorum/voting logic**: Just present what each reviewer said. The main agent decides what to do with it.
- **Reviewer prompts inline**: Reviewer definitions live in `index.ts` as constants, not separate files. Keeps the extension self-contained.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point — tool + command registration, reviewer definitions, process spawning, parsing, rendering |
| `package.json` | Pi package manifest for `pi install` distribution |

## Working On This

- Extension loads from `~/.pi/agent/extensions/council-of-ricks` (symlink to this repo)
- Test changes: edit `index.ts`, run `/reload` in pi, then use `council` tool or `/council` command
- No build step — pi loads TypeScript directly via jiti
- Reviewer prompts are in the `REVIEWERS` array at the top of `index.ts`

## Stack

- TypeScript (no compilation, loaded by jiti)
- Pi extension API (`ExtensionAPI`, `registerTool`, `registerCommand`)
- Pi TUI components (`Text`, `Container`, `Spacer`)
- TypeBox for tool parameter schemas
