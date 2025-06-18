import inquirer from 'inquirer';
import ora from 'ora';
import path from 'path';
import { logger } from '../utils/logger.js';
import {
  getComponent,
  listComponents,
  searchComponents,
  getComponentsByCategory,
  COMPONENT_CATEGORIES,
} from '../registry/index.js';
import {
  installComponent,
  resolveComponentDependencies,
} from '../utils/registry.js';
import {
  installPackageDependencies,
  checkExistingDependencies,
} from '../utils/dependencies.js';
import {
  detectPackageManagerFromInvocation,
  PackageManager,
} from '../utils/package-manager.js';
import { fileExists } from '../utils/filesystem.js';
import { ComponentRegistry } from '../registry/schema.js';

interface AddOptions {
  overwrite?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  npm?: boolean;
  yarn?: boolean;
  pnpm?: boolean;
  bun?: boolean;
}

export async function addCommand(
  componentNames?: string[],
  options: AddOptions = {}
) {
  logger.banner();
  logger.header('📦 Add BNA Components');

  // Check if we're in a BNA project
  const projectPath = process.cwd();
  const isValidProject = await validateBnaProject(projectPath);

  if (!isValidProject) {
    logger.error('This command must be run in a BNA project directory');
    logger.info('Run "bna init" to create a new project first');
    process.exit(1);
  }

  try {
    let selectedComponents: string[] = [];

    if (componentNames && componentNames.length > 0) {
      selectedComponents = componentNames;
    } else {
      selectedComponents = await promptForComponents();
    }

    if (selectedComponents.length === 0) {
      logger.info('No components selected');
      return;
    }

    // Determine package manager
    const packageManager = determinePackageManager(options);

    // Process each component
    for (const componentName of selectedComponents) {
      await processComponent(
        componentName,
        projectPath,
        packageManager,
        options
      );
    }

    logger.success('🎉 Components added successfully!');
  } catch (error) {
    logger.error('Failed to add components:', error);
    process.exit(1);
  }
}

async function validateBnaProject(projectPath: string): Promise<boolean> {
  const packageJsonPath = path.join(projectPath, 'package.json');
  const appJsonPath = path.join(projectPath, 'app.json');

  return (await fileExists(packageJsonPath)) && (await fileExists(appJsonPath));
}

async function promptForComponents(): Promise<string[]> {
  const action = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'How would you like to select components?',
      choices: [
        { name: 'Browse by category', value: 'category' },
        { name: 'Search components', value: 'search' },
        { name: 'Show all components', value: 'all' },
      ],
    },
  ]);

  switch (action.action) {
    case 'category':
      return await promptByCategory();
    case 'search':
      return await promptBySearch();
    case 'all':
      return await promptFromAll();
    default:
      return [];
  }
}

async function promptByCategory(): Promise<string[]> {
  const categories = Object.entries(COMPONENT_CATEGORIES).map(
    ([key, value]) => ({
      name: value,
      value: key,
    })
  );

  const { category } = await inquirer.prompt([
    {
      type: 'list',
      name: 'category',
      message: 'Select a category:',
      choices: categories,
    },
  ]);

  const components = getComponentsByCategory(category);
  return await selectFromComponents(components);
}

async function promptBySearch(): Promise<string[]> {
  const { query } = await inquirer.prompt([
    {
      type: 'input',
      name: 'query',
      message: 'Search components:',
      validate: (input) =>
        input.length > 0 ? true : 'Please enter a search term',
    },
  ]);

  const components = searchComponents(query);

  if (components.length === 0) {
    logger.warn(`No components found for "${query}"`);
    return [];
  }

  return await selectFromComponents(components);
}

async function promptFromAll(): Promise<string[]> {
  const components = listComponents();
  return await selectFromComponents(components);
}

async function selectFromComponents(
  components: ComponentRegistry[]
): Promise<string[]> {
  const choices = components.map((comp) => ({
    name: `${comp.name} - ${comp.description}`,
    value: comp.name,
  }));

  const { selected } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selected',
      message: 'Select components to install:',
      choices,
      validate: (answer) => {
        if (answer.length === 0) {
          return 'Please select at least one component';
        }
        return true;
      },
    },
  ]);

  return selected;
}

function determinePackageManager(options: AddOptions): PackageManager {
  if (options.npm) return 'npm';
  if (options.yarn) return 'yarn';
  if (options.pnpm) return 'pnpm';
  if (options.bun) return 'bun';

  return detectPackageManagerFromInvocation();
}

async function processComponent(
  componentName: string,
  projectPath: string,
  packageManager: PackageManager,
  options: AddOptions
): Promise<void> {
  const component = getComponent(componentName);

  if (!component) {
    logger.error(`Component "${componentName}" not found`);
    return;
  }

  logger.info(`Installing ${component.name}...`);

  // Resolve dependencies
  const allComponents = await import('../registry/index.js').then(
    (m) => m.REGISTRY
  );
  const dependencyOrder = resolveComponentDependencies(
    componentName,
    allComponents
  );

  // Install component dependencies first
  for (const depName of dependencyOrder) {
    if (depName === componentName) continue;

    const depComponent = getComponent(depName);
    if (!depComponent) continue;

    logger.info(`Installing dependency: ${depName}`);
    await installComponent(depComponent, projectPath, options);
  }

  // Install the main component
  await installComponent(component, projectPath, options);

  // Install package dependencies
  if (component.dependencies.length > 0) {
    const missingDeps = checkExistingDependencies(
      component.dependencies,
      projectPath
    );

    if (missingDeps.length > 0) {
      await installPackageDependencies(
        missingDeps,
        projectPath,
        packageManager
      );
    } else {
      logger.info('All package dependencies already installed');
    }
  }
}
