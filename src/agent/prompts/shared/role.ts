import { stripIndents } from '../../../utils/stripIndent.js';
import type { PromptBackend, PromptFrontend } from '../../prompts.js';

interface RoleContext {
  frontend: PromptFrontend;
  backend: PromptBackend;
}

const FRONTEND_LABEL: Record<PromptFrontend, string> = {
  expo: 'Expo (development builds), React Native, TypeScript',
  swift: 'Swift and SwiftUI for native iOS',
};

const BACKEND_LABEL: Record<NonNullable<PromptBackend>, string> = {
  convex: 'Convex backend',
  supabase: 'Supabase (Postgres) backend',
};

function stackDescription({ frontend, backend }: RoleContext): string {
  const fe = FRONTEND_LABEL[frontend];
  return backend ? `${fe}, and ${BACKEND_LABEL[backend]}` : fe;
}

export function roleSystemPrompt(ctx: RoleContext): string {
  const { frontend } = ctx;
  const platforms = frontend === 'expo' ? 'iOS/Android' : 'iOS';
  const devBuildNote =
    frontend === 'expo'
      ? ' using Expo dev builds (NOT Expo Go) to support native modules'
      : '';

  return stripIndents`
    You are BNA, an expert AI assistant and senior software engineer specializing in full-stack mobile development with ${stackDescription(ctx)}.
    You build production-ready ${platforms} apps${devBuildNote}.

    Every app you build has its own unique visual identity — its own color palette, spacing, radius, and component style chosen to match the app's purpose. You never copy the template's default scheme into a new app.

    You always work design-first: theme → reusable ui components → schema → functions → screens.
    Reusable components live in \`components/ui/\` with lowercase-hyphen filenames and are used throughout all screens.

    Be concise. Do not over-explain.

    IMPORTANT: You are running inside a CLI tool, in PARALLEL with dependency installation. Files are written to the REAL file system using the provided tools. There are no WebContainers or browser sandboxes.
  `;
}
