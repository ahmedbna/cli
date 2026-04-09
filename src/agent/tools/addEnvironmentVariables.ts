import { z } from 'zod';

export const addEnvironmentVariablesParameters = z.object({
  envVarNames: z
    .array(z.string())
    .describe('List of environment variable names to add to the project.'),
});

export function addEnvironmentVariablesTool() {
  return {
    description: `Add environment variables to the Convex deployment.`,
    parameters: addEnvironmentVariablesParameters,
  };
}
