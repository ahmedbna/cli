import { View as RNView, type ViewProps } from 'react-native';

import { useThemeColor } from '@/hooks/useThemeColor';

export type Props = ViewProps & {
  lightColor?: string;
  darkColor?: string;
  variant?: 'default' | 'card';
};

export function View({
  style,
  lightColor,
  darkColor,
  variant = 'default',
  ...otherProps
}: Props) {
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
    <RNView style={[{ backgroundColor: background }, style]} {...otherProps} />
  );
}
