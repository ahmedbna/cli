import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { ComponentRegistry } from '../registry/schema.js';
import { readFile, writeFile, fileExists } from './filesystem.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function getComponentTemplate(
  componentName: string,
  fileName: string
): Promise<string> {
  const templatePath = path.resolve(
    __dirname,
    `../../templates/components/${fileName}`
  );

  if (!(await fileExists(templatePath))) {
    throw new Error(`Template file not found: ${fileName}`);
  }

  return await readFile(templatePath);
}

export async function installComponent(
  component: ComponentRegistry,
  targetPath: string,
  options: {
    overwrite?: boolean;
    dryRun?: boolean;
  } = {}
): Promise<void> {
  const { overwrite = false, dryRun = false } = options;

  // Check if component files already exist
  const existingFiles: string[] = [];
  for (const file of component.files) {
    const filePath = path.join(targetPath, file.target);
    if (await fileExists(filePath)) {
      existingFiles.push(file.target);
    }
  }

  if (existingFiles.length > 0 && !overwrite) {
    logger.warn(`The following files already exist:`);
    existingFiles.forEach((file) => logger.plain(`  ${file}`));
    logger.plain(`Use --overwrite to replace existing files`);
    return;
  }

  if (dryRun) {
    logger.info('Dry run - would install the following files:');
    component.files.forEach((file) => logger.plain(`  ${file.target}`));
    return;
  }

  // Install component files
  for (const file of component.files) {
    const filePath = path.join(targetPath, file.target);
    const template = await getComponentTemplate(component.name, file.name);

    // Process template with any necessary replacements
    const processedContent = processTemplate(template, {
      componentName: component.name,
      // Add other template variables as needed
    });

    await writeFile(filePath, processedContent);
    logger.success(`Created ${file.target}`);
  }
}

function processTemplate(
  template: string,
  variables: Record<string, string>
): string {
  let processed = template;

  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    processed = processed.replace(regex, value);
  });

  return processed;
}

export function resolveComponentDependencies(
  componentName: string,
  registry: Record<string, ComponentRegistry>
): string[] {
  const visited = new Set<string>();
  const resolved: string[] = [];

  function resolve(name: string) {
    if (visited.has(name)) return;
    visited.add(name);

    const component = registry[name];
    if (!component) {
      throw new Error(`Component not found: ${name}`);
    }

    // Resolve dependencies first
    for (const dep of component.componentDependencies) {
      resolve(dep);
    }

    resolved.push(name);
  }

  resolve(componentName);
  return resolved;
}
