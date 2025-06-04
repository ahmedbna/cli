// TabBarBackground.tsx

import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { BlurView } from 'expo-blur';
import { Platform, StyleSheet } from 'react-native';

export default function BlurBackground() {
  if (Platform.OS === 'ios') {
    return (
      <BlurView
        tint='systemChromeMaterial'
        intensity={100}
        style={StyleSheet.absoluteFill}
      />
    );
  }

  // On Android & Web: no background
  return null;
}

export function useBottomTabOverflow() {
  return Platform.OS === 'ios' ? useBottomTabBarHeight() : 0;
}
