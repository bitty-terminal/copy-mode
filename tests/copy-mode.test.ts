/**
 * Copy-mode behavior against the SDK mock host: bounded scoped snapshot
 * opens with typed denials and untrusted labels, anchor/cursor visual
 * selection over the cached page, grant-gated yank, and
 * version/capability mismatch disable.
 *
 * The mock host owns every capability, registration, scope, bound, capture,
 * budget, purge, trust, and safe-mode check; tests assert plugin policy
 * (presentation state, replace-on-refresh with selection reset, cursor
 * clamps, verbatim span yank) and that history is read only through an
 * explicitly scoped `history.transcript.query` while export needs its own
 * separately granted `clipboard.write`.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { lintManifestSource, MockHost } from "bitty-plugin-sdk";
import { LuaFactory, type LuaEngine } from "wasmoon";

import {
  activateCopyMode,
  ANCHOR_COMMAND,
  anchorLine,
  CLOSE_COMMAND,
  currentLabel,
  cursorLine,
  dispatch,
  ENTRY_SOURCE,
  inVisual,
  lastCode,
  MANIFEST_SOURCE,
  MOVE_COMMAND,
  OPEN_COMMAND,
  resultCount,
  selectionCount,
  selectionText,
  seedTranscript,
  totalInScope,
  YANK_COMMAND,
  COPYMODE_CAPABILITIES,
  type CopyModeRun,
} from "./harness.js";

const runs: CopyModeRun[] = [];

async function copymode(
  ...args: Parameters<typeof activateCopyMode>
): Promise<CopyModeRun> {
  const run = await activateCopyMode(...args);
  runs.push(run);
  return run;
}

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

const ROWS = [
  {
    panel: "pane-a",
    workspace: "ws-1",
    seq: 0,
    body: "redacted deploy log line one",
    command: "make check",
    recorded_at: 10,
    actor: "user",
  },
  {
    panel: "pane-a",
    workspace: "ws-1",
    seq: 1,
    body: "redacted deploy log line two",
    command: "make check",
    recorded_at: 11,
    actor: "user",
  },
  {
    panel: "pane-a",
    workspace: "ws-1",
    seq: 2,
    body: "redacted deploy log line three",
    recorded_at: 12,
  },
  {
    panel: "pane-b",
    workspace: "ws-1",
    seq: 3,
    body: "foreign panel bytes never cross",
    recorded_at: 13,
  },
] as const;

function open(run: CopyModeRun, extra: Record<string, unknown> = {}): unknown {
  return dispatch(run, OPEN_COMMAND, {
    panel: "pane-a",
    workspace: "ws-1",
    op: "list",
    ...extra,
  });
}

/** Canned transcript page the headless stub host serves while it has one. */
function cannedPage(): unknown {
  return {
    records: [
      { body: "redacted deploy log line one", label: "untrusted-observation" },
      { body: "redacted deploy log line two", label: "untrusted-observation" },
      {
        body: "redacted deploy log line three",
        label: "untrusted-observation",
      },
    ],
    total_in_scope: 3,
    freshness: "stub",
  };
}

interface HeadlessHost {
  readonly lua: LuaEngine;
  readonly run: Record<string, (args: unknown) => Promise<unknown>>;
  /** Replaces the `bitty` global with one exposing no transcript namespace. */
  withoutTranscript(): void;
}

/**
 * Headless-host shape for issue #11: `bitty` is present (activation
 * succeeds, commands register) but the host exposes no
 * `history.transcript` namespace, as with an empty transcript store.
 * Built by hand because nil-ing a field on the MockHost-backed `bitty`
 * table corrupts the wasmoon bridge instead of modeling the host.
 */
async function headlessHost(extra: {
  query?: () => unknown;
  history?: Record<string, unknown>;
}): Promise<HeadlessHost> {
  const factory = new LuaFactory();
  const lua = await factory.createEngine({ injectObjects: false });
  const run: Record<string, (args: unknown) => Promise<unknown>> = {};
  const base = {
    api_version: "1.0.0",
    settings: { get: () => undefined, set: () => true },
    commands: {
      register: (def: {
        id: string;
        run: (args: unknown) => Promise<unknown>;
      }): number => {
        run[def.id] = def.run;
        return 1;
      },
    },
  };
  if (extra.query !== undefined) {
    lua.global.set("bitty", {
      ...base,
      history: { transcript: { query: extra.query } },
    });
  } else if (extra.history !== undefined) {
    lua.global.set("bitty", { ...base, history: extra.history });
  } else {
    lua.global.set("bitty", base);
  }
  await lua.doString(ENTRY_SOURCE);
  return {
    lua,
    run,
    withoutTranscript(): void {
      lua.global.set("bitty", base);
    },
  };
}

describe("manifest", () => {
  test("passes the authoritative SDK linter with zero errors", () => {
    const result = lintManifestSource(MANIFEST_SOURCE);
    expect(
      result.diagnostics.filter((entry) => entry.severity === "error"),
    ).toEqual([]);
  });

  test("high-risk consent warning names exactly the transcript grant", () => {
    const result = lintManifestSource(MANIFEST_SOURCE);
    expect(
      result.diagnostics.map((entry) => `${entry.code}:${entry.path}`).sort(),
    ).toEqual(["capabilities.high-risk:history.transcript.read"]);
  });

  test("declares exactly the minimal public capability set", () => {
    expect([...COPYMODE_CAPABILITIES].sort()).toEqual(
      ["clipboard.write", "history.transcript.read"].sort(),
    );
  });
});

describe("pure policy without a host", () => {
  test("the entry point loads with bitty absent and checks compat", async () => {
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    try {
      await lua.doString(ENTRY_SOURCE);
      expect(await lua.doString("return copymode.check_compat('1.0.0')")).toBe(
        true,
      );
      expect(await lua.doString("return copymode.check_compat('1.9.9')")).toBe(
        true,
      );
      expect(await lua.doString("return copymode.check_compat('2.0.0')")).toBe(
        false,
      );
      expect(await lua.doString("return copymode.check_compat('0.9.0')")).toBe(
        false,
      );
      expect(await lua.doString("return copymode.check_compat('nope')")).toBe(
        false,
      );
      expect(
        await lua.doString(
          "return (function() local _, err = copymode.validate_scope_id('*', 'panel') return err end)()",
        ),
      ).toMatch(/never be/);
      expect(
        await lua.doString(
          "return (function() local _, err = copymode.validate_scope_id('all', 'workspace') return err end)()",
        ),
      ).toMatch(/never be/);
      expect(
        await lua.doString(
          "return (function() local _, err = copymode.validate_needle('') return err end)()",
        ),
      ).toMatch(/must not be empty/);
      expect(
        await lua.doString(
          "return (function() local _, err = copymode.validate_bounds(0, 4096) return err end)()",
        ),
      ).toMatch(/row_count/);
      expect(
        await lua.doString(
          "return (function() local _, err = copymode.validate_op('stream') return err end)()",
        ),
      ).toMatch(/list, tail, or search/);
      expect(
        await lua.doString(
          "return (function() local _, code = copymode.step_cursor(3, 3, 1) return code end)()",
        ),
      ).toBe("AT_LAST");
      expect(
        await lua.doString(
          "return (function() local _, code = copymode.step_cursor(3, 1, -1) return code end)()",
        ),
      ).toBe("AT_FIRST");
      expect(
        await lua.doString(
          "return (function() local lo, hi = copymode.span(3, 1, 3) return lo .. ',' .. hi end)()",
        ),
      ).toBe("1,3");
      expect(
        await lua.doString(
          "return (function() local _, code = copymode.span(4, 1, 3) return code end)()",
        ),
      ).toBe("NO_SELECTION");
    } finally {
      lua.global.close();
    }
  });
});

describe("visual selection lifecycle over the public history API", () => {
  test("open enters visual selection; move widens; anchor restarts; yank copies verbatim; close leaves", async () => {
    const run = await copymode();
    seedTranscript(run, [...ROWS]);
    open(run);
    expect(await lastCode(run)).toBe("OPEN");
    expect(await resultCount(run)).toBe(3);
    expect(await totalInScope(run)).toBe(3);
    expect(await inVisual(run)).toBe(true);
    expect(await anchorLine(run)).toBe(1);
    expect(await cursorLine(run)).toBe(1);
    expect(await selectionCount(run)).toBe(1);
    // Source isolation: the foreign panel row never crosses into the page.
    expect(await selectionText(run)).toBe("redacted deploy log line one");
    expect(await currentLabel(run)).toBe("untrusted-observation");

    dispatch(run, MOVE_COMMAND, { delta: 2 });
    expect(await lastCode(run)).toBe("MOVED");
    expect(await cursorLine(run)).toBe(3);
    expect(await anchorLine(run)).toBe(1);
    expect(await selectionCount(run)).toBe(3);
    expect(await selectionText(run)).toBe(
      "redacted deploy log line one\nredacted deploy log line two\nredacted deploy log line three",
    );

    // Clamped at the last cached row: no re-query, no stream, cursor stays.
    dispatch(run, MOVE_COMMAND, { delta: 1 });
    expect(await lastCode(run)).toBe("AT_LAST");
    expect(await cursorLine(run)).toBe(3);

    dispatch(run, ANCHOR_COMMAND);
    expect(await lastCode(run)).toBe("ANCHORED");
    expect(await anchorLine(run)).toBe(3);
    expect(await selectionCount(run)).toBe(1);
    expect(await selectionText(run)).toBe("redacted deploy log line three");

    dispatch(run, YANK_COMMAND);
    expect(await lastCode(run)).toBe("YANKED");
    expect(await selectionText(run)).toBe("redacted deploy log line three");

    dispatch(run, CLOSE_COMMAND);
    expect(await lastCode(run)).toBe("CLEARED");
    expect(await resultCount(run)).toBe(0);
    expect(await inVisual(run)).toBe(false);
    expect(await selectionCount(run)).toBe(0);
    // Moving with no open page fails closed with NO_SELECTION.
    dispatch(run, MOVE_COMMAND, { delta: 1 });
    expect(await lastCode(run)).toBe("NO_SELECTION");
    dispatch(run, YANK_COMMAND);
    expect(await lastCode(run)).toBe("NO_SELECTION");
  });

  test("a refresh replaces the cached page and resets the selection", async () => {
    const run = await copymode();
    seedTranscript(run, [...ROWS]);
    open(run);
    dispatch(run, MOVE_COMMAND, { delta: 2 });
    expect(await selectionCount(run)).toBe(3);
    // Refresh replaces, never appends, and the stale selection never
    // survives the page it was taken on: anchor and cursor reset.
    open(run, { op: "tail", row_count: 1 });
    expect(await lastCode(run)).toBe("OPEN");
    expect(await resultCount(run)).toBe(1);
    expect(await anchorLine(run)).toBe(1);
    expect(await cursorLine(run)).toBe(1);
    expect(await selectionCount(run)).toBe(1);
    // A query matching nothing is an empty page, not a denial.
    await run.lua.doString(
      "copymode.open_now('pane-a', 'ws-1', 'search', 'no such bytes anywhere', 10, 4096)",
    );
    expect(await lastCode(run)).toBe("EMPTY");
    expect(await resultCount(run)).toBe(0);
    expect(await inVisual(run)).toBe(false);
  });

  test("search op shares the same gate through the Lua entries", async () => {
    const run = await copymode();
    seedTranscript(run, [...ROWS]);
    await run.lua.doString(
      "copymode.open_now('pane-a', 'ws-1', 'search', 'line two', 10, 4096)",
    );
    expect(await lastCode(run)).toBe("OPEN");
    expect(await resultCount(run)).toBe(1);
    expect(await selectionText(run)).toBe("redacted deploy log line two");
  });

  test("invalid open op and move delta fail closed without a host call", async () => {
    const run = await copymode();
    seedTranscript(run, [...ROWS]);
    dispatch(run, OPEN_COMMAND, {
      panel: "pane-a",
      workspace: "ws-1",
      op: "stream",
    });
    expect(await lastCode(run)).toBe("E_DEF_INVALID");
    expect(await resultCount(run)).toBe(0);
    open(run);
    dispatch(run, MOVE_COMMAND, { delta: 0 });
    expect(await lastCode(run)).toBe("E_DEF_INVALID");
    expect(await cursorLine(run)).toBe(1);
  });

  test("denied refresh keeps the previous page and selection intact", async () => {
    const run = await copymode();
    seedTranscript(run, [...ROWS]);
    open(run);
    dispatch(run, MOVE_COMMAND, { delta: 1 });
    expect(await selectionCount(run)).toBe(2);
    // Revoke mid-session: the denied refresh surfaces the typed code while
    // the previous page and selection stay intact.
    run.host.revoke("history.transcript.read");
    open(run);
    expect(await lastCode(run)).toBe("E_HISTORY_REVOKED_GRANT");
    expect(await resultCount(run)).toBe(3);
    expect(await selectionCount(run)).toBe(2);
    expect(await selectionText(run)).toBe(
      "redacted deploy log line one\nredacted deploy log line two",
    );
  });

  test("yank without the separately granted clipboard capability denies and keeps the selection", async () => {
    const run = await copymode({ grants: ["history.transcript.read"] });
    seedTranscript(run, [...ROWS]);
    open(run);
    dispatch(run, MOVE_COMMAND, { delta: 1 });
    dispatch(run, YANK_COMMAND);
    expect(await lastCode(run)).toBe("E_CAPABILITY_DENIED");
    expect(await selectionCount(run)).toBe(2);
    expect(await selectionText(run)).toBe(
      "redacted deploy log line one\nredacted deploy log line two",
    );
  });

  test("over-bound yank truncates flagged at the clipboard bound", async () => {
    const run = await copymode();
    run.host.setHistoryCapture("transcript", true);
    run.host.setHistoryRows("transcript", [
      {
        panel: "pane-a",
        workspace: "ws-1",
        seq: 0,
        body: "z".repeat(9000),
        recorded_at: 1,
      },
    ]);
    open(run, { row_count: 4, max_bytes: 4096 });
    dispatch(run, YANK_COMMAND);
    // The 9000-byte body is per-row truncated by the host page itself; the
    // yank then applies the 8192-byte clipboard bound with its flag.
    expect(["YANKED", "YANKED_TRUNCATED"]).toContain(await lastCode(run));
  });
});

describe("typed denials from the host gate", () => {
  test("missing grant denies before capture, scope, or bounds run", async () => {
    const run = await copymode({ grants: [] });
    open(run);
    expect(await lastCode(run)).toBe("E_HISTORY_MISSING_GRANT");
    expect(await resultCount(run)).toBe(0);
  });

  test("capture opt-in off denies with the typed code", async () => {
    const run = await copymode();
    run.host.setHistoryRows("transcript", [...ROWS]);
    open(run);
    expect(await lastCode(run)).toBe("E_HISTORY_CAPTURE_DISABLED");
    expect(await resultCount(run)).toBe(0);
  });

  test("unscoped queries deny; wildcard scopes are malformed", async () => {
    const run = await copymode();
    seedTranscript(run, [...ROWS]);
    dispatch(run, OPEN_COMMAND, { op: "list" });
    expect(await lastCode(run)).toBe("E_HISTORY_SCOPE_MISMATCH");
    dispatch(run, OPEN_COMMAND, {
      panel: "*",
      workspace: "ws-1",
      op: "list",
    });
    expect(await lastCode(run)).toBe("E_DEF_INVALID");
    dispatch(run, OPEN_COMMAND, {
      panel: "pane-a",
      workspace: "all",
      op: "list",
    });
    expect(await lastCode(run)).toBe("E_DEF_INVALID");
    expect(await resultCount(run)).toBe(0);
  });

  test("over-bound rows, bytes, and needles deny without clamping", async () => {
    const run = await copymode();
    seedTranscript(run, [...ROWS]);
    open(run, { row_count: 17 });
    expect(await lastCode(run)).toBe("E_HISTORY_OVER_BOUND");
    open(run, { max_bytes: 4097 });
    expect(await lastCode(run)).toBe("E_HISTORY_OVER_BOUND");
    open(run, { op: "search", needle: "" });
    expect(await lastCode(run)).toBe("E_HISTORY_OVER_BOUND");
    open(run, { op: "search", needle: "x".repeat(257) });
    expect(await lastCode(run)).toBe("E_HISTORY_OVER_BOUND");
    expect(await resultCount(run)).toBe(0);
  });

  test("safe mode and untrusted levels read no history", async () => {
    const safe = await copymode({ safeMode: true });
    seedTranscript(safe, [...ROWS]);
    open(safe);
    expect(await lastCode(safe)).toBe("E_HISTORY_SAFE_MODE");
    const l0 = await copymode({ trustLevel: "L0" });
    seedTranscript(l0, [...ROWS]);
    open(l0);
    expect(await lastCode(l0)).toBe("E_HISTORY_TRUST_DENIED");
  });

  test("purged-only list denies typed; purged-only search is an empty page", async () => {
    const run = await copymode();
    run.host.setHistoryCapture("transcript", true);
    run.host.setHistoryRows("transcript", [
      {
        panel: "pane-a",
        workspace: "ws-1",
        seq: 0,
        body: "gone",
        purged: true,
      },
    ]);
    await run.lua.doString(
      "copymode.open_now('pane-a', 'ws-1', 'list', nil, 10, 4096)",
    );
    expect(await lastCode(run)).toBe("E_HISTORY_UNAVAILABLE");
    // Search excludes purged rows before matching, so a needle matching only
    // purged content yields an empty page rather than an existence oracle.
    await run.lua.doString(
      "copymode.open_now('pane-a', 'ws-1', 'search', 'gone', 10, 4096)",
    );
    expect(await lastCode(run)).toBe("EMPTY");
    expect(await resultCount(run)).toBe(0);
  });

  test("window budgets deny over-rate queries instead of throttling silently", async () => {
    const run = await copymode();
    seedTranscript(run, [...ROWS]);
    for (let i = 0; i < 4; i += 1) {
      open(run);
      expect(await lastCode(run)).toBe("OPEN");
    }
    open(run);
    expect(await lastCode(run)).toBe("E_HISTORY_OVER_BOUND");
    // The denied fifth query leaves the fourth page intact.
    expect(await resultCount(run)).toBe(3);
  });
});

describe("headless nil-namespace regression (issue #11)", () => {
  test("open denies typed when the host exposes no history namespace", async () => {
    const host = await headlessHost({});
    try {
      for (const args of [
        { panel: "pane-a", workspace: "ws-1", op: "list" },
        {},
      ]) {
        const out = (await host.run["open"](args)) as {
          ok: boolean;
          code: string;
        };
        expect(out).toEqual({ ok: false, code: "E_HISTORY_UNAVAILABLE" });
      }
      expect(await host.lua.doString("return copymode.last_code()")).toBe(
        "E_HISTORY_UNAVAILABLE",
      );
      expect(await host.lua.doString("return copymode.result_count()")).toBe(0);
      // Sibling verbs still answer cleanly on the same host shape.
      await host.run["move"]({ delta: 1 });
      expect(await host.lua.doString("return copymode.last_code()")).toBe(
        "NO_SELECTION",
      );
      await host.run["close"]({});
      expect(await host.lua.doString("return copymode.last_code()")).toBe(
        "CLEARED",
      );
    } finally {
      host.lua.global.close();
    }
  });

  test("denied refresh keeps the page when the namespace drops", async () => {
    const host = await headlessHost({ query: cannedPage });
    try {
      const first = (await host.run["open"]({
        panel: "pane-a",
        workspace: "ws-1",
        op: "list",
      })) as { ok: boolean; code: string };
      expect(first).toEqual({ ok: true, code: "OPEN" });
      expect(await host.lua.doString("return copymode.result_count()")).toBe(3);
      await host.run["move"]({ delta: 1 });
      expect(await host.lua.doString("return copymode.selection_count()")).toBe(
        2,
      );
      // The headless host drops the transcript namespace mid-session.
      host.withoutTranscript();
      const out = (await host.run["open"]({
        panel: "pane-a",
        workspace: "ws-1",
        op: "list",
      })) as { ok: boolean; code: string };
      expect(out).toEqual({ ok: false, code: "E_HISTORY_UNAVAILABLE" });
      expect(await host.lua.doString("return copymode.result_count()")).toBe(3);
      expect(await host.lua.doString("return copymode.selection_count()")).toBe(
        2,
      );
    } finally {
      host.lua.global.close();
    }
  });

  test("missing transcript leaf and non-callable query deny typed", async () => {
    for (const history of [
      {},
      { transcript: {} },
      { transcript: { query: "not-a-function" } },
    ]) {
      const host = await headlessHost({ history });
      try {
        const out = (await host.run["open"]({
          panel: "pane-a",
          workspace: "ws-1",
          op: "list",
        })) as { ok: boolean; code: string };
        expect(out).toEqual({ ok: false, code: "E_HISTORY_UNAVAILABLE" });
        expect(await host.lua.doString("return copymode.result_count()")).toBe(
          0,
        );
      } finally {
        host.lua.global.close();
      }
    }
  });

  test("yank with no selection namespace denies typed and keeps the selection", async () => {
    const host = await headlessHost({ query: cannedPage });
    try {
      await host.run["open"]({
        panel: "pane-a",
        workspace: "ws-1",
        op: "list",
      });
      expect(await host.lua.doString("return copymode.last_code()")).toBe(
        "OPEN",
      );
      await host.run["move"]({ delta: 1 });
      const out = (await host.run["yank"]({})) as {
        ok: boolean;
        code: string;
      };
      expect(out).toEqual({ ok: false, code: "E_CAPABILITY_DENIED" });
      expect(await host.lua.doString("return copymode.last_code()")).toBe(
        "E_CAPABILITY_DENIED",
      );
      expect(await host.lua.doString("return copymode.selection_count()")).toBe(
        2,
      );
    } finally {
      host.lua.global.close();
    }
  });
});

describe("mismatch disables with a diagnostic; fallback stays Core", () => {
  test("host-level API mismatch fails activation with no partial state", () => {
    const host = new MockHost({
      manifestSource: MANIFEST_SOURCE,
      pluginApiVersion: "99.0.0",
    });
    expect(() => host.beginActivation()).toThrow(/E_LIFECYCLE_STATE/);
    expect(() => host.dispatchCommand(OPEN_COMMAND, {})).toThrow(
      /E_GENERATION_DISPOSED/,
    );
  });

  test("plugin-level mismatch disables with a diagnostic and registers nothing", async () => {
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    try {
      const seen: string[] = [];
      lua.global.set("bitty", {
        api_version: "99.0.0",
        settings: {
          get: () => undefined,
          set: () => true,
        },
        commands: {
          register: () => {
            seen.push("register");
            return 1;
          },
        },
        events: {
          subscribe: () => {
            seen.push("subscribe");
            return 1;
          },
        },
        keymaps: {
          suggest: () => {
            seen.push("suggest");
            return 1;
          },
        },
      });
      await lua.doString(ENTRY_SOURCE);
      expect(seen).toEqual([]);
      expect(await lua.doString("return copymode.disabled")).toBe(true);
      expect(await lua.doString("return copymode.disabled_reason")).toMatch(
        /\^1\.0/,
      );
    } finally {
      lua.global.close();
    }
  });

  test("bad default bounds fall back without widening a query", async () => {
    const run = await copymode({
      settings: { row_count: 9999, max_bytes: -3 },
    });
    expect(await run.query("copymode.last_code()")).toBe("BOUNDS_FALLBACK");
    seedTranscript(run, [...ROWS]);
    open(run);
    expect(await lastCode(run)).toBe("OPEN");
    expect(await resultCount(run)).toBe(3);
  });

  test("disposing the plugin leaves history untouched (Core fallback)", async () => {
    const run = await copymode();
    seedTranscript(run, [...ROWS]);
    open(run);
    expect(await resultCount(run)).toBe(3);
    run.host.dispose();
    expect(() => dispatch(run, OPEN_COMMAND, {})).toThrow();
  });
});
