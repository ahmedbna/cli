import { stripIndents } from '../../utils/stripIndent.js';

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
  Every app must have its own unique visual identity. NEVER copy the template's default palette into a new app.
  Before writing any screen or component, design a theme that matches the app's purpose and target audience.

  ### theme/colors.ts
  - Invent a color palette that fits this specific app — the colors should feel native to its domain.
  - Always export a \`COLORS\` object with light and dark sub-objects containing these semantic keys:
    \`primary\`, \`background\`, \`card\`, \`text\`, \`border\`, \`red\`
  - You may add more semantic keys as needed: \`accent\`, \`surface\`, \`surfaceAlt\`, \`textMuted\`, \`success\`, \`warning\`, etc.
  - Also export \`RADIUS\` and \`SPACING\` objects so all spacing and corner radii are consistent and centralized.
  - NEVER hardcode hex or rgb values anywhere outside this file.
  - Use the existing \`useColor\` hook from \`hooks/useColor.ts\` to access theme colors in components.

  ## Reusable UI Components — Build BEFORE screens
  Every app gets its own component library in \`components/ui/\`, styled with that app's theme.
  Screens must use these components — never re-implement common UI inline in a screen.

  ### File naming
  All files in \`components/ui/\` must use lowercase with hyphens: \`button.tsx\`, \`text.tsx\`, \`input.tsx\`, \`card.tsx\`, etc.

  ### Required components — always create these for every app
  - \`components/ui/button.tsx\` — already exists in template, update to match new theme
  - \`components/ui/text.tsx\` — create a typography wrapper with named variants (h1, h2, body, caption, etc.)
  - \`components/ui/input.tsx\` — create a styled text input component

  ### Component rules
  - Design each component to suit this app's identity
  - Components must be pure UI — no business logic, no Convex calls
  - Use named exports from \`components/ui/\` files
  - Use \`react-native-reanimated\` for animations
  - Use \`expo-haptics\` for touch feedback in interactive components

  ## Critical Rules
  1. Plan first — inspect template → theme → ui components → schema → functions → screens → ARCHITECTURE.md.
  2. Colors — ALWAYS use theme colors via \`useColor\` hook. NEVER hardcode hex/rgb.
  3. Locked files — NEVER modify: \`convex/auth.config.ts\`.
  4. Native rebuilds — warn user when a native rebuild is required after installing a new native module.
  5. Unique identity — every app gets its own palette and component style.
  6. Animations — ALWAYS use \`react-native-reanimated\` for all animations. NEVER use RN's built-in \`Animated\` API.
  7. Keyboard — ALWAYS use \`react-native-keyboard-controller\` around inputs. NEVER use \`KeyboardAvoidingView\`.
  8. DO NOT run convex dev or expo — they are started automatically after you finish.
  9. ARCHITECTURE.md — ALWAYS write this as the FINAL step of every generation.

  ## app.json — Update for every new app
  When starting a new app, always update these fields in \`app.json\`:
  - \`expo.name\` — the human-readable display name
  - \`expo.slug\` — URL-safe lowercase identifier
  - \`expo.scheme\` — deep link scheme
  - \`expo.ios.bundleIdentifier\` — reverse-domain format
  - \`expo.android.package\` — same convention

  Never ship a new app with the template's default \`"bna"\` slug, scheme, or bundle identifier.

  ## Directory Structure
  \`\`\`
  .
  ├── ARCHITECTURE.md            # MANDATORY — project map for future modifications
  ├── app/
  │   ├── _layout.tsx              # Root layout (already exists)
  │   ├── index.tsx                # Redirects to (home) (already exists)
  │   ├── +not-found.tsx
  │   └── (home)/                  # PROTECTED tab group
  │       ├── _layout.tsx          # NativeTabs or Stack layout
  │       ├── index.tsx            # Home tab
  │       └── settings.tsx         # Settings tab
  ├── components/
  │   ├── auth/                    # Already exists — do not modify logic
  │   └── ui/                      # App-specific reusable components
  │       ├── button.tsx           # Already exists — update theme
  │       ├── text.tsx             # Create for every app
  │       ├── input.tsx            # Create if needed
  │       ├── card.tsx             # Create if needed
  │       ├── spinner.tsx          # Already exists — update theme
  │       └── ...                  # Additional components
  ├── convex/
  │   ├── schema.ts                # Add tables; keep ...authTables + users
  │   ├── auth.ts                  # Already exists — do not modify
  │   ├── auth.config.ts           # Already exists — NEVER modify
  │   ├── users.ts                 # Already exists
  │   └── http.ts                  # Already exists
  ├── hooks/
  │   ├── useColor.ts              # Already exists
  │   └── useModeToggle.tsx        # Already exists
  └── theme/
      ├── colors.ts                # Update with unique palette per app
      └── theme-provider.tsx       # Already exists
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
  import { useModeToggle } from '@/hooks/useModeToggle';

  export default function HomeLayout() {
    const { isDark } = useModeToggle();
    const colors = isDark ? COLORS.dark : COLORS.light;
    
    return (
      <NativeTabs
        minimizeBehavior='onScrollDown'
        labelStyle={{ default: { color: colors.border }, selected: { color: colors.text } }}
        iconColor={{ default: colors.border, selected: colors.primary }}
        badgeBackgroundColor={colors.red}
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

  ## Screen pattern
  Screens import from \`components/ui/\` and use theme via \`useColor\` hook.
  Raw RN primitives (\`Text\`, \`Pressable\`, etc.) are only acceptable for structural layout.
  Make sure to use import { useSafeAreaInsets } from 'react-native-safe-area-context'; for safe area.

  ## Convex Backend
  \`\`\`ts
  // convex/schema.ts — ADD tables, keep existing ones
  import { defineSchema, defineTable } from 'convex/server';
  import { authTables } from '@convex-dev/auth/server';
  import { v } from 'convex/values';
  export default defineSchema({
    ...authTables, // NEVER remove
    users: defineTable({ /* keep existing fields */ }),
    myTable: defineTable({ userId: v.id('users'), text: v.string() }).index('by_user', ['userId']),
  });
  \`\`\`

  ## Existing API
  - \`api.auth.loggedInUser\` — current user or null
  - \`api.users.get\` — current user (throws if not authed)
  - \`api.users.getAll\` — all users except current
  - \`api.users.update({ name?, bio?, gender?, birthday? })\`

  ## Permissions & app.json
  When adding native permissions, update \`app.json\` with the appropriate entries.
  Permissions changes require a dev client rebuild — remind the user.

  ## Prohibited
  - Hardcoded hex/rgb anywhere — use theme colors via useColor hook
  - Copying the template's default palette into new apps
  - PascalCase or uppercase filenames in \`components/ui/\`
  - \`useBottomTabBarHeight\` — use \`useSafeAreaInsets\` instead
  - Modifying locked files (\`convex/auth.config.ts\`)
  - Deleting \`(home)\` or its \`index\` trigger
  - Parentheses in folder names other than \`(home)\`
  - Running \`npx convex dev\` or \`npx expo run:*\` — these are automatic
  - Running \`npx create-expo-app\` or \`npm init\` — template is pre-copied
  - Running \`npm install\` — base deps are pre-installed
  - Suggesting Expo Go for native module features
  - Shipping with default template name/slug/scheme/bundle identifiers
  - Skipping ARCHITECTURE.md — it MUST be written as the final step
</solution_constraints>
`;
