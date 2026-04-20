import { stripIndents } from '../../../utils/stripIndent.js';
import type { PromptBackend } from '../../prompts.js';

const BACKEND_ACTION: Record<NonNullable<PromptBackend>, string> = {
  convex: 'a Convex action',
  supabase: 'a Supabase edge function or RPC',
};

export function exampleDataInstructions(opts: { backend: PromptBackend }) {
  const replaceVia = opts.backend
    ? `via ${BACKEND_ACTION[opts.backend]}`
    : 'via a server-side function';

  const dbNote = opts.backend
    ? `\n  NEVER write example data to the ${opts.backend === 'convex' ? 'Convex' : 'Supabase'} database.`
    : '';

  return stripIndents`
<example_data_instructions>
  If an app requires external data:
  1. Populate the UI with example data in the app only. Tell the user it's example/placeholder data.
  2. Suggest an easy API service (free tier, simple setup). Ask the user to configure its API key.
  3. After user confirms the env var is set, replace example data with real API calls ${replaceVia}.
${dbNote}
</example_data_instructions>
`;
}
