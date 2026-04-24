// src/commands/stacks.ts
//
// Stack registry — maps a (frontend, backend) selection to a stack identifier.
// The stack identifier drives template selection, the system prompt variant,
// and finalization commands downstream.
//
// To add a new option:
//   1. Add it to `FRONTENDS` or `BACKENDS` below.
//   2. Add the resulting combo to `SUPPORTED_STACKS`.
//   3. Drop a template directory at `templates/<stack>/`.
//   4. Wire any stack-specific prompt/finalization branches where `stack` is used.

export type Frontend = 'expo'; // future: | 'swift'
export type Backend = 'convex' | 'supabase' | 'none';

export type StackId = 'expo' | 'expo-convex' | 'expo-supabase';

export interface StackChoice<V extends string> {
  value: V;
  name: string;
  description: string;
}

export const FRONTENDS: StackChoice<Frontend>[] = [
  {
    value: 'expo',
    name: 'Expo',
    description: 'React Native — iOS + Android',
  },
  // { value: 'swift', name: 'Swift', description: 'Native iOS (SwiftUI)' },
];

export const BACKENDS: StackChoice<Backend>[] = [
  {
    value: 'convex',
    name: 'Convex',
    description: 'Real-time TypeScript backend with auth + storage',
  },
  {
    value: 'supabase',
    name: 'Supabase',
    description: 'Postgres + Auth + Storage via SQL migrations',
  },
  {
    value: 'none',
    name: 'None',
    description: 'Frontend only — no backend',
  },
];

const SUPPORTED_STACKS = new Set<StackId>([
  'expo',
  'expo-convex',
  'expo-supabase',
]);

export function combineStack(frontend: Frontend, backend: Backend): StackId {
  const id = (backend === 'none' ? frontend : `${frontend}-${backend}`) as StackId;
  if (!SUPPORTED_STACKS.has(id)) {
    const supported = Array.from(SUPPORTED_STACKS).join(', ');
    throw new Error(
      `Stack "${id}" is not supported yet. Available: ${supported}.`,
    );
  }
  return id;
}

export function isFrontend(value: string): value is Frontend {
  return FRONTENDS.some((f) => f.value === value);
}

export function isBackend(value: string): value is Backend {
  return BACKENDS.some((b) => b.value === value);
}
