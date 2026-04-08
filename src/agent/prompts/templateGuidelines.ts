import { stripIndents } from '../../utils/stripIndent';

export const templateGuidelines = () => stripIndents`
<solution_constraints>
  ## Stack
  Expo development build + React Native + Convex + TypeScript.
  File-based routing via Expo Router. Inline styles ONLY — no Tailwind, no \`className\`.

  ## Dev Build (NOT Expo Go)
  - Always use \`expo-dev-client\` — enables native modules unavailable in Expo Go.
  - Install native packages with \`npx expo install <pkg>\` then rebuild the dev client.
  - Run: \`npx expo run:ios\` / \`npx expo run:android\` to create a dev build.
  - When adding a native module (camera, sensors, BLE, etc.) remind the user to rebuild.
  - Never suggest \`expo start\` alone for native module testing.

  ## App Identity & Theme — ALWAYS DO THIS FIRST
  Every app must have its own unique visual identity. NEVER copy the template's yellow/black palette into a new app.
  Before writing any screen or component, design a theme that matches the app's purpose and target audience.

  ### theme/colors.ts
  - Invent a color palette that fits this specific app — the colors should feel native to its domain.
  - Always export a \`COLORS\` object with these semantic keys (choose values that suit the app):
    \`primary\`, \`accent\`, \`background\`, \`surface\`, \`surfaceAlt\`, \`text\`, \`textMuted\`, \`textInverse\`, \`border\`, \`error\`, \`success\`, \`warning\`
  - Also export \`RADIUS\` and \`SPACING\` objects so all spacing and corner radii are consistent and centralized.
  - NEVER hardcode hex or rgb values anywhere outside this file.

  ## Reusable UI Components — Build BEFORE screens
  Every app gets its own component library in \`components/ui/\`, styled with that app's \`COLORS\`, \`RADIUS\`, and \`SPACING\`.
  Screens must use these components — never re-implement common UI inline in a screen.

  ### File naming
  All files in \`components/ui/\` must use lowercase with hyphens: \`button.tsx\`, \`text.tsx\`, \`input.tsx\`, \`card.tsx\`, etc.

  ### Required components — always create these for every app
  - \`components/ui/button.tsx\`
    A pressable component with spring scale animation and haptic feedback.
    Support multiple variants (e.g. primary, secondary, outline, ghost, danger) and sizes (sm, md, lg).
    Include loading state (shows spinner or activity indicator) and disabled state (reduced opacity, non-interactive).
    All colors come from \`COLORS\`, sizing from \`SPACING\`/\`RADIUS\`.

  - \`components/ui/text.tsx\`
    A typography wrapper with named variants (e.g. h1, h2, h3, body, bodyLg, label, caption, overline).
    Each variant defines its own fontSize, fontWeight, lineHeight, and letterSpacing.
    Accepts \`color\`, \`align\`, \`numberOfLines\`, and \`style\` props.
    All font definitions live here — screens never define font sizes or weights inline.

  ### Component rules
  - Design each component to suit this app's identity — adjust shapes, weights, and proportions to match the theme.
  - Components must be pure UI — no business logic, no Convex calls.
  - Use named exports (not default exports) from \`components/ui/\` files.
  - Use \`react-native-reanimated\` for animations.
  - Use \`expo-haptics\` for touch feedback in interactive components.

  ## Critical Rules
  1. Plan first — schema → backend functions → theme → ui components → screens.
  2. Colors — ALWAYS use \`COLORS\` from \`@/theme/colors\`. NEVER hardcode hex/rgb.
  3. Locked files — NEVER modify: \`components/auth/\`, \`convex/auth.config.ts\` .
  4. Native rebuilds — warn user when a native rebuild is required after installing a new native module.
  5. Unique identity — every app gets its own palette and component style. Never reuse the template's exact colors unless asked.
  6. Animations — ALWAYS use \`react-native-reanimated\` for all animations and transitions. NEVER use React Native's built-in \`Animated\` API.
  7. Keyboard — ALWAYS use \`react-native-keyboard-controller\` to handle keyboard avoidance and dismissal around inputs. NEVER use \`KeyboardAvoidingView\` from React Native.
  8. Deploy — call \`deploy\` after every change.


  ## app.json — Update for every new app
  When starting a new app, always update these fields in \`app.json\` to match the app being built:
  - \`expo.name\` — the human-readable display name shown on the home screen
  - \`expo.slug\` — URL-safe lowercase identifier (e.g. \`"my-fitness-app"\`)
  - \`expo.scheme\` — deep link scheme, typically same as slug (e.g. \`"my-fitness-app"\`)
  - \`expo.ios.bundleIdentifier\` — reverse-domain format (e.g. \`"com.yourteam.myfitness"\`)
  - \`expo.android.package\` — same convention (e.g. \`"com.yourteam.myfitness"\`)

Never ship a new app with the template's default \`"bna"\` slug, scheme, or bundle identifier.

  ## Directory Structure
  \`\`\`
  .
  ├── app/
  │   ├── _layout.tsx              # Root layout (Required)
  │   ├── index.tsx                # Redirects to (home)
  │   ├── +not-found.tsx
  │   └── (home)/                  # PROTECTED tab group
  │       ├── _layout.tsx          # NativeTabs or Stack layout
  │       ├── index.tsx            # Home tab
  │       └── settings.tsx         # Settings tab
  ├── components/
  │   ├── auth/                    # Required
  │   └── ui/                      # App-specific reusable components (lowercase-with-hyphens)
  │       ├── button.tsx           # Required
  │       ├── text.tsx             # Required
  │       ├── input.tsx            # Required
  │       ├── card.tsx             # If needed
  │       ├── spinner.tsx          # If needed
  │       └── avatar.tsx           # If needed
  ├── convex/
  │   ├── schema.ts                # Add tables; keep ...authTables
  │   ├── auth.ts                  # Required (loggedInUser query)
  │   ├── users.ts
  │   └── http.ts                  # Required
  └── theme/
      └── colors.ts               # COLORS + RADIUS + SPACING — unique per app
  \`\`\`

  ## Routing & Tabs
  \`(home)\` is a protected route group. Screens are flat files inside \`app/(home)/\`. Max 5 tabs.

  ### Tab layout template
  \`\`\`tsx
  // app/(home)/_layout.tsx
  import { NativeTabs, Icon, Label, VectorIcon } from 'expo-router/unstable-native-tabs';
  import MaterialIcons from '@expo/vector-icons/Feather';
  import { COLORS } from '@/theme/colors';
  import { Platform } from 'react-native';

  export default function HomeLayout() {
    return (
      <NativeTabs
        minimizeBehavior='onScrollDown'
        labelStyle={{ default: { color: COLORS.textMuted }, selected: { color: COLORS.text } }}
        iconColor={{ default: COLORS.textMuted, selected: COLORS.accent }}
        badgeBackgroundColor={COLORS.error}
        labelVisibilityMode='labeled'
        disableTransparentOnScrollEdge={true}
      >
        <NativeTabs.Trigger name='index'>
          {Platform.select({
            ios: <Icon sf='house.fill' />,
            android: <Icon src={<VectorIcon family={MaterialIcons} name='home' />} />,
          })}
          <Label>Home</Label>
        </NativeTabs.Trigger>
        {/* Add triggers here */}
      </NativeTabs>
    );
  }
  \`\`\`

  ### Icon reference
  | Tab | iOS SF Symbol | Android Feather |
  |-----|--------------|-----------------|
  | Home | \`house.fill\` | \`home\` |
  | Settings | \`gear\` | \`settings\` |
  | Search | \`magnifyingglass\` | \`search\` |
  | Profile | \`person.fill\` | \`user\` |
  | Bell | \`bell.fill\` | \`bell\` |

  ### Stack-only layout (no tabs)
  \`\`\`tsx
  import { Stack } from 'expo-router';
  import { COLORS } from '@/theme/colors';
  export default function HomeLayout() {
    return (
      <Stack screenOptions={{ headerStyle: { backgroundColor: COLORS.background }, headerTintColor: COLORS.text }}>
        <Stack.Screen name='index' options={{ title: 'Home' }} />
      </Stack>
    );
  }
  \`\`\`
  Navigate: \`useRouter().push('/screenname')\`

  ## Screen pattern
  Screens import from \`components/ui/\` and use \`COLORS\`, \`SPACING\`, \`RADIUS\` from \`@/theme/colors\`.
  Raw RN primitives (\`Text\`, \`Pressable\`, etc.) are only acceptable for structural layout — never for typography, buttons, or inputs when an equivalent \`components/ui/\` component exists.
  Make sure to use import { useSafeAreaInsets } from 'react-native-safe-area-context'; const insets = useSafeAreaInsets();  and paddingTop: insets.top in the screen containers for safe area handling for each screens.
  
  ## Update the style and theme of following files with caution
    - app/+not-found.tsx
    - app/_layout.tsx
    - components/auth/authentication.tsx
    - components/auth/singout.tsx

  ## Convex Backend
  \`\`\`ts
  // convex/schema.ts
  import { defineSchema, defineTable } from 'convex/server';
  import { authTables } from '@convex-dev/auth/server';
  import { v } from 'convex/values';
  export default defineSchema({
    ...authTables, // NEVER remove
    users: defineTable({ })  // NEVER remove — add fields as needed for user profiles but don't remove existing fields
    myTable: defineTable({ userId: v.id('users'), text: v.string() }).index('by_user', ['userId']),
  });

  // convex/myFunctions.ts
  import { query, mutation } from './_generated/server';
  import { getAuthUserId } from '@convex-dev/auth/server';
  import { v } from 'convex/values';
  export const list = query({
    handler: async (ctx) => {
      const userId = await getAuthUserId(ctx);
      if (!userId) throw new Error('Not authenticated');
      return ctx.db.query('myTable').withIndex('by_user', q => q.eq('userId', userId)).collect();
    },
  });
  export const create = mutation({
    args: { text: v.string() },
    handler: async (ctx, args) => {
      const userId = await getAuthUserId(ctx);
      if (!userId) throw new Error('Not authenticated');
      return ctx.db.insert('myTable', { userId, text: args.text });
    },
  });
  \`\`\`

  \`\`\`tsx
  // Using in components
  import { useQuery, useMutation } from 'convex/react';
  import { api } from '@/convex/_generated/api';
  const items = useQuery(api.myFunctions.list);
  const create = useMutation(api.myFunctions.create);
  await create({ text: 'hello' });
  \`\`\`

  ## Existing API
  - \`api.auth.loggedInUser\` — current user or null
  - \`api.users.get\` — current user (throws if not authed)
  - \`api.users.getAll\` — all users except current
  - \`api.users.update({ name?, bio?, gender?, birthday? })\`

  ## Native Modules Guide
  Always use \`npx expo install <package>\` (not \`npm install\`) for Expo-compatible versions.

  | Module | Install |
  |--------|---------|
  | Audio | \`expo-audio\` |
  | Image | \`expo-image\` |
  | Video | \`expo-video\` |
  | Camera | \`expo-camera\` |
  | Haptics | \`expo-haptics\` |
  | SecureStore | \`expo-secure-store\` |
  | Reanimated | \`react-native-reanimated\` |

  ## Permissions & app.json — ALWAYS configure before using any native feature
  When adding any feature that requires native permissions, ALWAYS update \`app.json\` with the appropriate entries.

  ### Android — add to \`expo.android.permissions\`
  \`\`\`jsonc
  "android": {
    "permissions": [
      // Camera
      "android.permission.CAMERA",
      // Microphone
      "android.permission.RECORD_AUDIO",
      ....
    ]
  }
  \`\`\`
  Only include the permissions the app actually uses.

  ### iOS — add to \`expo.ios.infoPlist\`
  \`\`\`jsonc
  "ios": {
    "infoPlist": {
      "NSCameraUsageDescription": "Camera is used to ...",
      "NSMicrophoneUsageDescription": "Microphone is used to ...",
      ...
    }
  }
  \`\`\`
  Only include the keys the app actually needs. Fill the description string with a clear, user-facing reason — Apple rejects vague strings.
  Permissions changes to \`app.json\` require a dev client rebuild — remind the user.

  ## Prohibited
  - Hardcoded hex/rgb anywhere — use COLORS
  - Copying the template's yellow/black palette into new apps
  - PascalCase or uppercase filenames in \`components/ui/\` — use lowercase-with-hyphens
  - Defining font sizes, font weights, or button styles inline in screens when a \`components/ui/\` component exists
  - \`useBottomTabBarHeight\` — use \`useSafeAreaInsets\` instead
  - Modifying locked files
  - Deleting \`(home)\` or its \`index\` trigger
  - Parentheses in folder names other than \`(home)\`
  - Skipping deployment
  - Suggesting Expo Go for native module features
  - Shipping a new app with the template's default name, slug, scheme, or bundle identifiers from app.json
</solution_constraints>
`;
