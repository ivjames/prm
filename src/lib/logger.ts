/** Minimal structured logger. One line per event, JSON-ish, greppable in pm2 logs. */

type Level = "info" | "warn" | "error";

function emit(level: Level, scope: string, msg: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const base = `${ts} [${level}] (${scope}) ${msg}`;
  if (extra && Object.keys(extra).length > 0) {
    console[level === "error" ? "error" : "log"](base, JSON.stringify(extra));
  } else {
    console[level === "error" ? "error" : "log"](base);
  }
}

export function logger(scope: string) {
  return {
    info: (msg: string, extra?: Record<string, unknown>) => emit("info", scope, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", scope, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit("error", scope, msg, extra),
  };
}
