/**
 * Shared logger for the Mnemosyne plugin.
 *
 * Uses ctx.log (injected by the JARVIS core via PluginContext) so entries
 * land in ~/.jarvis/logs/jarvis.log with { plugin: "jarvis-plugin-mnemosyne" }.
 *
 * Usage in createPieces(ctx):
 *   import { log, setPluginLogger } from "../lib/log.js";
 *   if (ctx.log) setPluginLogger(ctx.log);
 *
 * Any module that imports { log } automatically uses the wired logger.
 * Before setPluginLogger is called, log calls are silently dropped (no-op).
 *
 * DO NOT import pino directly — it breaks esbuild bundling.
 * DO NOT use console.log — it doesn't appear in jarvis.log.
 */

type LogFn = {
  (msg: string): void;
  (obj: Record<string, unknown>, msg: string): void;
};

export interface PluginLogger {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child(bindings: Record<string, unknown>): PluginLogger;
}

// No-op logger used before setPluginLogger is called.
const noop: LogFn = () => {};
const noopLogger: PluginLogger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  child: () => noopLogger,
};

let _logger: PluginLogger = noopLogger;

export function setPluginLogger(logger: PluginLogger): void {
  _logger = logger;
}

/**
 * Proxy that always delegates to the current _logger instance.
 * Safe to import at module load time — no pino, no worker threads.
 */
export const log: PluginLogger = {
  trace: (...args: any[]) => (_logger.trace as any)(...args),
  debug: (...args: any[]) => (_logger.debug as any)(...args),
  info:  (...args: any[]) => (_logger.info  as any)(...args),
  warn:  (...args: any[]) => (_logger.warn  as any)(...args),
  error: (...args: any[]) => (_logger.error as any)(...args),
  fatal: (...args: any[]) => (_logger.fatal as any)(...args),
  child: (bindings) => _logger.child(bindings),
};
