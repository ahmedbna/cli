import { z } from 'zod';
import { presenceComponentReadmePrompt } from './docs/presence.js';
import { devBuild } from './docs/dev-build.js';

export const lookupDocsParameters = z.object({
  docs: z
    .array(z.enum(['presence', 'dev-build', 'eas-build']))
    .describe(
      'Features to look up. Valid values: presence, dev-build, eas-build',
    ),
});

export function lookupDocsTool() {
  return {
    description: `Lookup documentation for component features. Valid topics: \`presence\`, \`dev-build\`, \`eas-build\``,
    parameters: lookupDocsParameters,
  };
}

export type LookupDocsParameters = z.infer<typeof lookupDocsParameters>;

export const docs = {
  presence: presenceComponentReadmePrompt,
  'dev-build': devBuild,
} as const;

export type DocKey = keyof typeof docs;
