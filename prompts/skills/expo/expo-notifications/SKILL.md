---
name: expo-notifications
description: Local + push notifications client-side — permissions, channels, Expo push tokens, scheduling, handlers, and listeners. Use before backend notification skills.
---

# Expo Notifications

Wraps FCM (Android) and APNs (iOS) and produces the **Expo push token**. Server-side sending lives in `expo-convex-notifications` / `expo-supabase-notifications`.

## Hard ground rules

- **Push doesn't work on simulators.** Test on a real device. Dev build (`expo-dev-client`) required — Expo Go on Android dropped push in SDK 53.
- **Android 13+ requires permission prompt** AND the OS won't show it until at least one channel exists. Always call `setNotificationChannelAsync(...)` **before** `getExpoPushTokenAsync(...)`.
- **Tokens rotate.** Use `addPushTokenListener` to re-register.
- **`expoConfig.extra.eas.projectId` is required** for `getExpoPushTokenAsync`. Run `eas init`.

## Install + config plugin

```bash
npx expo install expo-notifications expo-device expo-constants
```

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

Android icon **must** be 96×96 white-on-transparent PNG. After editing `app.json`, rebuild — JS-only restarts don't apply plugin changes.

## Canonical registration helper

```ts
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

export async function registerForPushNotificationsAsync(): Promise<string | null> {
  // 1. Channel FIRST on Android — required for Android 13+ permission prompt
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FAD40B',
    });
  }

  // 2. Real device check
  if (!Device.isDevice) {
    console.warn('Push notifications require a physical device');
    return null;
  }

  // 3. Permissions
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') return null;

  // 4. Token
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (!projectId) {
    throw new Error('Missing EAS projectId. Run `eas init` first.');
  }

  try {
    const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
    return tokenResponse.data; // ExponentPushToken[xxxxxxxxxxxxxxx]
  } catch (e) {
    console.error('Failed to get push token', e);
    return null;
  }
}
```

## Foreground handler

Set at module scope (not inside a component) so it runs once at startup:

```ts
// app/_layout.tsx (top-level, outside the component)
import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true, // iOS 14+
    shouldShowList: true,   // iOS 14+
  }),
});
```

`shouldShowAlert` is deprecated. Handler must respond within 3 seconds.

## Listeners

```ts
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';

export function useNotificationListeners() {
  useEffect(() => {
    const receivedSub = Notifications.addNotificationReceivedListener((n) => {
      console.log('received:', n.request.content);
    });

    const responseSub = Notifications.addNotificationResponseReceivedListener((r) => {
      console.log('tapped:', r.notification.request.content.data);
    });

    return () => {
      receivedSub.remove();
      responseSub.remove();
    };
  }, []);
}
```

## Deep linking from tap (Expo Router)

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

    // Cold start: app was launched by tapping a notification
    const last = Notifications.getLastNotificationResponse();
    if (last?.notification) redirect(last.notification);

    // Warm: app was already running
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

## Local (in-app) notifications

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

// Specific Date
await Notifications.scheduleNotificationAsync({
  content: { title: 'Appointment' },
  trigger: {
    type: Notifications.SchedulableTriggerInputTypes.DATE,
    date: new Date(Date.now() + 5 * 60 * 1000),
  },
});
```

Cancel:

```ts
const id = await Notifications.scheduleNotificationAsync({ /* … */ });
await Notifications.cancelScheduledNotificationAsync(id);
await Notifications.cancelAllScheduledNotificationsAsync();
```

Android 12+ exact-time alarms (`DATE` trigger) need `<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM"/>`.

## Channels (Android only)

```ts
await Notifications.setNotificationChannelAsync('messages', {
  name: 'New messages',
  importance: Notifications.AndroidImportance.HIGH,
  vibrationPattern: [0, 250, 250, 250],
  lightColor: '#FAD40B',
  sound: 'default',
});
```

Send to specific channel:

```ts
await Notifications.scheduleNotificationAsync({
  content: { title: 'New message' },
  trigger: {
    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
    seconds: 1,
    channelId: 'messages',
  },
});
```

After a channel exists, only **name** and **description** are mutable. Migrate users to a new channel for other changes.

## Badge count

```ts
await Notifications.setBadgeCountAsync(3);
await Notifications.setBadgeCountAsync(0);
```

iOS requires `allowBadge` permission. Best-effort on Android.

## Custom sounds

```json
{
  "plugins": [
    ["expo-notifications", { "sounds": ["./assets/sounds/chime.wav"] }]
  ]
}
```

```ts
await Notifications.scheduleNotificationAsync({
  content: { title: 'Ping', sound: 'chime.wav' },
  trigger: {
    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
    seconds: 1,
  },
});

// Android 8+: also set on the channel
await Notifications.setNotificationChannelAsync('default', {
  name: 'default',
  importance: Notifications.AndroidImportance.HIGH,
  sound: 'chime.wav',
});
```

Set sound on **both** notification and channel (Android <8 reads notification; Android 8+ reads channel).

## iOS permissions

```ts
const settings = await Notifications.getPermissionsAsync();
const allowed =
  settings.granted ||
  settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
```

iOS statuses: `AUTHORIZED`, `PROVISIONAL` (silent, request via `allowProvisional: true`), `EPHEMERAL` (App Clips), `DENIED`, `NOT_DETERMINED`.

## Common mistakes

- **`getExpoPushTokenAsync` before `setNotificationChannelAsync` on Android** — returns nothing.
- **`setNotificationHandler` inside a component body** — re-runs on every render. Set at module scope.
- **Strict Mode double-fire in dev** — guard with a ref/state if backend rejects duplicates.
- **Forgetting `Constants.expoConfig.extra.eas.projectId`** — run `eas init`.
- **Testing on simulator** — silent fail.
- **Using `shouldShowAlert` only** — deprecated. Use `shouldShowBanner` + `shouldShowList`.
- **Channel sound override** — Android 8+ reads from the channel.

## Not covered here

- Storing tokens in backend → see `expo-convex-notifications` / `expo-supabase-notifications`.
- Sending pushes from a server → same.
