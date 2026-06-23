# council-of-ricks

A [pi](https://github.com/earendil-works/pi-mono) extension that spawns parallel independent reviewers for second opinions.

Each reviewer runs as an isolated pi process with fresh context — no shared conversation history biasing their assessment. Returns structured verdicts (APPROVE / CONCERNS / BLOCK) with notes.

## Install

```bash
pi install git:github.com/nijaru/council-of-ricks
```

Or symlink for local development:

```bash
ln -sf ~/github/nijaru/council-of-ricks ~/.pi/agent/extensions/council-of-ricks
```

## Usage

### Tool

The LLM can call `council` when it wants a second opinion:

```
Review this authentication refactor before I commit
```

The tool accepts:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `topic` | yes | What to review — diff, plan, code, question |
| `members` | no | Subset of reviewers. Default: all four |

### Command

```
/council <topic>
```

Injects a user message prompting the LLM to call the tool.

## Reviewers

| Name | Focus |
|------|-------|
| `security` | Auth, input validation, injection, secrets, trust boundaries |
| `performance` | Complexity, allocations, I/O, caching, hot paths |
| `architecture` | Coupling, contracts, error propagation, module boundaries |
| `testing` | Failure path coverage, assertion quality, edge cases |

Each reviewer responds with:

```
VERDICT: APPROVE | CONCERNS | BLOCK
NOTES:
- point one
- point two
```

## Output

Collapsed view shows summary icons:

```
council ✓2 ◐1 ✗1
```

Expanded (Ctrl+O) shows per-reviewer details:

```
✓ security — APPROVE
  - Input validation present on all user-facing endpoints
◐ architecture — CONCERNS
  - Tight coupling between auth module and session store
✗ testing — BLOCK
  - No tests for token expiry edge case
```

## How it works

1. Spawns 4 pi processes in parallel (`--mode json -p --no-session`)
2. Each gets the reviewer's system prompt via `--append-system-prompt`
3. Parses structured VERDICT/NOTES from each response
4. Aggregates into a single tool result
5. Temp prompt files cleaned up after each run

No session files created. No history pollution.

## Requirements

- pi with the extension system
