/**
 * Runs `lua/copy-mode/init.lua` in a real Lua VM (wasmoon) against the SDK
 * mock host (bitty-plugin-sdk `MockHost`).
 *
 * The mock host owns every contract check: manifest linting, capability
 * gates, the activation registration window, scope explicitness, capture
 * opt-in, row/byte bounds, per-plugin window budgets, purge/trust/safe-mode
 * denials, and the clipboard export gate. The harness only bridges the
 * injected `bitty` table into Lua, dispatches the plugin commands, seeds
 * already-redacted history rows, and exposes scalar state queries so tests
 * assert on plain values.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MockHost } from "bitty-plugin-sdk";
import { LuaFactory, type LuaEngine } from "wasmoon";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MANIFEST_SOURCE = readFileSync(
  join(REPO_ROOT, "bitty-plugin.toml"),
  "utf8",
);
export const ENTRY_SOURCE = readFileSync(
  join(REPO_ROOT, "lua/copy-mode/init.lua"),
  "utf8",
);

/** Capabilities the manifest requests; tests grant all of them by default. */
export const COPYMODE_CAPABILITIES = [
  "history.transcript.read",
  "clipboard.write",
] as const;

export const OPEN_COMMAND = "bitty-terminal.copy-mode:open";
export const MOVE_COMMAND = "bitty-terminal.copy-mode:move";
export const ANCHOR_COMMAND = "bitty-terminal.copy-mode:anchor";
export const YANK_COMMAND = "bitty-terminal.copy-mode:yank";
export const CLOSE_COMMAND = "bitty-terminal.copy-mode:close";

export interface CopyModeRun {
  readonly host: MockHost;
  readonly lua: LuaEngine;
  /** Scalar Lua state query: `copymode.selection_count()`, `copymode.last_code()`. */
  query(expr: string): Promise<unknown>;
  close(): void;
}

export interface CopyModeRunOptions {
  readonly grants?: readonly string[];
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly safeMode?: boolean;
  readonly trustLevel?: string;
  readonly pluginApiVersion?: string;
}

const factory = new LuaFactory();

/**
 * Map JS `null` results to `undefined` so they reach Lua as `nil` (the
 * mock host models Lua `nil` as `null`; wasmoon cannot push `null`).
 */
function nilSafe<T>(table: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    if (typeof value === "function") {
      out[key] = (...args: unknown[]): unknown => {
        const result = (value as (...a: unknown[]) => unknown)(...args);
        return result === null ? undefined : result;
      };
    } else if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = nilSafe(value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Activate the plugin once: grants, settings, init.lua, end activation. */
export async function activateCopyMode(
  options: CopyModeRunOptions = {},
  manifestSource: string = MANIFEST_SOURCE,
): Promise<CopyModeRun> {
  const host = new MockHost({
    manifestSource,
    ...(options.environment !== undefined
      ? { environment: options.environment }
      : {}),
    ...(options.safeMode !== undefined ? { safeMode: options.safeMode } : {}),
    ...(options.trustLevel !== undefined
      ? { trustLevel: options.trustLevel }
      : {}),
    ...(options.pluginApiVersion !== undefined
      ? { pluginApiVersion: options.pluginApiVersion }
      : {}),
  });
  for (const capability of options.grants ?? COPYMODE_CAPABILITIES) {
    host.grant(capability);
  }
  host.beginActivation();
  for (const [key, value] of Object.entries(options.settings ?? {})) {
    host.bitty.settings.set(key, value as never);
  }

  const lua = await factory.createEngine({ injectObjects: false });
  lua.global.set("bitty", nilSafe(host.bitty));
  const run: CopyModeRun = {
    host,
    lua,
    async query(expr: string): Promise<unknown> {
      return lua.doString(`return ${expr}`);
    },
    close(): void {
      lua.global.close();
    },
  };
  try {
    await lua.doString(ENTRY_SOURCE);
    host.endActivation();
  } catch (error) {
    lua.global.close();
    throw error;
  }
  return run;
}

/** Dispatch a session command by qualified name. */
export function dispatch(
  run: CopyModeRun,
  command: string,
  args: unknown = {},
): unknown {
  return run.host.dispatchCommand(command, args);
}

/** Seed already-redacted transcript rows with capture opt-in on. */
export function seedTranscript(
  run: CopyModeRun,
  rows: ReadonlyArray<Record<string, unknown>>,
): void {
  run.host.setHistoryCapture("transcript", true);
  run.host.setHistoryRows("transcript", rows as never);
}

/** Scalar state readers (plain values, no table conversion). */
export async function inVisual(run: CopyModeRun): Promise<boolean> {
  return (await run.query("copymode.in_visual()")) as boolean;
}

export async function resultCount(run: CopyModeRun): Promise<number> {
  return (await run.query("copymode.result_count()")) as number;
}

export async function cursorLine(run: CopyModeRun): Promise<number> {
  return (await run.query("copymode.cursor_line()")) as number;
}

export async function anchorLine(run: CopyModeRun): Promise<number> {
  return (await run.query("copymode.anchor_line()")) as number;
}

export async function selectionCount(run: CopyModeRun): Promise<number> {
  return (await run.query("copymode.selection_count()")) as number;
}

export async function selectionText(run: CopyModeRun): Promise<string> {
  return (await run.query("copymode.selection_text()")) as string;
}

export async function currentLabel(run: CopyModeRun): Promise<string> {
  return (await run.query("copymode.current_label()")) as string;
}

export async function lastCode(run: CopyModeRun): Promise<string> {
  return (await run.query("copymode.last_code()")) as string;
}

export async function totalInScope(run: CopyModeRun): Promise<number> {
  return (await run.query("copymode.total_in_scope()")) as number;
}
