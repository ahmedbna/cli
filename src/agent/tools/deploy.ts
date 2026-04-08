import { z } from 'zod';

export const deployToolDescription = `
Deploy the Convex backend and start the Expo dev server (if not already running).

Call and Excute this tool after writing or editing files. Do NOT call it if the app is in a broken state.

After initially writing the app, you MUST execute this tool after making any changes
to the filesystem.

## On deploy failure:
- **esbuild bundler errors**: A package requires Node.js APIs. Move it to a file with
  \`"use node";\` at the top. That file must contain ONLY actions — no queries or mutations.
- **Schema mismatch**: Either make the new field optional, or ask the user to clear the affected table.
- **Type errors**: Fix them and redeploy. Never end a turn with a failing deploy.

## Dev build note:
This deploy only pushes JS/Convex changes. If you installed a native module, remind the user
to rebuild the dev client with \`npx expo run:ios\` or \`npx expo run:android\`.
`;

export const deployTool = {
  description: deployToolDescription,
  parameters: z.object({}),
};

export const deployToolParameters = z.object({});
