# copy-mode

W-135 S-3 (CTX-0003) Lua policy package for Bitty modal copy mode: visual
selection over the public history snapshot API only. Accepted contracts are
the search-selection contract (bitty-terminal-docs `b0514e6`, PR #187), W-131
(storage-and-history boundary, bitty-docs `21d63dc`), W-137
(history-and-storage policy, bitty-plugins-docs `002c7ce`), and RFC-0004
(bitty-docs `adbb787`, PR #434, W-139 successor); the SDK binding is
bitty-plugin-sdk at `d915535` (merged CTX-0066 PR #144, W-139 surface). Core
host evidence is W-143 (bitty `0d50b436`) plus the history-read host (bitty
`76fa42d6`).

## Scope

- `bitty-plugin.toml`: plugin id `bitty-terminal.copy-mode`, version `0.0.1`,
  compat `bitty >=0.5,<1.0` with `plugin-api ^1.0`, exactly two capabilities
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
  and denial parity against a foreign manifest plus the no-weakening proof.

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

`package.json` pins `bitty-plugin-sdk` to `d9155350510f672ad683ff8f25dea76e97b28f89`,
the merge commit of PR #144 (CTX-0066, W-139 history/search/selection
surface). Every spelling and bound used here (`history.transcript.query` /
`selection.copy`, the `history.transcript.read` / `clipboard.write` gate
pair, the 8-category denial taxonomy) derives from that merged surface plus
the accepted contracts and the Core host commits above, never from an open
PR branch.

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
