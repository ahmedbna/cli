// components/ui/icon.tsx
import { LucideProps } from 'lucide-react-native';
import React from 'react';

import { useThemeColor } from '@/hooks/useThemeColor';

export type Props = LucideProps & {
  lightColor?: string;
  darkColor?: string;
  IconComponent: React.ComponentType<LucideProps>;
};

export function Icon({
  lightColor,
  darkColor,
  IconComponent,
  color,
  size = 24,
  strokeWidth = 2,
  ...rest
}: Props) {
  const themedColor = useThemeColor(
    { light: lightColor, dark: darkColor },
    'icon'
  );

  // Use provided color prop if available, otherwise use themed color
  const iconColor = color || themedColor;

  return (
    <IconComponent
      color={iconColor}
      size={size}
      strokeWidth={strokeWidth}
      {...rest}
    />
  );
}
