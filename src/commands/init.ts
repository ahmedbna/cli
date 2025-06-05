import inquirer from 'inquirer';
import ora from 'ora';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger } from '../utils/logger.js';
import {
  validateProjectName,
  validateProjectPath,
  sanitizeProjectName,
} from '../utils/validation.js';
import { copyTemplate, replaceInFile } from '../utils/filesystem.js';
import {
  detectPackageManager,
  installDependencies,
  getRunCommand,
  type PackageManager,
} from '../utils/package-manager.js';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface InitOptions {
  template?: string;
  npm?: boolean;
  yarn?: boolean;
  pnpm?: boolean;
  skipInstall?: boolean;
}

export async function initCommand(
  projectName?: string,
  options: InitOptions = {}
) {
  logger.header('🚀 Welcome to BNA - Expo React Native Starter');

  try {
    // Get project name
    let finalProjectName = projectName;

    if (!finalProjectName) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'projectName',
          message: 'What is your project name?',
          default: 'my-bna-app',
          validate: (input: string) => {
            const validation = validateProjectName(input);
            return (
              validation.valid || validation.message || 'Invalid project name'
            );
          },
        },
      ]);
      finalProjectName = answers.projectName;
    }

    // Validate and sanitize project name
    const nameValidation = validateProjectName(finalProjectName ?? 'bna');
    if (!nameValidation.valid) {
      logger.error(nameValidation.message!);
      process.exit(1);
    }

    const sanitizedName = sanitizeProjectName(finalProjectName ?? 'bna');
    const projectPath = path.resolve(process.cwd(), sanitizedName);

    // Validate project path
    const pathValidation = validateProjectPath(projectPath);
    if (!pathValidation.valid) {
      logger.error(pathValidation.message!);
      process.exit(1);
    }

    // Determine package manager
    let packageManager: PackageManager;

    if (options.npm) packageManager = 'npm';
    else if (options.yarn) packageManager = 'yarn';
    else if (options.pnpm) packageManager = 'pnpm';
    else {
      const detected = detectPackageManager();
      const answers = await inquirer.prompt([
        {
          type: 'list',
          name: 'packageManager',
          message: 'Which package manager would you like to use?',
          choices: [
            { name: 'npm', value: 'npm' },
            { name: 'Yarn', value: 'yarn' },
            { name: 'pnpm', value: 'pnpm' },
          ],
          default: detected,
        },
      ]);
      packageManager = answers.packageManager;
    }

    // Create project
    const spinner = ora('Creating your BNA project...').start();

    try {
      // Copy template files
      const templatePath = path.join(__dirname, '../../templates');
      await copyTemplate(templatePath, projectPath);

      // Update package.json
      await updatePackageJson(projectPath, sanitizedName);

      // Update app.json
      await updateAppJson(projectPath, sanitizedName);

      spinner.succeed('Project created successfully!');

      // Install dependencies
      if (!options.skipInstall) {
        await installDependencies(projectPath, packageManager);
      }

      // Show success message
      showSuccessMessage(
        sanitizedName,
        packageManager,
        options.skipInstall ?? false
      );
    } catch (error) {
      spinner.fail('Failed to create project');
      throw error;
    }
  } catch (error) {
    logger.error('An error occurred:', error);
    process.exit(1);
  }
}

async function updatePackageJson(
  projectPath: string,
  projectName: string
): Promise<void> {
  const packageJsonPath = path.join(projectPath, 'package.json');
  await replaceInFile(packageJsonPath, {
    '"name": "init"': `"name": "${projectName}"`,
    '"init"': `"${projectName}"`,
  });
}

async function updateAppJson(
  projectPath: string,
  projectName: string
): Promise<void> {
  const appJsonPath = path.join(projectPath, 'app.json');
  await replaceInFile(appJsonPath, {
    '"name": "init"': `"name": "${projectName}"`,
    '"slug": "init"': `"slug": "${projectName}"`,
    '"scheme": "init"': `"scheme": "${projectName}"`,
  });
}

function showSuccessMessage(
  projectName: string,
  packageManager: PackageManager,
  skipInstall: boolean
): void {
  logger.newline();
  logger.success(`🎉 Successfully created ${projectName}!`);
  logger.newline();

  logger.info('Next steps:');
  logger.plain(`  cd ${projectName}`);

  if (skipInstall) {
    logger.plain(
      `  ${
        packageManager === 'npm'
          ? 'npm install'
          : packageManager === 'yarn'
          ? 'yarn'
          : 'pnpm install'
      }`
    );
  }

  logger.plain(`  ${getRunCommand(packageManager, 'start')}`);
  logger.newline();

  logger.info('Available commands:');
  logger.plain(
    `  ${getRunCommand(
      packageManager,
      'start'
    )}    Start the development server`
  );
  logger.plain(`  ${getRunCommand(packageManager, 'android')}  Run on Android`);
  logger.plain(`  ${getRunCommand(packageManager, 'ios')}      Run on iOS`);
  logger.plain(`  ${getRunCommand(packageManager, 'web')}      Run on Web`);
  logger.newline();

  logger.info('Happy coding! 🚀');
}
