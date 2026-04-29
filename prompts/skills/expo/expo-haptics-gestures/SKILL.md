---
name: expo-haptics-gestures
description: Haptic feedback (`expo-haptics`) and touch gestures (`react-native-gesture-handler`) — tap, long press, swipe, pan.
---

# Haptics & Gestures

## expo-haptics (already in template)

```tsx
import * as Haptics from "expo-haptics";

// Light tap (buttons, toggles)
Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

// Medium impact (selection, drag end)
Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

// Heavy impact (important actions, delete)
Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

// Selection changed (picker, switch)
Haptics.selectionAsync();

// Notification feedback
Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
```

## react-native-gesture-handler (already in template)

```tsx
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";

// Tap
const tap = Gesture.Tap().onEnd(() => {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
});

// Long press
const longPress = Gesture.LongPress()
  .minDuration(500)
  .onStart(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  });

// Swipe to delete
const swipe = Gesture.Pan()
  .activeOffsetX([-20, 20])
  .onUpdate((e) => {
    translateX.value = e.translationX;
  })
  .onEnd((e) => {
    if (e.translationX < -100) {
      translateX.value = withTiming(-200);
      runOnJS(onDelete)();
    } else {
      translateX.value = withSpring(0);
    }
  });

// Compose
const composed = Gesture.Simultaneous(tap, longPress);

return (
  <GestureDetector gesture={swipe}>
    <Animated.View style={animatedStyle}>
      <Card />
    </Animated.View>
  </GestureDetector>
);
```

## Keyboard handling — react-native-keyboard-controller

ALWAYS use this instead of KeyboardAvoidingView.

```tsx
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

function FormScreen() {
  return (
    <KeyboardAwareScrollView bottomOffset={20}>
      <AppInput placeholder="Name" />
      <AppInput placeholder="Email" />
      <Button title="Submit" />
    </KeyboardAwareScrollView>
  );
}
```

## Rules

- Use haptics on interactive elements for native feel
- NEVER use `KeyboardAvoidingView` — use `react-native-keyboard-controller`
- Wrap gesture-interactive components with `GestureDetector`
- Combine gestures with reanimated for smooth interactions
- Root layout must include `GestureHandlerRootView`
