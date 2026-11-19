export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "text" | "json";

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export type Fields = Record<string, unknown>;

export interface Logger {
  error(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  debug(msg: string, fields?: Fields): void;
}

export function isLogLevel(v: string): v is LogLevel {
  return v in ORDER;
}

/** Structured logger. Always writes to the given sink (stderr by default), never stdout. */
export function createLogger(
  level: LogLevel,
  format: LogFormat,
  write: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): Logger {
  const emit = (lvl: Exclude<LogLevel, "silent">, msg: string, fields?: Fields) => {
    if (ORDER[lvl] > ORDER[level]) return;
    if (format === "json") {
      write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...fields }));
    } else {
      const extra = fields
        ? ` ${Object.entries(fields)
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join(" ")}`
        : "";
      write(`[${lvl}] ${msg}${extra}`);
    }
  };
  return {
    error: (m, f) => emit("error", m, f),
    warn: (m, f) => emit("warn", m, f),
    info: (m, f) => emit("info", m, f),
    debug: (m, f) => emit("debug", m, f),
  };
}

export const silentLogger: Logger = createLogger("silent", "text", () => {});
