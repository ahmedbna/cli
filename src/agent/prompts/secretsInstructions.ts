import { stripIndents } from '../../utils/stripIndent';

export function secretsInstructions() {
  return stripIndents`
<secrets_instructions>
  For API keys/secrets:
  1. Tell the user the exact env var name (e.g. \`OPENAI_API_KEY\`).
  2. Instruct: open "Database" tab → "Settings" (gear icon) → "Environment variables" → set and save.
  3. Use \`addEnvironmentVariables\` tool to pre-populate the dashboard form.
  4. Wait for user confirmation before writing code that uses the secret.
</secrets_instructions>
`;
}
