import { execSync } from 'child_process';
import ora from 'ora';
import { ComponentDependency } from '../registry/schema.js';
import { PackageManager, getInstallCommand } from './package-manager.js';
import { logger } from './logger.js';
import path from 'path';
import fs from 'fs-extra';

export async function installPackageDependencies(
  dependencies: ComponentDependency[],
  targetPath: string,
  packageManager: PackageManager
): Promise<void> {
  if (dependencies.length === 0) return;

  const prodDeps = dependencies.filter((dep) => !dep.dev);
  const devDeps = dependencies.filter((dep) => dep.dev);

  if (prodDeps.length > 0) {
    await installDeps(prodDeps, targetPath, packageManager, false);
  }

  if (devDeps.length > 0) {
    await installDeps(devDeps, targetPath, packageManager, true);
  }
}

async function installDeps(
  dependencies: ComponentDependency[],
  targetPath: string,
  packageManager: PackageManager,
  isDev: boolean
): Promise<void> {
  const depType = isDev ? 'dev dependencies' : 'dependencies';
  const spinner = ora(`Installing ${depType}...`).start();

  try {
    const packages = dependencies.map((dep) => `${dep.name}@${dep.version}`);
    const installCmd = getPackageInstallCommand(
      packageManager,
      packages,
      isDev
    );

    execSync(installCmd, {
      cwd: targetPath,
      stdio: 'pipe',
      timeout: 300000,
    });

    spinner.succeed(`${depType} installed successfully!`);
  } catch (error) {
    spinner.fail(`Failed to install ${depType}`);
    logger.error('Installation error:', error);
    throw error;
  }
}

function getPackageInstallCommand(
  packageManager: PackageManager,
  packages: string[],
  isDev: boolean
): string {
  const packagesStr = packages.join(' ');

  switch (packageManager) {
    case 'yarn':
      return isDev ? `yarn add -D ${packagesStr}` : `yarn add ${packagesStr}`;
    case 'pnpm':
      return isDev ? `pnpm add -D ${packagesStr}` : `pnpm add ${packagesStr}`;
    case 'bun':
      return isDev ? `bun add -D ${packagesStr}` : `bun add ${packagesStr}`;
    default:
      return isDev
        ? `npm install -D ${packagesStr}`
        : `npm install ${packagesStr}`;
  }
}

export function checkExistingDependencies(
  dependencies: ComponentDependency[],
  targetPath: string
): ComponentDependency[] {
  try {
    const packageJsonPath = path.join(targetPath, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    const existing = new Set([
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.devDependencies || {}),
    ]);

    return dependencies.filter((dep) => !existing.has(dep.name));
  } catch {
    return dependencies; // If can't read package.json, install all
  }
}
