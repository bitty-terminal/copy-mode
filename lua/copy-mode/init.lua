-- Entry point for Copy mode (bitty-terminal.copy-mode): modal
-- visual-selection policy over the PUBLIC history snapshot API only.
--
-- Accepted contracts: the search-selection contract (bitty-terminal-docs
-- b0514e6, PR #187), W-131 (storage-and-history boundary, bitty-docs
-- 21d63dc), W-137 (history-and-storage policy, bitty-plugins-docs 002c7ce),
-- and RFC-0004 (bitty-docs adbb787, PR #434, W-139 successor) bound in the
-- merged SDK surface (bitty-plugin-sdk d915535, CTX-0066 PR #144) with Core
-- host evidence W-143 (bitty 0d50b436) plus the history-read host (bitty
-- 76fa42d6). This file re-expresses the extension-owned copy-mode policy
-- (W-135: modal cursor and keymap handling is policy, selection semantics
-- and the clipboard permission gate stay Core mechanisms) as extension-side
-- presentation state over bounded snapshot queries. It never mutates
-- Terminal Truth: queries go through `bitty.history.transcript.query` (the
-- host owns capture, scope, bounds, and budgets), export goes through
-- `bitty.selection.copy` (Core owns the clipboard permission gate and the
-- 8192-byte bound), and every record body is treated as untrusted
-- observation text that is selected or copied verbatim, never executed,
-- interpolated, or used as a path, command, or scope.
--
-- The host evaluates this file once per plugin activation and owns every
-- resource created here for the lifetime of that generation. The code stays
-- inside the Lua 5.1 grammar (the `just lua` gate).
--
-- Visual selection model: `open` installs one bounded snapshot page and
-- enters visual mode with the anchor and the cursor on the first row; `move`
-- steps the cursor over the cached page (pure navigation, no host call);
-- `anchor` restarts the selection at the cursor; `yank` copies the rows
-- between anchor and cursor (inclusive) joined verbatim with newline
-- separators; `close` drops the page and leaves visual mode. A refresh
-- replaces the cached page AND resets the anchor and cursor, so a selection
-- never survives the page it was taken on: snapshot row identities are
-- point-in-time, and stale identities never address a refreshed page. Mouse
-- reporting precedence stays Core-owned: this policy is keyboard-driven
-- snapshot-index selection, claims no mouse events, and subscribes to none.
--
-- Single documented over-bound rule (see README): an over-bound local
-- default (row/byte budget from settings) falls back to the documented
-- default before any host call; every host-side bound (scope shape, needle
-- shape, row/byte caps, capture opt-in, window budgets, purge, trust, safe
-- mode) is surfaced verbatim as the host's typed denial with the previous
-- page and selection kept intact. Nothing is truncated by the plugin,
-- nothing is retried silently, and a refresh replaces the cached page rather
-- than appending to it.
--
-- The plugin never subscribes to the Event Bus and never polls: a snapshot
-- query is a point-in-time read with no freshness promise, and polling one
-- would reconstitute a stream. Fresh results require an explicit new `open`.

local M = {}

M.PLUGIN_ID = "bitty-terminal.copy-mode"

-- Bounds re-declared here so extension-side defaults honor the same ceilings
-- the host enforces. The SHAPE (explicit scope, explicit row/byte bounds,
-- needle ceiling, per-plugin window budgets) is normative; the numbers mirror
-- the SDK mock/Core test caps (harness placeholders, never wire truth) and
-- the W-135 evidence (SEARCH_MAX_PATTERN_LEN 256, CLIPBOARD_MAX_BYTES 8192).
M.MAX_NEEDLE_BYTES = 256 -- search needle byte cap
M.MAX_ROWS_PER_QUERY = 16 -- row-count ceiling per snapshot query
M.MAX_BYTES_PER_QUERY = 4096 -- page byte ceiling per snapshot query
M.MAX_SCOPE_ID_BYTES = 128 -- scope-id (panel/workspace) byte ceiling
M.COPY_MAX_BYTES = 8192 -- selection-copy bound (host-enforced, truncated flag)
M.DEFAULT_ROW_COUNT = 10 -- default page depth when settings carry none
M.DEFAULT_MAX_BYTES = 4096 -- default page byte budget when settings carry none
M.REQUIRED_API_MAJOR = 1 -- manifest declares plugin-api ^1.0; same gate here

-- Core-attached label every history record carries (survives truncation). The
-- plugin surfaces it and never treats a body as trusted, however labeled.
M.UNTRUSTED_LABEL = "untrusted-observation"

-- Scalar sentinels surfaced through the queries below.
M.CODE_DISABLED = "E_DISABLED"
M.CODE_NO_RESULTS = "NO_RESULTS"
M.CODE_NO_SELECTION = "NO_SELECTION"
M.CODE_CLEARED = "CLEARED"

-- ---------------------------------------------------------------------------
-- Pure validators (host-independent; the host remains the denial authority)
-- ---------------------------------------------------------------------------

-- Validates one scope id the way the host gate does: 1..128 bytes, never "*",
-- never "all" (any case), no whitespace or control bytes. Returns true, or
-- nil plus a reason. The open path passes values straight to the host so the
-- typed host denial stays the source of truth; this validator serves settings
-- fallback and host-free tests.
function M.validate_scope_id(value, axis)
  if type(value) ~= "string" then
    return nil, "scope." .. tostring(axis) .. " must be a string"
  end
  if #value == 0 then
    return nil, "scope." .. tostring(axis) .. " must not be empty"
  end
  if #value > M.MAX_SCOPE_ID_BYTES then
    return nil, "scope." .. tostring(axis) .. " exceeds 128 bytes"
  end
  if value == "*" then
    return nil, "scope." .. tostring(axis) .. " must never be '*'"
  end
  if string.lower(value) == "all" then
    return nil, "scope." .. tostring(axis) .. " must never be 'all'"
  end
  if string.find(value, "[%c%s]") ~= nil then
    return nil, "scope." .. tostring(axis) .. " must not contain whitespace or control bytes"
  end
  return true
end

-- Validates a search needle: 1..256 bytes. Empty and over-long needles are
-- rejected before any host call on the settings-fallback path; the open path
-- itself relays the host's typed denial.
function M.validate_needle(value)
  if type(value) ~= "string" then
    return nil, "needle must be a string"
  end
  if #value == 0 then
    return nil, "needle must not be empty"
  end
  if #value > M.MAX_NEEDLE_BYTES then
    return nil, "needle exceeds 256 bytes"
  end
  return true
end

-- Validates the explicit page bounds: row_count 1..16, max_bytes 1..4096.
-- Over-bound settings fall back to the defaults (see activation below); the
-- open path relays the host denial for out-of-range explicit arguments.
function M.validate_bounds(row_count, max_bytes)
  if type(row_count) ~= "number" or row_count ~= math.floor(row_count)
    or row_count < 1 or row_count > M.MAX_ROWS_PER_QUERY then
    return nil, "row_count must be an integer 1..16"
  end
  if type(max_bytes) ~= "number" or max_bytes ~= math.floor(max_bytes)
    or max_bytes < 1 or max_bytes > M.MAX_BYTES_PER_QUERY then
    return nil, "max_bytes must be an integer 1..4096"
  end
  return true
end

-- Validates the open op: list, tail, or search. Anything else is rejected
-- before any host call.
function M.validate_op(op)
  if op ~= "list" and op ~= "tail" and op ~= "search" then
    return nil, "op must be list, tail, or search"
  end
  return true
end

-- Pure visual-cursor step over a cached record list. Clamps at the ends:
-- stepping past the last (or first) record keeps the cursor and reports the
-- bound, so navigation can never address a record that is not on the page.
function M.step_cursor(count, cursor, delta)
  if count <= 0 or cursor <= 0 then
    return nil, M.CODE_NO_RESULTS
  end
  local next_index = cursor + delta
  if next_index < 1 then
    return nil, "AT_FIRST"
  end
  if next_index > count then
    return nil, "AT_LAST"
  end
  return next_index
end

-- Pure selection span over anchor and cursor: the inclusive row range between
-- them, ordered low to high. Returns nil plus NO_SELECTION when either end
-- is outside the cached page, so a stale index can never select.
function M.span(anchor, cursor, count)
  if anchor <= 0 or cursor <= 0 or count <= 0 then
    return nil, M.CODE_NO_SELECTION
  end
  if anchor > count or cursor > count then
    return nil, M.CODE_NO_SELECTION
  end
  if anchor <= cursor then
    return anchor, cursor
  end
  return cursor, anchor
end

-- ---------------------------------------------------------------------------
-- Compatibility gate: no partial activation on version mismatch
-- ---------------------------------------------------------------------------

-- The manifest declares plugin-api ^1.0 and the host validates before
-- activation; this is the defense-in-depth twin inside the plugin. When the
-- check fails the module registers nothing (no commands, no keymap, no
-- events, no state) and only records the diagnostic.
function M.check_compat(api_version)
  if type(api_version) ~= "string" then
    return false, "plugin API version is not a string"
  end
  local major = string.match(api_version, "^(%d+)%.")
  if major == nil then
    return false, "unparsable plugin API version '" .. api_version .. "'"
  end
  if tonumber(major) ~= M.REQUIRED_API_MAJOR then
    return false, "requires Plugin API ^1.0, host provides '" .. api_version .. "'"
  end
  return true
end

-- ---------------------------------------------------------------------------
-- Result page: extension-side presentation state (never Terminal Truth)
-- ---------------------------------------------------------------------------

M.disabled = false
M.disabled_reason = ""

local page = {
  scope_panel = nil,
  scope_workspace = nil,
  op = "",
  needle = "",
  row_count = M.DEFAULT_ROW_COUNT,
  max_bytes = M.DEFAULT_MAX_BYTES,
  records = {},
  total_in_scope = 0,
  freshness = "",
  anchor = 0,
  cursor = 0,
  visual = false,
  last_code = "ok",
  last_detail = "",
}

local function note(code, detail)
  page.last_code = code
  page.last_detail = detail or ""
end

-- Host-dependent entries below require the injected `bitty` table; the pure
-- policy above (validators, compat gate, cursor steps, span) works without
-- it. The injected host value arrives as engine userdata, so presence is
-- tested with a nil comparison rather than a type check.
local function has_host()
  return bitty ~= nil
end

local NO_HOST = "NO_HOST"

-- Extracts the E_* host code from a pcall error for typed diagnostics.
local function host_code(err)
  local text = tostring(err)
  local code = string.match(text, "(E_[A-Z_]+)")
  if code ~= nil then
    return code
  end
  return "E_UNKNOWN"
end

-- Host calls return indexable engine values (tables or bridged objects);
-- only nil means "no value". Never gate host-provided values on
-- type() == "table".
local function page_code(outcome)
  if outcome == nil then
    return "E_UNKNOWN"
  end
  return "ok"
end

-- Installs one host-returned page, replacing the previous set (coalescing:
-- refresh replaces, never appends). Records are frozen host values; the
-- plugin keeps the reference but never mutates a record. Entering visual
-- mode resets the anchor and cursor to the first row, so no selection
-- survives the page it was taken on.
local function install_page(result, op, panel, workspace, needle, row_count, max_bytes)
  local records = result.records
  if records == nil then
    records = {}
  end
  page.scope_panel = panel
  page.scope_workspace = workspace
  page.op = op
  page.needle = needle or ""
  page.row_count = row_count
  page.max_bytes = max_bytes
  page.records = records
  local total = result.total_in_scope
  if type(total) ~= "number" then
    total = #records
  end
  page.total_in_scope = total
  local freshness = result.freshness
  if type(freshness) ~= "string" then
    freshness = ""
  end
  page.freshness = freshness
  if #records > 0 then
    page.anchor = 1
    page.cursor = 1
    page.visual = true
    note("OPEN", "")
  else
    page.anchor = 0
    page.cursor = 0
    page.visual = false
    note("EMPTY", "no records in scope for this query")
  end
end

-- Runs one bounded snapshot query against the transcript source and enters
-- visual selection over the delivered page. Scope, bounds, and (for search)
-- the needle travel straight to the host so its typed denial stays
-- authoritative; on denial the previous page and selection are kept intact
-- and only the diagnostic advances.
local function run_open(op, panel, workspace, needle, row_count, max_bytes)
  if not has_host() then
    return false, NO_HOST
  end
  if M.disabled then
    return false, M.CODE_DISABLED
  end
  if M.validate_op(op) == nil then
    note("E_DEF_INVALID", "open op must be list, tail, or search")
    return false, page.last_code
  end
  local opts = {
    scope = { panel = panel, workspace = workspace },
    row_count = row_count,
    max_bytes = max_bytes,
    op = op,
  }
  if op == "search" then
    opts.needle = needle
  end
  local ok, result = pcall(bitty.history.transcript.query, opts)
  if not ok then
    -- Fail closed with the previous page intact: a denied refresh never
    -- widens into an empty set and never leaks which half failed.
    note(host_code(result), "open query denied; previous page kept")
    return false, page.last_code
  end
  if page_code(result) ~= "ok" then
    note("E_UNKNOWN", "open query returned no value; previous page kept")
    return false, page.last_code
  end
  install_page(result, op, panel, workspace, needle, row_count, max_bytes)
  return true, page.last_code
end

local function default_bounds(row_count, max_bytes)
  -- Explicit arguments travel straight to the host so its typed denial stays
  -- authoritative; only absent arguments take the configured defaults.
  local rows = row_count
  if rows == nil then
    rows = M.DEFAULT_ROW_COUNT
  end
  local bytes = max_bytes
  if bytes == nil then
    bytes = M.DEFAULT_MAX_BYTES
  end
  return rows, bytes
end

-- Opens one bounded snapshot page and enters visual selection over it. Needs
-- an explicit panel/workspace scope; every bound the host owns is enforced
-- there and relayed back typed.
function M.open_now(panel, workspace, op, needle, row_count, max_bytes)
  local use_op = op
  if use_op == nil then
    use_op = "list"
  end
  local rows, bytes = default_bounds(row_count, max_bytes)
  return run_open(use_op, panel, workspace, needle, rows, bytes)
end

-- Moves the visual cursor by delta rows over the cached page. Pure
-- navigation: no host call, no re-query, no stream. Clamps at the ends; the
-- anchor stays where it was, widening or narrowing the selection.
function M.move_now(delta)
  if not has_host() then
    return false, NO_HOST
  end
  if M.disabled then
    return false, M.CODE_DISABLED
  end
  if not page.visual then
    note(M.CODE_NO_SELECTION, "no open page to move over")
    return false, page.last_code
  end
  if type(delta) ~= "number" or delta ~= math.floor(delta) or delta == 0 then
    note("E_DEF_INVALID", "move delta must be a nonzero integer")
    return false, page.last_code
  end
  local stepped, bound = M.step_cursor(#page.records, page.cursor, delta)
  if stepped == nil then
    if bound == M.CODE_NO_RESULTS then
      note(bound, "no cached page to navigate")
    else
      note(bound, "already at the cached page bound")
    end
    return false, page.last_code
  end
  page.cursor = stepped
  note("MOVED", "")
  return true, page.last_code
end

-- Restarts the selection at the current cursor row: the anchor follows the
-- cursor, collapsing the span to one row. Pure policy, no host call.
function M.anchor_now()
  if not has_host() then
    return false, NO_HOST
  end
  if M.disabled then
    return false, M.CODE_DISABLED
  end
  if not page.visual then
    note(M.CODE_NO_SELECTION, "no open page to anchor over")
    return false, page.last_code
  end
  page.anchor = page.cursor
  note("ANCHORED", "")
  return true, page.last_code
end

-- Joins the selected span bodies verbatim with newline separators. Bodies
-- are untrusted observation text: concatenated, never interpreted.
local function selected_text()
  local lo, hi = M.span(page.anchor, page.cursor, #page.records)
  if lo == nil then
    return nil
  end
  local parts = {}
  for i = lo, hi do
    local body = page.records[i].body
    if type(body) ~= "string" then
      body = tostring(body)
    end
    parts[#parts + 1] = body
  end
  return table.concat(parts, "\n")
end

-- Exports the selected span through the Core clipboard permission gate.
-- Needs the separately granted `clipboard.write` capability: without it the
-- host denies with E_CAPABILITY_DENIED and the page and selection stay
-- intact. The span text travels verbatim; the plugin adds no interpretation.
function M.yank_now()
  if not has_host() then
    return false, NO_HOST
  end
  if M.disabled then
    return false, M.CODE_DISABLED
  end
  if not page.visual then
    note(M.CODE_NO_SELECTION, "no open page to yank from")
    return false, page.last_code
  end
  local text = selected_text()
  if text == nil then
    note(M.CODE_NO_SELECTION, "no selected span to export")
    return false, page.last_code
  end
  local ok, outcome = pcall(bitty.selection.copy, { text = text })
  if not ok then
    note(host_code(outcome), "export denied; cached page kept")
    return false, page.last_code
  end
  if outcome == nil then
    note("E_UNKNOWN", "export returned no value; cached page kept")
    return false, page.last_code
  end
  if outcome.truncated == true then
    note("YANKED_TRUNCATED", "export applied at the 8192-byte bound")
  else
    note("YANKED", "")
  end
  return true, page.last_code
end

-- Drops the cached page and leaves visual selection. The host holds no
-- per-plugin copy-mode state, so there is nothing further to release; the
-- next open starts fresh.
function M.close_now()
  if not has_host() then
    return false, NO_HOST
  end
  if M.disabled then
    return false, M.CODE_DISABLED
  end
  page.records = {}
  page.total_in_scope = 0
  page.freshness = ""
  page.anchor = 0
  page.cursor = 0
  page.visual = false
  page.needle = ""
  page.op = ""
  note(M.CODE_CLEARED, "cached page dropped; visual selection left")
  return true, page.last_code
end

-- Scalar state queries for tests and diagnostics (plain values only).
function M.in_visual()
  return page.visual
end

function M.result_count()
  return #page.records
end

function M.cursor_line()
  return page.cursor
end

function M.anchor_line()
  return page.anchor
end

-- Row span of the current selection (inclusive, ordered low to high), or
-- 0, 0 when there is no selectable span.
function M.selection_span()
  local lo, hi = M.span(page.anchor, page.cursor, #page.records)
  if lo == nil then
    return 0, 0
  end
  return lo, hi
end

-- Count of selected rows, or 0 when there is no selectable span.
function M.selection_count()
  local lo, hi = M.span(page.anchor, page.cursor, #page.records)
  if lo == nil then
    return 0
  end
  return hi - lo + 1
end

-- Verbatim text of the selected span (newline-joined bodies), or "" when
-- there is no selectable span.
function M.selection_text()
  local text = selected_text()
  if text == nil then
    return ""
  end
  return text
end

-- Surfaces the Core-attached untrusted label of the cursor row. Empty when
-- no row is selected; never synthesized by the plugin.
function M.current_label()
  if page.cursor <= 0 or page.cursor > #page.records then
    return ""
  end
  local label = page.records[page.cursor].label
  if type(label) ~= "string" then
    return ""
  end
  return label
end

function M.total_in_scope()
  return page.total_in_scope
end

function M.needle_text()
  return page.needle
end

function M.scope_text()
  return tostring(page.scope_panel) .. "/" .. tostring(page.scope_workspace)
end

function M.last_code()
  return page.last_code
end

function M.last_detail()
  return page.last_detail
end

-- ---------------------------------------------------------------------------
-- Host wiring. Skipped when the host table is absent so the pure policy
-- above (validators, compat gate, cursor steps, span) stays loadable on its
-- own.
-- ---------------------------------------------------------------------------

-- Diagnostic entry point for tests and operators. Set before the host guard
-- so it exists in every mode.
if copymode == nil then
  copymode = M
end

if bitty == nil then
  return M
end

do
  local compat_ok, compat_err = M.check_compat(bitty.api_version)
  if not compat_ok then
    -- Version/capability mismatch disables with a diagnostic and no partial
    -- activation: nothing below runs, so no command exists for this
    -- generation.
    M.disabled = true
    M.disabled_reason = compat_err
    note(M.CODE_DISABLED, compat_err)
    return M
  end

  local function setting(key, default)
    local value = bitty.settings.get(key)
    if value == nil then
      return default
    end
    return value
  end

  -- Default page bounds: validated, fail-closed to the documented defaults.
  -- A bad configuration never widens a query and never widens authority.
  local default_rows = setting("row_count", M.DEFAULT_ROW_COUNT)
  local default_bytes = setting("max_bytes", M.DEFAULT_MAX_BYTES)
  if M.validate_bounds(default_rows or M.DEFAULT_ROW_COUNT,
      default_bytes or M.DEFAULT_MAX_BYTES) == nil then
    if page.last_code == "ok" then
      note("BOUNDS_FALLBACK", "invalid default bounds; using 10 rows / 4096 bytes")
    end
    default_rows = M.DEFAULT_ROW_COUNT
    default_bytes = M.DEFAULT_MAX_BYTES
  end

  local open_schema = {
    type = "object",
    properties = {
      panel = { type = "string" },
      workspace = { type = "string" },
      op = { type = "string" },
      needle = { type = "string" },
      row_count = { type = "number", minimum = 1 },
      max_bytes = { type = "number", minimum = 1 },
    },
    additionalProperties = false,
  }

  local move_schema = {
    type = "object",
    properties = {
      delta = { type = "number" },
    },
    additionalProperties = false,
  }

  local empty_schema = {
    type = "object",
    properties = {},
    additionalProperties = false,
  }

  local function args_text(args, key)
    if args ~= nil and args[key] ~= nil then
      return args[key]
    end
    return nil
  end

  local function args_value(args, key, fallback)
    if args ~= nil and args[key] ~= nil then
      return args[key]
    end
    return fallback
  end

  bitty.commands.register({
    id = "open",
    title = "Copy mode: open snapshot page",
    description = "Run one bounded transcript snapshot query with an explicit scope and enter visual selection over the cached page.",
    args_schema = open_schema,
    run = function(args)
      local ok, code = M.open_now(
        args_text(args, "panel"),
        args_text(args, "workspace"),
        args_value(args, "op", "list"),
        args_text(args, "needle"),
        args_value(args, "row_count", default_rows),
        args_value(args, "max_bytes", default_bytes))
      return { ok = ok, code = code }
    end,
  })

  bitty.commands.register({
    id = "move",
    title = "Copy mode: move visual cursor",
    description = "Move the visual cursor over the cached page by delta rows; the anchor stays, widening or narrowing the selection.",
    args_schema = move_schema,
    run = function(args)
      local ok, code = M.move_now(args_value(args, "delta", 1))
      return { ok = ok, code = code }
    end,
  })

  bitty.commands.register({
    id = "anchor",
    title = "Copy mode: restart selection",
    description = "Restart the selection at the current cursor row; no host call.",
    args_schema = empty_schema,
    run = function(_args)
      local ok, code = M.anchor_now()
      return { ok = ok, code = code }
    end,
  })

  bitty.commands.register({
    id = "yank",
    title = "Copy mode: yank selection",
    description = "Export the selected span through the clipboard gate; needs the separately granted clipboard.write capability.",
    args_schema = empty_schema,
    run = function(_args)
      local ok, code = M.yank_now()
      return { ok = ok, code = code }
    end,
  })

  bitty.commands.register({
    id = "close",
    title = "Copy mode: close page",
    description = "Drop the cached page and leave visual selection; the next open starts fresh.",
    args_schema = empty_schema,
    run = function(_args)
      local ok, code = M.close_now()
      return { ok = ok, code = code }
    end,
  })
end

return M
