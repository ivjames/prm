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

module.exports = {
  apps: [
    {
      name: "prm-web",
      cwd,
      script: "dist/server.js",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: "production" },
    },
    {
      name: "prm-worker",
      cwd,
      script: "dist/workers/index.js",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: "production" },
    },
  ],
};
