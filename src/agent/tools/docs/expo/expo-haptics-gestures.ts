export const expoHapticsGesturesDocs = `
# Haptics & Gestures

## expo-haptics (already in template)
\`\`\`tsx
import * as Haptics from "expo-haptics";

// Light tap feedback (buttons, toggles)
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
\`\`\`

## react-native-gesture-handler (already in template)
\`\`\`tsx
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";

// Tap gesture
const tap = Gesture.Tap().onEnd(() => {
  console.log("Tapped!");
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

// Compose gestures
const composed = Gesture.Simultaneous(tap, longPress);

return (
  <GestureDetector gesture={swipe}>
    <Animated.View style={animatedStyle}>
      <Card />
    </Animated.View>
  </GestureDetector>
);
\`\`\`

## Keyboard handling — react-native-keyboard-controller (already in template)
ALWAYS use this instead of KeyboardAvoidingView.
\`\`\`tsx
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
\`\`\`

## Rules
- Use haptics on all interactive elements for native feel
- NEVER use \`KeyboardAvoidingView\` — use \`react-native-keyboard-controller\`
- Wrap gesture-interactive components with \`GestureDetector\`
- Combine gestures with reanimated for smooth interactions
- Root layout must include \`GestureHandlerRootView\` (already in template)
`;
