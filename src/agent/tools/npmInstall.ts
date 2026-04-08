import { z } from 'zod';

export const npmInstallToolDescription = `
Install NPM packages using \`npx expo install\` to ensure Expo/React Native compatibility.

Always use this tool (not raw npm/yarn) so Expo can pin correct compatible versions.
Prefer well-maintained libraries with TypeScript support and significant adoption.

## Native modules
If the package includes native code (e.g. camera, location, BLE, sensors, notifications),
it requires a dev client rebuild. After installing, remind the user to run:
  \`npx expo run:ios\`  or  \`npx expo run:android\`
`;

const packagesDescription = `Space-separated list of packages to install via \`npx expo install\`.
Examples: 'expo-camera', 'expo-location expo-notifications', 'date-fns'`;

export const npmInstallToolParameters = z.object({
  packages: z.string().describe(packagesDescription),
  requiresNativeRebuild: z
    .boolean()
    .describe(
      'Set true if any package includes native code requiring a dev client rebuild.',
    ),
});

export const npmInstallTool = {
  description: npmInstallToolDescription,
  parameters: npmInstallToolParameters,
};
