import express from "express";
import path from "node:path";
import { config, requireFor } from "./config";
import { logger } from "./lib/logger";
import { healthRouter } from "./api/health";
import { peopleRouter } from "./api/people";
import { sessionRouter } from "./api/session";
import { connectRouter } from "./api/connect";

const log = logger("web");

function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  // Behind nginx (TLS terminates there): trust the proxy so req.protocol is
  // https and @supabase/ssr's secure session cookies are honored.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  // API surface.
  app.use("/api", healthRouter);
  app.use("/api/auth", sessionRouter);
  app.use("/api/connect", connectRouter);
  app.use("/api/people", peopleRouter);

  // Expose the public (client-safe) Supabase config so the static web client
  // can boot without a build step baking keys in. Anon key only — RLS protects
  // the data; the service-role key never leaves the server.
  app.get("/api/config", (_req, res) => {
    res.json({
      supabaseUrl: config.supabase.url,
      supabaseAnonKey: config.supabase.anonKey,
      publicOrigin: config.publicOrigin,
    });
  });

  // Static PWA shell. The Capacitor web build lands in web/ (placeholder for
  // now); serve it and fall back to index.html for client-side routing.
  const webDir = path.resolve(__dirname, "..", "web");
  app.use(express.static(webDir));

  // Does this path look like a request for a FILE rather than a client-side
  // route? Only routes should get the SPA shell. Answering a file request with
  // 200 + index.html makes the site impossible to audit from outside: a scan
  // cannot tell "this file is served" from "this path does not exist". That is
  // not hypothetical — a status-only sweep of this droplet reported eleven
  // sites exposing /.git/config, and the proxied ones (this app among them)
  // were returning index.html with a 200. express.static here is correctly
  // scoped to web/ and nothing ever leaked, but no external check could show
  // that, and the false positive cost real time.
  //
  // path.extname is NOT sufficient on its own. It reads the last dot of the
  // basename, so "/.git/config", "/.git/HEAD" and "/.env" all return "" — the
  // exact paths this is meant to cover. Dotted segments are matched separately.
  //
  // Dotted paths include /.well-known, which is deliberately not exempted:
  // certbot's ACME challenge is served by nginx off disk and never proxied
  // here, so a 404 from this app cannot affect certificate renewal.
  const looksLikeFile = (p: string): boolean =>
    path.extname(p) !== "" || p.split("/").some((seg) => seg.startsWith("."));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/") || looksLikeFile(req.path)) return next();
    res.sendFile(path.join(webDir, "index.html"));
  });

  // Centralized error handler — never leak stack traces to clients.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error("unhandled request error", { message: err.message });
    if (res.headersSent) return;
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

function main() {
  requireFor("web");
  const app = buildApp();
  const server = app.listen(config.port, () => {
    log.info(`prm-web listening`, { port: config.port, origin: config.publicOrigin });
  });

  const shutdown = (sig: string) => {
    log.info(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
