import { mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const disabledRoot = join(root, '.capacitor-build-disabled');
const disabledEntries = [];

function runOrThrow(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

async function moveIfPresent(relativePath) {
  const sourcePath = join(root, relativePath);
  if (!existsSync(sourcePath)) {
    return;
  }

  const disabledPath = join(disabledRoot, relativePath);
  if (existsSync(disabledPath)) {
    throw new Error(`Temporary disabled path already exists: ${disabledPath}`);
  }

  await mkdir(join(disabledPath, '..'), { recursive: true });
  await rename(sourcePath, disabledPath);
  disabledEntries.push({ sourcePath, disabledPath });
}

async function restoreDisabledEntries() {
  while (disabledEntries.length > 0) {
    const entry = disabledEntries.pop();
    if (!entry) continue;
    if (existsSync(entry.disabledPath)) {
      await rename(entry.disabledPath, entry.sourcePath);
    }
  }
}

try {
  // Capacitor's static export cannot include Next.js route handlers or middleware.
  await moveIfPresent('src/app/api');
  await moveIfPresent('src/middleware.ts');

  runOrThrow('npm', ['run', 'build'], { CAPACITOR_BUILD: 'true' });
  runOrThrow('npx', ['cap', 'sync', 'android']);
} finally {
  await restoreDisabledEntries();
  await rm(join(root, '.next/types'), { recursive: true, force: true });
}
