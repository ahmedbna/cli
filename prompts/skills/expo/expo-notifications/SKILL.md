---
name: expo-notifications
description: Use whenever the app needs to schedule local notifications, request notification permissions, obtain an Expo push token, present incoming notifications in-foreground, or handle notification taps. Trigger on "notifications", "push notifications", "local notification", "schedule notification", "expoPushToken", "registerForPushNotifications", "setNotificationHandler", "addNotificationReceivedListener", "addNotificationResponseReceivedListener", "notification channel", "badge count", or any mention of Android FCM / iOS APNs from inside an Expo app. Use this skill before either of the backend-specific notification skills (expo-convex-notifications, expo-supabase-notifications) — those build on top of it for token storage and server-side sending.
---

# Expo Notifications

`expo-notifications` is the only correct way to do notifications in an Expo app. It wraps FCM on Android and APNs on iOS behind a single API and is what produces the **Expo push token** that the Expo Push Service accepts.

This skill covers everything that lives entirely inside the client: install, config plugin, permissions, channels, getting a token, scheduling, presenting, and listening. Sending the token to a server and triggering pushes from server code is covered by the backend-specific skills (`expo-convex-notifications`, `expo-supabase-notifications`) — read this one first.

## Hard ground rules (the things that bite people)

- **Push notifications do not work on simulators or emulators.** Test on a real iOS or Android device. A development build (`expo-dev-client`) is required — Expo Go on Android dropped remote-push support in SDK 53. Local notifications still work in Expo Go.
- **Android 13+ requires a runtime permission prompt**, and the OS will not show that prompt until at least one notification channel exists. `setNotificationChannelAsync(...)` runs **before** `getExpoPushTokenAsync(...)`, every time. Skipping this is the #1 reason `getExpoPushTokenAsync` returns nothing on Android.
- **Tokens can rotate.** Treat the token as "current as of right now" — register a `addPushTokenListener` so when FCM/APNs rolls a token mid-session you re-send it to your backend instead of silently going dead.
- **`expoConfig.extra.eas.projectId` is required** for `getExpoPushTokenAsync`. Without it the call throws. Run `eas init` so this lands in `app.json` automatically.

## Install + config plugin

```bash
npx expo install expo-notifications expo-device expo-constants
```

The package is a config plugin. Adding it to `app.json` is what lets you set the Android notification icon, color, default channel, and custom sounds — and on iOS, enables background remote notifications. You must rebuild the dev client after adding this; it does not take effect over the JS bundle.

```json
{
  "expo": {
    "plugins": [
      "expo-router",
      "expo-secure-store",
      [
        "expo-notifications",
        {
          "icon": "./assets/images/notification-icon.png",
          "color": "#FAD40B",
          "defaultChannel": "default",
          "sounds": []
        }
      ]
    ]
  }
}
```

The Android icon **must** be a 96×96 white-on-transparent PNG. Anything else (color, gradient, opaque background) renders as a solid white square in the system tray. This is a Google design rule, not an Expo limitation.

After editing `app.json` you must `eas build` (or `npx expo run:android` / `run:ios`) to pick up the plugin changes. JS-only restarts won't apply them.

## The canonical registration helper

Every Expo project ends up with some version of this. Use it as-is — most "my push token is undefined" bugs are because someone skipped the channel step or the device check.

```ts
// hooks/useNotifications.ts (or wherever)
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

export async function registerForPushNotificationsAsync(): Promise<
  string | null
> {
  // 1. Channel FIRST on Android — required before the OS will show the
  //    permission prompt on Android 13+.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FAD40B',
    });
  }

  // 2. Real device check. Simulators silently fail.
  if (!Device.isDevice) {
    console.warn('Push notifications require a physical device');
    return null;
  }

  // 3. Permissions — only ask if not already granted.
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') {
    console.warn('Notification permission denied');
    return null;
  }

  // 4. Token — needs the EAS projectId to attribute the token correctly.
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (!projectId) {
    throw new Error('Missing EAS projectId. Run `eas init` first.');
  }

  try {
    const tokenResponse = await Notifications.getExpoPushTokenAsync({
      projectId,
    });
    return tokenResponse.data; // ExponentPushToken[xxxxxxxxxxxxxxx]
  } catch (e) {
    console.error('Failed to get push token', e);
    return null;
  }
}
```

The string this returns (`ExponentPushToken[...]`) is what your backend stores and what the Expo Push Service accepts. It is **not** a raw FCM/APNs token — that's a separate call (`getDevicePushTokenAsync`) and you only need it if you're sending pushes through FCM/APNs directly without going through Expo's service.

## Presenting notifications while the app is foregrounded

By default, iOS hides notifications when the app is open. To show them, set a handler **before** any listeners are attached — typically in the root layout module so it runs once at app startup:

```ts
// app/_layout.tsx (top-level, outside the component)
import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true, // iOS 14+ — banner at top of screen
    shouldShowList: true, // iOS 14+ — also adds to Notification Center
  }),
});
```

`shouldShowAlert` is deprecated; use `shouldShowBanner` and `shouldShowList` together. The handler must respond within 3 seconds — if you `await` something slow inside it, the notification is dropped.

## Listeners

Two listeners cover almost every case. Mount them once in a top-level effect and remove them in cleanup:

```ts
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';

export function useNotificationListeners() {
  useEffect(() => {
    // Fired when a notification arrives while the app is open.
    const receivedSub = Notifications.addNotificationReceivedListener((n) => {
      console.log('received:', n.request.content);
    });

    // Fired when the user TAPS a notification (foreground OR background).
    const responseSub = Notifications.addNotificationResponseReceivedListener(
      (r) => {
        console.log('tapped:', r.notification.request.content.data);
      },
    );

    return () => {
      receivedSub.remove();
      responseSub.remove();
    };
  }, []);
}
```

For deep-linking on tap with Expo Router, see the next section.

## Deep linking from notification tap (Expo Router)

The pattern: the notification's `data.url` carries the route to navigate to, and a single `useNotificationObserver` hook in the root layout handles both the cold-start case (app launched from a tap) and the warm case (app already running).

```tsx
// app/_layout.tsx
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { router, Slot } from 'expo-router';

function useNotificationObserver() {
  useEffect(() => {
    function redirect(notification: Notifications.Notification) {
      const url = notification.request.content.data?.url;
      if (typeof url === 'string') router.push(url);
    }

    // Cold start: app was launched by tapping a notification.
    const last = Notifications.getLastNotificationResponse();
    if (last?.notification) redirect(last.notification);

    // Warm: app was already running.
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      redirect(r.notification);
    });

    return () => sub.remove();
  }, []);
}

export default function RootLayout() {
  useNotificationObserver();
  return <Slot />;
}
```

The cold-start branch matters — without it, tapping a notification while the app is dead launches the app on the home screen instead of the relevant screen, which is almost always wrong.

## Local (in-app) notifications

These don't need a server, a token, or even network access. Useful for reminders, timers, scheduled prompts.

```ts
// Fire in 60 seconds
await Notifications.scheduleNotificationAsync({
  content: {
    title: "Time's up!",
    body: 'Change sides!',
    data: { url: '/timer' },
  },
  trigger: {
    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
    seconds: 60,
  },
});

// Daily at 09:00
await Notifications.scheduleNotificationAsync({
  content: { title: 'Daily check-in' },
  trigger: {
    type: Notifications.SchedulableTriggerInputTypes.DAILY,
    hour: 9,
    minute: 0,
  },
});

// On a specific Date
await Notifications.scheduleNotificationAsync({
  content: { title: 'Appointment' },
  trigger: {
    type: Notifications.SchedulableTriggerInputTypes.DATE,
    date: new Date(Date.now() + 5 * 60 * 1000),
  },
});
```

Cancel by id (`scheduleNotificationAsync` returns one):

```ts
const id = await Notifications.scheduleNotificationAsync({
  /* … */
});
await Notifications.cancelScheduledNotificationAsync(id);
// or nuke them all:
await Notifications.cancelAllScheduledNotificationsAsync();
```

On Android 12+, **exact-time** alarms (`DATE` trigger with second-precision) require `<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM"/>` in `AndroidManifest.xml`. For most app reminders, an approximate trigger (`TIME_INTERVAL`, `DAILY`) is fine and doesn't need this permission.

## Channels (Android only)

A channel groups notifications and controls importance, sound, vibration, lights, and lock-screen visibility — and once a user changes those settings, you can't override them. Pick channel names that mean something to a user reading their app settings.

```ts
await Notifications.setNotificationChannelAsync('messages', {
  name: 'New messages',
  importance: Notifications.AndroidImportance.HIGH,
  vibrationPattern: [0, 250, 250, 250],
  lightColor: '#FAD40B',
  sound: 'default',
});
```

Send to a specific channel by passing `channelId` in the trigger:

```ts
await Notifications.scheduleNotificationAsync({
  content: { title: 'New message from Ahmed' },
  trigger: {
    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
    seconds: 1,
    channelId: 'messages',
  },
});
```

After a channel exists you can only modify its **name** and **description** — Android locks the rest. If you need to change importance/sound on an existing channel, create a new channel and migrate users to it.

## Badge count (iOS, some Android launchers)

```ts
await Notifications.setBadgeCountAsync(3); // shows "3" on the icon
await Notifications.setBadgeCountAsync(0); // clears it
```

iOS requires the `allowBadge` permission (the default `requestPermissionsAsync()` includes it). Many Android launchers (Pixel, Samsung One UI) support this, but not all — treat `setBadgeCountAsync` as best-effort on Android.

## Custom sounds

Add `.wav` files (or `.caf`) to your project, list them in the config plugin's `sounds` array, rebuild, then reference by **base filename**:

```json
{
  "plugins": [
    ["expo-notifications", { "sounds": ["./assets/sounds/chime.wav"] }]
  ]
}
```

```ts
// In a notification:
await Notifications.scheduleNotificationAsync({
  content: { title: 'Ping', sound: 'chime.wav' },
  trigger: {
    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
    seconds: 1,
  },
});

// AND on Android 8+, set it on the channel too — without this the system
// uses the channel's default sound regardless of what the notification says.
await Notifications.setNotificationChannelAsync('default', {
  name: 'default',
  importance: Notifications.AndroidImportance.HIGH,
  sound: 'chime.wav',
});
```

The "set sound on both notification and channel" thing trips everyone up. Android <8 reads it from the notification; Android 8+ reads it from the channel. Setting both keeps you covered.

## Permissions deep-dive (iOS)

iOS permissions are more granular than the boolean Android model. Use `ios.status` from `getPermissionsAsync` rather than the top-level `granted` when you need to distinguish:

- `AUTHORIZED` — user granted alerts/sounds/badges normally.
- `PROVISIONAL` — silent notifications allowed without an explicit prompt. Useful for a "let us send things quietly until you tell us otherwise" UX. Request with `allowProvisional: true`.
- `EPHEMERAL` — App Clips only; time-limited.
- `DENIED` — user said no; you can't re-prompt, must direct them to Settings.
- `NOT_DETERMINED` — never asked; safe to call `requestPermissionsAsync`.

```ts
const settings = await Notifications.getPermissionsAsync();
const allowed =
  settings.granted ||
  settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
```

## Common mistakes

- **Calling `getExpoPushTokenAsync` before `setNotificationChannelAsync` on Android.** On Android 13+ this returns nothing because no permission prompt has been shown.
- **Setting `setNotificationHandler` inside a component body.** It re-runs on every render. Set it at module scope.
- **Putting the registration helper inside `useEffect` with `[]` deps but expecting React Strict Mode to be fine.** It double-fires in dev. Use a ref or state guard if your backend rejects duplicate token registrations.
- **Forgetting `Constants.expoConfig.extra.eas.projectId`.** Run `eas init`. The token call will throw with a descriptive error if it's missing — read the error.
- **Testing on a simulator.** It will silently fail on iOS and silently succeed-then-do-nothing on Android. Always test on a real device.
- **Using `shouldShowAlert` only.** Deprecated. Use `shouldShowBanner` + `shouldShowList`.
- **Hardcoding channel sound `'default'` and expecting custom sounds to play.** They won't — the channel's sound takes precedence on Android 8+.
- **Sending notifications from the client.** That's not a thing — you can only schedule **local** notifications from the client. Push notifications are sent from a server with your token. Use the matching backend skill (`expo-convex-notifications` or `expo-supabase-notifications`) for that piece.

## What this skill does NOT cover

- **Storing tokens in your backend** (Convex/Supabase users table) → see `expo-convex-notifications` or `expo-supabase-notifications`.
- **Sending pushes from a server** (calling Expo Push API from a Convex action or a Supabase Edge Function) → same.
- **Background notification handlers** (running JS when a silent push arrives) → covered briefly here, but the full setup with `expo-task-manager` lives in the backend skills since the trigger is server-driven.
