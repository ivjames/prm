// pm2 process definitions for the lab980 deploy.
//
// Two processes, one site:
//   prm-web    — the web PWA + API; the ONLY process that binds a port (the
//                one nginx proxies to). PORT comes from the app-dir .env.
//   prm-worker — ingestion + cadence schedulers; binds no port.
//
// Deploy (see DEPLOY.md):
//   cd /var/www/prm && npm ci && npm run build \
//     && pm2 start ecosystem.config.cjs && pm2 save
//
// config.ts loads .env via dotenv from cwd, so cwd must be the app dir.
const cwd = __dirname;

// Fork mode, explicitly. Both processes are single-instance and one binds no
// port at all, so cluster mode buys nothing here — and specifying `instances`
// would make pm2 default to cluster, which routes startup crashes to the pm2
// daemon log instead of the app's own log (and diverges from every other
// lab980 site, all of which run fork). Keep them fork.
module.exports = {
  apps: [
    {
      name: "prm-web",
      cwd,
      script: "dist/server.js",
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: "production" },
    },
    {
      name: "prm-worker",
      cwd,
      script: "dist/workers/index.js",
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: "production" },
    },
  ],
};
