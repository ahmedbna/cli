---
name: expo-animations
description: Animations with `react-native-reanimated` — shared values, spring/timing, entering/exiting transitions, and gesture-driven animations. NEVER use React Native's built-in `Animated`.
---

# Animations — react-native-reanimated (already in template)

ALWAYS use reanimated. NEVER use React Native's built-in Animated API.

## Basic animated value

```tsx
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  withDelay,
  withSequence,
  withRepeat,
  Easing,
  FadeIn,
  FadeOut,
  SlideInRight,
  SlideOutLeft,
  Layout,
} from "react-native-reanimated";

function FadeBox() {
  const opacity = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 500 });
  }, []);

  return <Animated.View style={[styles.box, animatedStyle]} />;
}
```

## Entering/Exiting animations

```tsx
<Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)}>
  <AppText>Hello</AppText>
</Animated.View>

<Animated.View entering={SlideInRight.springify()}>
  <Card />
</Animated.View>

// Layout animation for list reordering
<Animated.View layout={Layout.springify()}>
  <TodoItem />
</Animated.View>
```

## Spring animation

```tsx
const scale = useSharedValue(1);

const onPress = () => {
  scale.value = withSequence(
    withSpring(0.95, { damping: 10 }),
    withSpring(1, { damping: 8 })
  );
};

const animatedStyle = useAnimatedStyle(() => ({
  transform: [{ scale: scale.value }],
}));
```

## Gesture + Animation

```tsx
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from "react-native-reanimated";

function SwipeCard() {
  const translateX = useSharedValue(0);

  const pan = Gesture.Pan()
    .onUpdate((e) => { translateX.value = e.translationX; })
    .onEnd(() => { translateX.value = withSpring(0); });

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={style}>
        <Card />
      </Animated.View>
    </GestureDetector>
  );
}
```

## Rules

- ALWAYS import from `react-native-reanimated`, NEVER from `Animated` in react-native
- Use `useSharedValue` + `useAnimatedStyle` for imperative animations
- Use entering/exiting props for mount/unmount animations
- Use `withSpring` for natural bouncy feel, `withTiming` for linear/eased
- Combine with `react-native-gesture-handler` for interactive gestures
