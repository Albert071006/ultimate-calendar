// The CLI loads its worker by sibling filename at runtime. Ship both in every server edition.
export const backendRuntimeFiles = [
  'dist-server/cli.mjs',
  'dist-server/backup-worker.cjs',
];

export const backendPackageFiles = [
  'LICENSE',
  ...backendRuntimeFiles,
  'deploy/backend-files.mjs',
  'deploy/ultimate-calendar.service',
  'deploy/server.env.example',
  'deploy/check-health.mjs',
  'deploy/verify-release.mjs',
  'deploy/install-backend.sh',
  'deploy/rollback-backend.sh',
  'deploy/DEPLOYMENT.md',
];
