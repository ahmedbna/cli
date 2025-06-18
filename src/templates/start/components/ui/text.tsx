// components/ui/text.tsx
import { useThemeColor } from '@/hooks/useThemeColor';
import React from 'react';
import {
  Text as RNText,
  TextProps as RNTextProps,
  TextStyle,
} from 'react-native';

type TextVariant =
  | 'body'
  | 'title'
  | 'subtitle'
  | 'caption'
  | 'heading'
  | 'link';

interface TextProps extends RNTextProps {
  variant?: TextVariant;
  lightColor?: string;
  darkColor?: string;
  children: React.ReactNode;
}

export function Text({
  variant = 'body',
  lightColor,
  darkColor,
  style,
  children,
  ...props
}: TextProps) {
  const textColor = useThemeColor(
    { light: lightColor, dark: darkColor },
    'text'
  );
  const mutedColor = useThemeColor({}, 'textMuted');

  const getTextStyle = (): TextStyle => {
    const baseStyle: TextStyle = {
      color: textColor,
    };

    switch (variant) {
      case 'heading':
        return {
          ...baseStyle,
          fontSize: 28,
          fontWeight: '700',
          lineHeight: 34,
        };
      case 'title':
        return {
          ...baseStyle,
          fontSize: 20,
          fontWeight: '700',
          lineHeight: 26,
        };
      case 'subtitle':
        return {
          ...baseStyle,
          fontSize: 16,
          fontWeight: '500',
          lineHeight: 22,
        };
      case 'caption':
        return {
          ...baseStyle,
          fontSize: 16,
          fontWeight: '400',
          lineHeight: 16,
          color: mutedColor,
        };
      case 'link':
        return {
          ...baseStyle,
          fontSize: 16,
          fontWeight: '500',
          lineHeight: 24,
          textDecorationLine: 'underline',
        };
      default: // 'body'
        return {
          ...baseStyle,
          fontSize: 16,
          fontWeight: '400',
          lineHeight: 24,
        };
    }
  };

  return (
    <RNText style={[getTextStyle(), style]} {...props}>
      {children}
    </RNText>
  );
}
