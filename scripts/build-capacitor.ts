import { execSync } from 'node:child_process';
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const apiDir = path.join(root, 'src/app/api');
const apiBackupDir = path.join(root, '.capacitor-build/api-backup');

function run(command: string, extraEnv?: Record<string, string>) {
  execSync(command, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
}

function hideApiRoutes() {
  if (!existsSync(apiDir)) return;
  rmSync(apiBackupDir, { recursive: true, force: true });
  cpSync(apiDir, apiBackupDir, { recursive: true });
  rmSync(apiDir, { recursive: true, force: true });
}

function restoreApiRoutes() {
  if (!existsSync(apiBackupDir)) return;
  rmSync(apiDir, { recursive: true, force: true });
  renameSync(apiBackupDir, apiDir);
}

try {
  hideApiRoutes();
  run('next build', { BUILD_TARGET: 'mobile' });
  run('npx cap sync');
} finally {
  restoreApiRoutes();
}
