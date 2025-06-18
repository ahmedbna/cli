// components/ui/scrollview.tsx
import { useThemeColor } from '@/hooks/useThemeColor';
import React from 'react';
import {
  ScrollView as RNScrollView,
  ScrollViewProps as RNScrollViewProps,
} from 'react-native';

export interface ScrollViewProps extends RNScrollViewProps {
  lightColor?: string;
  darkColor?: string;
  variant?: 'default' | 'card';
}

export function ScrollView({
  style,
  lightColor,
  darkColor,
  variant = 'default',
  ...otherProps
}: ScrollViewProps) {
  const cardColor = useThemeColor(
    { light: lightColor, dark: darkColor },
    'card'
  );

  const backgroundColor = useThemeColor(
    { light: lightColor, dark: darkColor },
    'background'
  );

  const background = (() => {
    switch (variant) {
      case 'card':
        return cardColor;
      case 'default':
      default:
        return backgroundColor;
    }
  })();

  return (
    <RNScrollView
      style={[{ backgroundColor: background }, style]}
      {...otherProps}
    />
  );
}
