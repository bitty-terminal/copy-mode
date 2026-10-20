/**
 * Regression for the 0.0.24 activation failure: `lua/copy-mode/init.lua`
 * read `row_count` and `max_bytes` through `bitty.settings.get` while
 * `bitty-plugin.toml` declared no `[settings]` table. The host answered
 * `E_SETTINGS_UNDECLARED`, activation aborted, and
 * `bitty-terminal.copy-mode:open` was never registered.
 *
 * The mock host only enforces declarations when the manifest carries a
 * `[settings]` table (manifests without one keep the legacy open read), so
 * the static declaration test below is the regression that fails when the
 * table or a key disappears. The activation tests then prove the declared
 * defaults register the command and that a denied read degrades to the shipped
 * default with one bounded diagnostic instead of aborting. The README parity
 * test keeps the user-facing configuration table on the same key/type/default
 * set.
 */

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { checkReadmeSettings } from "../scripts/check-readme-settings.mjs";

import {
  activateCopyMode,
  dispatch,
  ENTRY_SOURCE,
  MANIFEST_SOURCE,
  OPEN_COMMAND,
  seedTranscript,
  type CopyModeRun,
} from "./harness.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface SettingDeclaration {
  readonly kind: string;
  readonly default: number;
}

/** Parse the manifest `[settings]` inline-table declarations. */
function declaredSettings(manifest: string): Map<string, SettingDeclaration> {
  const declarations = new Map<string, SettingDeclaration>();
  const lines = manifest.split(/\r?\n/);
  let inSettings = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.+\]$/.test(trimmed)) {
      inSettings = trimmed === "[settings]";
      continue;
    }
    if (!inSettings || trimmed === "" || trimmed.startsWith("#")) continue;
    const match =
      /^([a-z][a-z0-9_]*)\s*=\s*\{\s*type\s*=\s*"([^"]+)"\s*,\s*default\s*=\s*(-?\d+)\s*\}$/.exec(
        trimmed,
      );
    if (match === null) {
      throw new Error(`unparsable [settings] declaration: ${trimmed}`);
    }
    declarations.set(match[1] as string, {
      kind: match[2] as string,
      default: Number(match[3]),
    });
  }
  return declarations;
}

/** Keys the entry point passes to its `setting(key, default)` reader. */
function readSettingsKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const match of source.matchAll(/\bsetting\(\s*"([a-z][a-z0-9_]*)"/g)) {
    keys.add(match[1] as string);
  }
  return keys;
}

const DECLARED = declaredSettings(MANIFEST_SOURCE);
const READ_KEYS = readSettingsKeys(ENTRY_SOURCE);

describe("settings declarations match the entry point", () => {
  test("the manifest declares a [settings] table", () => {
    expect(MANIFEST_SOURCE).toContain("[settings]");
    expect(DECLARED.size).toBeGreaterThan(0);
  });

  test("every bitty.settings.get key is declared and nothing extra is", () => {
    expect(READ_KEYS.size).toBeGreaterThan(0);
    expect([...DECLARED.keys()].sort()).toEqual([...READ_KEYS].sort());
  });

  test("the README configuration table matches the manifest", () => {
    expect(checkReadmeSettings({ root: REPO_ROOT })).toEqual([]);
  });

  test("declared kinds and defaults match the plugin fallbacks", async () => {
    const run = await activateCopyMode();
    try {
      const rows = (await run.query("copymode.DEFAULT_ROW_COUNT")) as number;
      const bytes = (await run.query("copymode.DEFAULT_MAX_BYTES")) as number;
      expect(DECLARED.get("row_count")).toEqual({
        kind: "int",
        default: rows,
      });
      expect(DECLARED.get("max_bytes")).toEqual({
        kind: "int",
        default: bytes,
      });
    } finally {
      run.close();
    }
  });
});

const ROWS = [
  {
    panel: "pane-a",
    workspace: "ws-1",
    seq: 0,
    body: "redacted settings regression row",
    recorded_at: 10,
  },
] as const;

describe("declared settings activate and register commands", () => {
  test("activation registers open and reads the shipped defaults", async () => {
    const run: CopyModeRun = await activateCopyMode();
    try {
      expect(await run.query("copymode.settings_denied")).toBe(false);
      expect(await run.query("copymode.settings_diagnostic")).toBe("");
      seedTranscript(run, [...ROWS]);
      const result = dispatch(run, OPEN_COMMAND, {
        panel: "pane-a",
        workspace: "ws-1",
        op: "list",
      }) as { ok: boolean; code: string };
      expect(result).toEqual({ ok: true, code: "OPEN" });
    } finally {
      run.close();
    }
  });

  test("a denied read degrades to the default with one bounded diagnostic", async () => {
    // Keep the table (which arms the strict declaration gate) but remove
    // `row_count`, reproducing the host's E_SETTINGS_UNDECLARED read.
    const strictManifest = MANIFEST_SOURCE.replace(/^row_count\s*=.*$\n?/m, "");
    expect(strictManifest).not.toMatch(/^row_count\s*=/m);

    const run = await activateCopyMode({}, strictManifest);
    try {
      expect(await run.query("copymode.settings_denied")).toBe(true);
      // Activation still completed: the command exists and runs.
      seedTranscript(run, [...ROWS]);
      const result = dispatch(run, OPEN_COMMAND, {
        panel: "pane-a",
        workspace: "ws-1",
        op: "list",
      }) as { ok: boolean; code: string };
      expect(result).toEqual({ ok: true, code: "OPEN" });

      const diagnostic = (await run.query(
        "copymode.settings_diagnostic",
      )) as string;
      expect(diagnostic).toContain("E_SETTINGS_UNDECLARED");
      expect(diagnostic).toContain("row_count");
      expect(diagnostic.length).toBeLessThanOrEqual(160);
    } finally {
      run.close();
    }
  });
});
