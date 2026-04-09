import { stripIndents } from '../../utils/stripIndent.js';

export function secretsInstructions() {
  return stripIndents`
<secrets_instructions>
  For API keys/secrets:
  1. Tell the user the exact env var name (e.g. \`OPENAI_API_KEY\`).
  2. Instruct: open Convex dashboard → "Settings" → "Environment variables" → set and save OR ask user to run: npx convex env set OPENAI_API_KEY <youropenaiapikey>
  3. Wait for user confirmation before writing code that uses the secret.
</secrets_instructions>
`;
}
