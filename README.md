# Copy mode

Modal visual selection over Bitty's persisted transcript history.

## Overview

Copy mode opens one bounded, explicitly scoped transcript snapshot and lets you
move a visual cursor over the cached rows. `anchor` restarts the selection at
the cursor, and `yank` copies the selected span through the Core clipboard gate.
Rows are untrusted observation text: the plugin selects and copies them
verbatim, never executes or interpolates them. It never streams, polls, or
subscribes to events; a fresh result requires a new `open`.

## Install

Prerequisites: Bitty `>=0.0.24` and Plugin API `^1.0` (from
`bitty-plugin.toml` `[compat]`).

```sh
bitty plugin install https://github.com/bitty-terminal/copy-mode.git
bitty plugin enable bitty-terminal.copy-mode
bitty plugin list   # confirm state and grants
```

From a local checkout:

```sh
bitty plugin install ./copy-mode --yes
bitty plugin enable bitty-terminal.copy-mode
```

`bitty plugin list` confirms activation: the entry must be enabled and show the
two grants (`history.transcript.read`, `clipboard.write`). A disabled entry
carries a `disabled_reason`; see [Troubleshooting](#troubleshooting).

## Commands

| Command                           | What it does                                                                                                        | Arguments                                                                                                                                              | Default keybinding |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `bitty-terminal.copy-mode:open`   | Run one bounded snapshot query with an explicit scope and enter visual selection on the first row.                  | `panel` (string), `workspace` (string), `op` (`list`\|`tail`\|`search`, default `list`), `needle` (string), `row_count` (number), `max_bytes` (number) | None               |
| `bitty-terminal.copy-mode:move`   | Move the visual cursor by `delta` rows over the cached page; the anchor stays, widening or narrowing the selection. | `delta` (number, default `1`, nonzero integer)                                                                                                         | None               |
| `bitty-terminal.copy-mode:anchor` | Restart the selection at the current cursor row; no host call.                                                      | None                                                                                                                                                   | None               |
| `bitty-terminal.copy-mode:yank`   | Export the selected span through the clipboard gate; needs `clipboard.write`.                                       | None                                                                                                                                                   | None               |
| `bitty-terminal.copy-mode:close`  | Drop the cached page and leave visual selection; the next open starts fresh.                                        | None                                                                                                                                                   | None               |

`open` requires an explicit panel and/or workspace scope (never `*` or `all`)
and a `needle` for `op = "search"`. `row_count` and `max_bytes` default to the
configured bounds below.

## Configuration

Settings are declared in `bitty-plugin.toml` `[settings]` and resolved from
`$XDG_CONFIG_HOME/bitty/plugins/bitty-terminal.copy-mode.lua`. Every key is
user-owned; the plugin never writes settings.

| Key         | Type    | Default | Description                                                                                             | Applies         |
| ----------- | ------- | ------- | ------------------------------------------------------------------------------------------------------- | --------------- |
| `row_count` | integer | `10`    | Default rows per snapshot query, clamped to `1..16`. An explicit `open` argument overrides it.          | Next activation |
| `max_bytes` | integer | `4096`  | Default byte budget per snapshot query, clamped to `1..4096`. An explicit `open` argument overrides it. | Next activation |

```lua
-- $XDG_CONFIG_HOME/bitty/plugins/bitty-terminal.copy-mode.lua
return {
  row_count = 10,
  max_bytes = 4096,
}
```

Out-of-range or wrong-typed values fall back to `10` rows and `4096` bytes; a
bad configuration never widens a query. The host resolves settings at activation
and pins them to the generation, so edit the file and reopen Bitty to apply a
change.

## Keybindings

The plugin installs no keybindings. Run the commands from the palette, or add a
user mapping in `$XDG_CONFIG_HOME/bitty/init.lua`; user mappings keep precedence:

```lua
return {
  keymaps = {
    {
      chord = "ctrl+alt+c",
      action = "bitty-terminal.copy-mode:open",
      context = "global",
    },
  },
}
```

`open` needs an explicit panel or workspace scope, which a bare keymap entry
cannot supply; use the palette form that carries arguments, or bind `move`,
`anchor`, `yank`, and `close` for the in-session verbs.

## Troubleshooting

| Symptom / error                 | Meaning                                                                                                                                                                                          | What to do                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `E_INCOMPATIBLE` / `E_DISABLED` | The host application or Plugin API version is outside `[compat]`; no commands are registered for the generation.                                                                                 | Upgrade Bitty or install a copy-mode revision whose ranges admit your host. Do not edit the manifest ranges.                               |
| `E_SETTINGS_UNDECLARED`         | The entry point read a settings key absent from `[settings]`. This is a plugin defect.                                                                                                           | Both keys are declared; if it still appears, report it with `bitty plugin info bitty-terminal.copy-mode` and run `bitty --safe` meanwhile. |
| Capability denied               | `E_CAPABILITY_DENIED` (class `runtime`): without `history.transcript.read` a query is denied; without `clipboard.write` `yank` fails and keeps the page. The history grant never implies export. | Reinstall and approve the grants, or inspect granted versus requested capabilities with `bitty plugin list`.                               |
| `NO_SELECTION`                  | `move`, `anchor`, or `yank` ran without an open page, or `yank` ran with no selected span.                                                                                                       | Run `open` first and move the cursor.                                                                                                      |
| `NO_RESULTS`                    | The scope and needle matched no transcript rows.                                                                                                                                                 | Widen the scope or change the needle; the previous page is unchanged.                                                                      |
| `E_DEF_INVALID`                 | `op` was not `list`/`tail`/`search`, or `delta` was zero/non-integer.                                                                                                                            | Use a supported op and a nonzero integer delta.                                                                                            |
| `E_HISTORY_UNAVAILABLE`         | The host has no usable transcript query surface, or the query returned no value; the previous page and selection are kept.                                                                       | Check `bitty plugin list`, the host version, and history settings; retry after the host surface is available.                              |
| `E_SPAWN_FAILED`                | Not applicable: this plugin spawns no process and opens no socket.                                                                                                                               | —                                                                                                                                          |

## Scope

- `bitty-plugin.toml`: plugin id `bitty-terminal.copy-mode`, version `0.0.1`,
  compat `bitty >=0.0.24` with `plugin-api ^1.0`, a `[settings]` table
  declaring exactly the two keys the entry point reads (`row_count`, `int`,
  default `10`; `max_bytes`, `int`, default `4096`), exactly two capabilities
  (`history.transcript.read`, `clipboard.write`), lazy
  `open`/`move`/`anchor`/`yank`/`close` commands and no event subscriptions.
- `lua/copy-mode/init.lua`: the whole policy. Snapshot query state (scope,
  op, needle, bounds, cached page, anchor, cursor, visual flag) as
  presentation state that never mutates Terminal Truth; explicit-scope
  `list`/`tail`/`search` opens over `bitty.history.transcript.query`; pure
  cursor navigation and anchor restarts over the cached page; grant-gated
  span yank through `bitty.selection.copy`. A refresh replaces the cached
  page and resets the selection; a denied query keeps the previous page and
  selection intact.
- `tests/`: bun + wasmoon suite against the SDK `MockHost`, mirroring the
  search/history harness pattern. Covers the visual selection lifecycle
  (scoped opens, untrusted labels, move clamps, anchor restarts, verbatim
  span yank, close, replace-on-refresh with selection reset,
  denied-refresh-keeps-selection), the typed denial taxonomy (missing grant,
  revoked, scope mismatch, over-bound, capture off, safe mode, trust, purge),
  window budgets, clipboard-grant separation, mismatch disable with fallback,
  settings-declaration parity with the entry point's read keys, bounded
  settings-diagnostic fallback, and denial parity against a foreign manifest
  plus the no-weakening proof.

## Rules

- Public API only. Two additive v2 capabilities
  (`history.transcript.read`, `clipboard.write`); no commands history, no KV,
  no filesystem, process-spawn, network, overlay, or terminal authority. No
  session-snapshot access: save/restore stays Core-only, and no session
  surface exists on the reachable host object. Record bodies are untrusted
  observation text: selected or copied verbatim, never executed or
  interpolated.
- Explicit scope on every open (panel and/or workspace, never `*`/`all`);
  explicit row/byte bounds; capture opt-in; typed host denials surface
  verbatim with the previous page and selection kept. Nothing is truncated
  by the plugin, nothing is retried silently.
- Result export goes only through `bitty.selection.copy` behind the
  separately granted `clipboard.write` capability and fails closed with
  `E_CAPABILITY_DENIED` without it; the history grant never implies export,
  and the clipboard grant never implies history reads.
- Snapshot row identities are point-in-time: a refresh resets the anchor and
  cursor, so a selection never survives the page it was taken on. Mouse
  reporting precedence stays Core-owned: this policy is keyboard-driven
  snapshot-index selection and claims no mouse events.
- No `bitty.terminal.*` reads, no event subscriptions, no streaming: a
  snapshot is point-in-time with no freshness promise, and fresh results
  require an explicit new open.
- Version/capability mismatch disables with a diagnostic and no partial
  activation: no commands exist for the generation.
- Settings reads are declarations-bound. `row_count` and `max_bytes` are the
  only `bitty.settings.get` keys, so exactly those two are declared in the
  manifest; an undeclared read on the host is `E_SETTINGS_UNDECLARED` and
  aborts activation. If a read is still denied (or the bridge is absent), the
  plugin keeps activating on the shipped defaults and records one bounded
  diagnostic (`settings_denied` / `settings_diagnostic`) instead of aborting
  or failing silently.
- Bounds mirror the SDK/Core test caps: 256-byte needle, 16 rows / 4096 bytes
  per query, 128-byte scope ids, 8192-byte copy bound (host-enforced with a
  `truncated` flag). Shapes are normative; numbers are harness placeholders.

## Non-goals (CTX-0003 only)

- No Core changes, no host-API implementation, no SDK changes.
- No registry onboarding and no release; the package stays a candidate until
  CTX-0004 independently verifies clipboard denial, mouse precedence, and
  stale-line evidence plus Core W-144 parity.
- No live per-view binding, viewport navigation, or Core selection
  lifecycles: those stay Core-owned; the mock covers persisted history
  snapshots plus the clipboard export only.

## Compat

The host validates `plugin-api ^1.0` before activation and fails closed on
mismatch. The plugin repeats the major-version gate at load as
defense in depth: on mismatch it records `disabled_reason` and registers
nothing for the generation.

## SDK pin note

`package.json` pins `bitty-plugin-sdk` to `f6fc2f763aa398c0b9bb33fadfe06f0b86dbc0d2`,
the merge commit of PR #152 (CTX-1225: manifest `[settings]` linting plus the
MockHost declared-key gate). The previously pinned `d915535` (PR #144,
CTX-0066, W-139 history/search/selection surface) predates `[settings]`, so
its linter rejected the declarations this plugin now requires. Every
spelling and bound used here (`history.transcript.query` / `selection.copy`,
the `history.transcript.read` / `clipboard.write` gate pair, the 8-category
denial taxonomy, the settings kinds and bounds) derives from merged SDK
surfaces plus the accepted contracts and the Core host commits above, never
from an open PR branch.

## Prerequisites (CTX-0002 acceptance)

Search-selection contract accepted (bitty-terminal-docs `b0514e6`, PR #187);
W-131 accepted (bitty-docs `21d63dc`); W-137 accepted (bitty-plugins-docs
`002c7ce`); RFC-0004 accepted (bitty-docs `adbb787`, PR #434, W-139
successor); Core host W-143 (bitty `0d50b436`) + history-read (bitty
`76fa42d6`); W-138 specify issue closed; OQ-075 open questions tracked (not
a contract gate). Core owns selection semantics and clipboard gates; public
APIs must handle mouse precedence and stale identities.

CTX-0001 -> CTX-0002 -> CTX-0003 -> CTX-0004 maps to GitHub Issues 4, 3,
2, 1. CTX-0001 (bootstrap) is complete; CTX-0002 (contract readiness) is
accepted; CTX-0003 implementation is in review.
