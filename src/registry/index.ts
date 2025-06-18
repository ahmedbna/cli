import { ComponentRegistry } from './schema.js';
import textConfig from './components/ui/text.json' assert { type: 'json' };
import viewConfig from './components/ui/view.json' assert { type: 'json' };
// ... import other components

export const REGISTRY: Record<string, ComponentRegistry> = {
  text: textConfig,
  view: viewConfig,
  // ... other components
};

export const COMPONENT_CATEGORIES = {
  ui: 'UI Components',
  layout: 'Layout Components',
  form: 'Form Components',
  navigation: 'Navigation Components',
  data: 'Data Components',
  animation: 'Animation Components',
} as const;

export function getComponent(name: string): ComponentRegistry | null {
  return REGISTRY[name] || null;
}

export function listComponents(): ComponentRegistry[] {
  return Object.values(REGISTRY);
}

export function getComponentsByCategory(category: string): ComponentRegistry[] {
  return Object.values(REGISTRY).filter((comp) => comp.category === category);
}

export function searchComponents(query: string): ComponentRegistry[] {
  const lowercaseQuery = query.toLowerCase();
  return Object.values(REGISTRY).filter(
    (comp) =>
      comp.name.toLowerCase().includes(lowercaseQuery) ||
      comp.description.toLowerCase().includes(lowercaseQuery) ||
      comp.tags.some((tag) => tag.toLowerCase().includes(lowercaseQuery))
  );
}
