import { execSync } from 'child_process';
import ora from 'ora';
import { logger } from './logger.js';

export type PackageManager = 'npm' | 'yarn' | 'pnpm';

export function detectPackageManager(): PackageManager {
  try {
    execSync('pnpm --version', { stdio: 'ignore' });
    return 'pnpm';
  } catch {}

  try {
    execSync('yarn --version', { stdio: 'ignore' });
    return 'yarn';
  } catch {}

  return 'npm';
}

export function getInstallCommand(packageManager: PackageManager): string {
  switch (packageManager) {
    case 'yarn':
      return 'yarn install';
    case 'pnpm':
      return 'pnpm install';
    default:
      return 'npm install';
  }
}

export function getRunCommand(
  packageManager: PackageManager,
  script: string
): string {
  switch (packageManager) {
    case 'yarn':
      return `yarn ${script}`;
    case 'pnpm':
      return `pnpm ${script}`;
    default:
      return `npm run ${script}`;
  }
}

export async function installDependencies(
  projectPath: string,
  packageManager: PackageManager
): Promise<void> {
  const installCommand = getInstallCommand(packageManager);

  const spinner = ora(
    `Installing dependencies with ${packageManager}...`
  ).start();

  try {
    execSync(installCommand, {
      cwd: projectPath,
      stdio: 'pipe',
    });
    spinner.succeed('Dependencies installed successfully!');
  } catch (error) {
    spinner.fail('Failed to install dependencies');
    logger.error('Installation error:', error);
    throw error;
  }
}

export function validatePackageManager(pm: string): pm is PackageManager {
  return ['npm', 'yarn', 'pnpm'].includes(pm);
}
