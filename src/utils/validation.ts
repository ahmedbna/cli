import validateNpmPackageName from 'validate-npm-package-name';
import { existsSync } from 'fs';
import path from 'path';

export function validateProjectName(name: string): {
  valid: boolean;
  message?: string;
} {
  if (!name) {
    return { valid: false, message: 'Project name is required' };
  }

  if (name.length === 0) {
    return { valid: false, message: 'Project name cannot be empty' };
  }

  const validation = validateNpmPackageName(name);

  if (!validation.validForNewPackages) {
    const errors = validation.errors || [];
    const warnings = validation.warnings || [];
    const issues = [...errors, ...warnings];

    return {
      valid: false,
      message: `Invalid project name: ${issues.join(', ')}`,
    };
  }

  return { valid: true };
}

export function validateProjectPath(projectPath: string): {
  valid: boolean;
  message?: string;
} {
  if (existsSync(projectPath)) {
    return {
      valid: false,
      message: `Directory ${path.basename(projectPath)} already exists`,
    };
  }

  return { valid: true };
}

export function sanitizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}
