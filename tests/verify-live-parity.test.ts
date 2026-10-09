/**
 * CTX-0004 independent verification: live-host parity pins.
 *
 * Each section pins the plugin against independently observed LIVE Core
 * behavior at `origin/main` (history-read host `76fa42d6`, W-143 host
 * `0d50b436`, clipboard bound in `bitty-platform`), proven by the
 * ephemeral Rust scratch suite `ctx0004_copymode_live` (15 tests, all
 * green) plus Core's own suites (`history_read` 25, `search_host` 16,
 * capability 24). The mock host is the merged SDK surface at `d915535`
 * (CTX-0066 PR #144); its `historyQuery` documents the same check order
 * the live `HistoryGate::query` enforces, and the order tests below prove
 * the mock honors it. Nothing here changes plugin behavior: no Lua or
 * manifest edits, verification evidence only.
 *
 * Live citations use the form `LIVE <crate>::<path> @<commit>`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  activateCopyMode,
  ANCHOR_COMMAND,
  anchorLine,
  CLOSE_COMMAND,
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
  YANK_COMMAND,
  type CopyModeRun,
} from "./harness.js";

/**
 * Fail-soft gate: every parity pin below runs hermetic against the SDK mock
 * (live behavior is cited, never read from disk), so the suite is already
 * green without a Core checkout. The probe below still resolves Core via
 * BITTY_WORKSPACE (or the relative workspace fallback, never a hardcoded
 * path) and skips with an explicit notice when no checkout is present —
 * unblocking the plugins CI job (bitty-terminal/bitty-plugins#73) which has
 * no `bitty` alongside. With BITTY_WORKSPACE pointed at a real workspace the
 * probe executes (proves the skip never masks a real run).
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = dirname(HERE);

function workspaceRoot(): string {
  const fromEnv = process.env.BITTY_WORKSPACE;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return resolve(REPO_ROOT, "..", "..", "..", "..", "..");
}

function coreFile(...parts: string[]): string {
  return join(workspaceRoot(), "bitty", ...parts);
}

function coreExists(path: string): boolean {
  try {
    return existsSync(coreFile(path));
  } catch {
    return false;
  }
}

function coreDir(): string {
  return coreFile("");
}

function freshExists(path: string): boolean {
  const rel = path.split("/").join("/");
  try {
    execFileSync(
      "git",
      ["-C", coreDir(), "cat-file", "-e", `origin/main:${rel}`],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return coreExists(path);
  }
}

const HISTORY_READ = join(
  "crates",
  "bitty-plugin-host",
  "src",
  "history_read.rs",
);

const CORE_PRESENT = freshExists(HISTORY_READ);

if (!CORE_PRESENT) {
  console.log(
    `live Core not present at ${coreDir()} ` +
      `(BITTY_WORKSPACE=${process.env.BITTY_WORKSPACE ?? "(unset, relative fallback)"}); ` +
      `skipping live-identity probe, mock-pinned assertions still run`,
  );
}

describe.skipIf(!CORE_PRESENT)("live Core presence (fail-soft probe)", () => {
  test("Core history-read gate exists at the pinned surface", () => {
    expect(freshExists(HISTORY_READ)).toBe(true);
  });
});

const runs: CopyModeRun[] = [];

async function verify(
  ...args: Parameters<typeof activateCopyMode>
): Promise<CopyModeRun> {
  const run = await activateCopyMode(...args);
  runs.push(run);
  return run;
}

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

/** Code lines with full-line and trailing `--` comments removed. */
function codeLines(): string[] {
  return ENTRY_SOURCE.split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .map((line) => {
      const cut = line.indexOf("--");
      return (cut < 0 ? line : line.slice(0, cut)).trim();
    })
    .filter((line) => line.length > 0);
}

const ROWS = [
  {
    panel: "pane-a",
    workspace: "ws-1",
    seq: 0,
    body: "redacted deploy log line one",
    recorded_at: 10,
  },
  {
    panel: "pane-a",
    workspace: "ws-1",
    seq: 1,
    body: "redacted deploy log line two",
    recorded_at: 11,
  },
  {
    panel: "pane-a",
    workspace: "ws-1",
    seq: 2,
    body: "redacted deploy log line three",
    recorded_at: 12,
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

describe("live-pinned ceilings, labels, and versions", () => {
  test("plugin bounds mirror the live Core ceilings exactly", async () => {
    const run = await verify();
    // LIVE bitty-plugin-host::history_read @76fa42d6: MAX_NEEDLE_BYTES 256,
    // MAX_SCOPE_ID_BYTES 128; test ceilings 16 rows / 4096 bytes per query.
    // LIVE bitty-platform::clipboard @origin/main: CLIPBOARD_MAX_BYTES 8192.
    const pinned = await run.lua.doString(`return
      copymode.MAX_NEEDLE_BYTES .. "," ..
      copymode.MAX_ROWS_PER_QUERY .. "," ..
      copymode.MAX_BYTES_PER_QUERY .. "," ..
      copymode.MAX_SCOPE_ID_BYTES .. "," ..
      copymode.COPY_MAX_BYTES .. "," ..
      copymode.DEFAULT_ROW_COUNT .. "," ..
      copymode.DEFAULT_MAX_BYTES`);
    expect(pinned).toBe("256,16,4096,128,8192,10,4096");
    // LIVE UntrustedLabel::VALUE @76fa42d6: "untrusted-observation".
    expect(await run.query("copymode.UNTRUSTED_LABEL")).toBe(
      "untrusted-observation",
    );
    // LIVE HISTORY_READ_VERSION @76fa42d6 is 1; the plugin repeats the
    // major-version gate as defense in depth (manifest: plugin-api ^1.0).
    expect(await run.query("copymode.REQUIRED_API_MAJOR")).toBe(1);
    expect(await run.query("copymode.check_compat('1.0.0')")).toBe(true);
    expect(await run.query("copymode.check_compat('2.0.0')")).toBe(false);
  });

  test("manifest declares exactly the two live-registry heads", () => {
    // LIVE bitty-plugin-host::capability @76fa42d6: the closed history
    // family heads are history.transcript.read / history.commands.read /
    // history.kv.read, and clipboard.write stays a separate head.
    const section = MANIFEST_SOURCE.split("[capabilities]")[1].split("[")[0];
    const granted = section
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith("= true"))
      .map((line) => line.split("=")[0].trim())
      .sort();
    expect(granted).toEqual(["clipboard.write", "history.transcript.read"]);
    expect(MANIFEST_SOURCE).toMatch(/bitty = ">=0\.5,<1\.0"/);
    expect(MANIFEST_SOURCE).toMatch(/plugin-api = "\^1\.0"/);
  });

  test("manifest requests commands only: no event subscriptions, no streams", () => {
    // LIVE install path parses [lazy] commands plus an (empty here) events
    // list; the live scratch proof asserts five commands and zero events.
    for (const command of ["open", "move", "anchor", "yank", "close"]) {
      expect(MANIFEST_SOURCE).toContain(
        `"bitty-terminal.copy-mode:${command}"`,
      );
    }
    const lazy = MANIFEST_SOURCE.split("[lazy]")[1];
    expect(lazy).not.toMatch(/events\s*=/);
  });
});

describe("live check-order parity (grant, then scope, then capture, then bounds)", () => {
  test("grant presence precedes bounds: ungranted over-bound denies as missing grant", async () => {
    // LIVE HistoryGate order @76fa42d6: bounds are checked only for
    // authorized callers, so denials never oracle bound facts.
    const run = await verify({ grants: [] });
    open(run, { row_count: 99 });
    expect(await lastCode(run)).toBe("E_HISTORY_MISSING_GRANT");
    expect(await resultCount(run)).toBe(0);
  });

  test("scope explicitness precedes capture: unscoped denies even with capture off", async () => {
    // LIVE HistoryGate order @76fa42d6: scope is checked before capture so
    // out-of-scope callers learn nothing about capture state.
    const run = await verify();
    run.host.setHistoryRows("transcript", [...ROWS]);
    dispatch(run, OPEN_COMMAND, { op: "list" });
    expect(await lastCode(run)).toBe("E_HISTORY_SCOPE_MISMATCH");
    expect(await resultCount(run)).toBe(0);
  });

  test("capture precedes bounds: capture-off with over-bound rows denies as capture disabled", async () => {
    const run = await verify();
    run.host.setHistoryRows("transcript", [...ROWS]);
    open(run, { row_count: 99 });
    expect(await lastCode(run)).toBe("E_HISTORY_CAPTURE_DISABLED");
    expect(await resultCount(run)).toBe(0);
  });
});

describe("CTX-0004 headline claims against the live contract", () => {
  test("all eight live denial codes are reachable through the plugin", async () => {
    // LIVE HistoryDenialKind::code @76fa42d6 maps the eight categories to
    // exactly these strings; the live scratch suite drives each one.
    const missing = await verify({ grants: [] });
    open(missing);
    expect(await lastCode(missing)).toBe("E_HISTORY_MISSING_GRANT");

    const revoked = await verify();
    seedTranscript(revoked, [...ROWS]);
    revoked.host.revoke("history.transcript.read");
    open(revoked);
    expect(await lastCode(revoked)).toBe("E_HISTORY_REVOKED_GRANT");

    const scope = await verify();
    seedTranscript(scope, [...ROWS]);
    dispatch(scope, OPEN_COMMAND, { op: "list" });
    expect(await lastCode(scope)).toBe("E_HISTORY_SCOPE_MISMATCH");

    const bound = await verify();
    seedTranscript(bound, [...ROWS]);
    open(bound, { row_count: 99 });
    expect(await lastCode(bound)).toBe("E_HISTORY_OVER_BOUND");

    const capture = await verify();
    capture.host.setHistoryRows("transcript", [...ROWS]);
    open(capture);
    expect(await lastCode(capture)).toBe("E_HISTORY_CAPTURE_DISABLED");

    const safe = await verify({ safeMode: true });
    open(safe);
    expect(await lastCode(safe)).toBe("E_HISTORY_SAFE_MODE");

    const trust = await verify({ trustLevel: "L4" });
    open(trust);
    expect(await lastCode(trust)).toBe("E_HISTORY_TRUST_DENIED");

    const purged = await verify();
    purged.host.setHistoryCapture("transcript", true);
    purged.host.setHistoryRows("transcript", [
      {
        panel: "pane-a",
        workspace: "ws-1",
        seq: 0,
        body: "gone",
        purged: true,
      },
    ]);
    await purged.lua.doString(
      "copymode.open_now('pane-a', 'ws-1', 'list', nil, 4, 1024)",
    );
    expect(await lastCode(purged)).toBe("E_HISTORY_UNAVAILABLE");
  });

  test("yank without the clipboard grant denies and keeps the selection", async () => {
    // LIVE search_host_copy_to_clipboard @0d50b436: the plugin path needs
    // clipboard.write for its manifest hash; denial writes nothing.
    const run = await verify({ grants: ["history.transcript.read"] });
    seedTranscript(run, [...ROWS]);
    open(run);
    dispatch(run, MOVE_COMMAND, { delta: 1 });
    expect(await selectionCount(run)).toBe(2);
    dispatch(run, YANK_COMMAND);
    expect(await lastCode(run)).toBe("E_CAPABILITY_DENIED");
    expect(await selectionCount(run)).toBe(2);
    expect(await selectionText(run)).toBe(
      "redacted deploy log line one\nredacted deploy log line two",
    );
  });

  test("denied refresh keeps the prior page, cursor, and selection", async () => {
    // The live gate is stateless per query, so keeping the page is pure
    // plugin policy: a denied refresh must not widen into an empty set.
    const run = await verify();
    seedTranscript(run, [...ROWS]);
    open(run);
    dispatch(run, MOVE_COMMAND, { delta: 2 });
    expect(await cursorLine(run)).toBe(3);
    expect(await selectionCount(run)).toBe(3);
    run.host.revoke("history.transcript.read");
    open(run);
    expect(await lastCode(run)).toBe("E_HISTORY_REVOKED_GRANT");
    expect(await resultCount(run)).toBe(3);
    expect(await cursorLine(run)).toBe(3);
    expect(await anchorLine(run)).toBe(1);
    expect(await selectionCount(run)).toBe(3);
  });

  test("refresh replaces the page and resets stale identities", async () => {
    // LIVE snapshot rows are point-in-time (Freshness::PointInTimeNoGuarantee
    // @76fa42d6): stale indexes must never address a refreshed page.
    const run = await verify();
    seedTranscript(run, [...ROWS]);
    open(run);
    dispatch(run, MOVE_COMMAND, { delta: 2 });
    expect(await selectionCount(run)).toBe(3);
    open(run, { op: "tail", row_count: 1 });
    expect(await lastCode(run)).toBe("OPEN");
    expect(await resultCount(run)).toBe(1);
    expect(await anchorLine(run)).toBe(1);
    expect(await cursorLine(run)).toBe(1);
    expect(await selectionCount(run)).toBe(1);
    dispatch(run, CLOSE_COMMAND);
    expect(await inVisual(run)).toBe(false);
    dispatch(run, ANCHOR_COMMAND);
    expect(await lastCode(run)).toBe("NO_SELECTION");
  });
});

describe("no streaming, no session, no mouse, no terminal surface", () => {
  test("entry point reaches exactly the two granted host surfaces", () => {
    const code = codeLines().join("\n");
    // The query/export entries resolve through nil-guarded resolvers: a
    // headless host may expose no transcript namespace at all, and the
    // `pcall(bitty.history.transcript.query, ...)` spelling evaluates the
    // deep index outside pcall, so every deep reach goes through the
    // resolvers below and their guarded call sites.
    expect(code).toMatch(/local function transcript_query_fn/);
    expect(code).toMatch(/local function selection_copy_fn/);
    expect(code).toMatch(/bitty\.history/);
    expect(code).toMatch(/history\.transcript/);
    expect(code).toMatch(/transcript\.query/);
    expect(code).toMatch(/bitty\.selection/);
    expect(code).toMatch(/selection\.copy/);
    expect(code).toMatch(/pcall\(query_fn/);
    expect(code).toMatch(/pcall\(copy_fn/);
    const surfaces = new Set(
      [...code.matchAll(/bitty\.([A-Za-z_]+\.[A-Za-z_]+\.[A-Za-z_]+)/g)].map(
        (match) => match[1],
      ),
    );
    // No direct three-part coupling remains: the LIVE spellings
    // (SDK d915535) history.transcript.query and selection.copy are
    // reached only via the guarded resolvers above.
    expect([...surfaces].sort()).toEqual([]);
  });

  test("no streaming, session, mouse, terminal, or ambient authority", () => {
    const code = codeLines().join("\n");
    // Session snapshots are never a source on the live path
    // (LIVE HistorySource::parse rejects session/snapshot @76fa42d6), the
    // live manifest carries no events, and mouse precedence stays
    // Core-owned: this policy is keyboard-driven snapshot-index selection.
    for (const pattern of [
      /bitty\.history\.session/,
      /bitty\.history\.snapshot/,
      /history\.session/,
      /history\.snapshot/,
      /session\.query/,
      /events\.subscribe/,
      /keymaps\.suggest/,
      /bitty\.terminal\./,
      /bitty\.ui\./,
      /bitty\.process\./,
      /bitty\.store\./,
      /history\.commands\.query/,
      /history\.kv/,
      /(?<![A-Za-z_.])mouse(?![A-Za-z_])/,
      /(?<![A-Za-z_.])stream(?![A-Za-z_])/,
      /(?<![A-Za-z_.])subscribe(?![A-Za-z_])/,
      /(?<![A-Za-z_.])poll(?![A-Za-z_])/,
      /\brequire\s*\(/,
      /dofile|loadfile|loadstring/,
    ]) {
      expect(code).not.toMatch(pattern);
    }
    // Registration (not reads) is the only commands-namespace use.
    expect(code).toMatch(/commands\.register/);
    expect(code).not.toMatch(/commands\.query/);
  });
});
