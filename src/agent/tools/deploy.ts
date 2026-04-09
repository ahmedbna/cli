import { z } from 'zod';

export const deployToolDescription = `Deploy the Convex backend. In CLI mode, this is handled automatically after the agent finishes.`;

export const deployTool = {
  description: deployToolDescription,
  parameters: z.object({}),
};

export const deployToolParameters = z.object({});
