/**
 * PM2 process definitions: three APIs and two outbox relays, each a plain Node.js process.
 * Build first (`npm run build`); entry points are the compiled files under apps/<service>/dist.
 *
 * No secrets live here. Each process reads its configuration from the environment; in development it
 * also loads the repository's .env (variables already set in the environment take precedence).
 * Production: export variables through systemd/PM2 env files kept outside the repository.
 */
const path = require('node:path');

const root = __dirname;

const common = {
  cwd: root,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  // Back off restarts of a crashing process instead of hot-looping.
  exp_backoff_restart_delay: 200,
  max_restarts: 50,
  min_uptime: '5s',
  // SIGTERM first; processes drain HTTP connections / in-flight deliveries, then exit.
  kill_timeout: 10000,
  max_memory_restart: '300M',
  merge_logs: true,
  // Logs are already structured JSON with timestamps.
  time: false,
  env: {
    NODE_ENV: 'development',
    DOTENV_PATH: path.join(root, '.env'),
  },
  env_production: {
    NODE_ENV: 'production',
    DOTENV_PATH: '/etc/dv/dv.env',
  },
};

// `npm run start:pm2:debug` (`--env debug`) opens a Node inspector per process, on loopback only,
// for attaching a debugger (see .vscode/launch.json). Development only.
const debugEnv = (port) => ({
  env_debug: { ...common.env, NODE_OPTIONS: `--enable-source-maps --inspect=127.0.0.1:${port}` },
});

module.exports = {
  apps: [
    {
      ...common,
      ...debugEnv(9229),
      name: 'dv-core',
      script: 'apps/core/dist/main.js',
      max_memory_restart: '400M',
    },
    {
      ...common,
      ...debugEnv(9230),
      name: 'dv-verification',
      script: 'apps/verification/dist/main.js',
    },
    {
      ...common,
      ...debugEnv(9231),
      name: 'dv-notification',
      script: 'apps/notification/dist/main.js',
    },
    {
      ...common,
      ...debugEnv(9232),
      name: 'dv-core-relay',
      script: 'apps/core/dist/relay.js',
      max_memory_restart: '200M',
    },
    {
      ...common,
      ...debugEnv(9233),
      name: 'dv-verification-relay',
      script: 'apps/verification/dist/relay.js',
      max_memory_restart: '200M',
    },
  ],
};
