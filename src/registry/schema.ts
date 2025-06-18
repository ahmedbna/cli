export interface ComponentDependency {
  name: string;
  version: string;
  dev?: boolean;
}

export interface ComponentFile {
  name: string;
  content: string;
  type: 'component' | 'hook' | 'util' | 'type';
  target: string; // Target path relative to project root
}

export interface ComponentRegistry {
  name: string;
  description: string;
  category: 'ui' | 'starter';
  files: ComponentFile[];
  dependencies: ComponentDependency[];
  componentDependencies: string[]; // Other BNA components this depends on
  examples?: string[];
  docs?: string;
  tags: string[];
  version: string;
  author?: string;
  license?: string;
}
