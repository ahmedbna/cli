import { execSync } from 'child_process';
import ora from 'ora';
import { logger } from './logger.js';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export function detectPackageManager(): PackageManager {
  try {
    execSync('pnpm --version', { stdio: 'ignore' });
    return 'pnpm';
  } catch {}

  try {
    execSync('yarn --version', { stdio: 'ignore' });
    return 'yarn';
  } catch {}

  try {
    execSync('bun --version', { stdio: 'ignore' });
    return 'bun';
  } catch {}

  return 'npm';
}

export function detectPackageManagerFromInvocation(): PackageManager {
  // Check environment variables set by package managers
  const npmConfig = process.env.npm_config_user_agent;
  const npmExecpath = process.env.npm_execpath;

  if (npmConfig) {
    if (npmConfig.includes('pnpm')) return 'pnpm';
    if (npmConfig.includes('yarn')) return 'yarn';
    if (npmConfig.includes('bun')) return 'bun';
    if (npmConfig.includes('npm')) return 'npm';
  }

  if (npmExecpath) {
    if (npmExecpath.includes('pnpm')) return 'pnpm';
    if (npmExecpath.includes('yarn')) return 'yarn';
    if (npmExecpath.includes('bun')) return 'bun';
  }

  // Check process argv for dlx/bunx patterns
  const argv = process.argv.join(' ');
  if (argv.includes('pnpm dlx')) return 'pnpm';
  if (argv.includes('yarn dlx')) return 'yarn';
  if (argv.includes('bunx')) return 'bun';
  if (argv.includes('npx')) return 'npm';

  // Fallback to detection by availability
  return detectPackageManager();
}

export function getInstallCommand(packageManager: PackageManager): string {
  switch (packageManager) {
    case 'yarn':
      return 'yarn install';
    case 'pnpm':
      return 'pnpm install';
    case 'bun':
      return 'bun install';
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
    case 'bun':
      return `bun run ${script}`;
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
  return ['npm', 'yarn', 'pnpm', 'bun'].includes(pm);
}
