// components/ui/button.tsx
import {
  ActivityIndicator,
  TextStyle,
  TouchableOpacity,
  ViewStyle,
} from 'react-native';

import { Text } from '@/components/ui/text';
import { BORDER_RADIUS, HEIGHT } from '@/constants/globals';
import { useThemeColor } from '@/hooks/useThemeColor';

export type ButtonVariant =
  | 'default'
  | 'destructive'
  | 'outline'
  | 'secondary'
  | 'ghost'
  | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

interface ButtonProps {
  children: React.ReactNode;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle | ViewStyle[];
  textStyle?: TextStyle;
}

export function Button({
  children,
  onPress,
  variant = 'default',
  size = 'default',
  disabled = false,
  loading = false,
  style,
  textStyle,
}: ButtonProps) {
  const primaryColor = useThemeColor({}, 'primary');
  const primaryForegroundColor = useThemeColor({}, 'primaryForeground');
  const secondaryColor = useThemeColor({}, 'secondary');
  const secondaryForegroundColor = useThemeColor({}, 'secondaryForeground');
  const destructiveColor = useThemeColor({}, 'destructive');
  const destructiveForegroundColor = useThemeColor({}, 'destructiveForeground');
  const borderColor = useThemeColor({}, 'border');

  const getButtonStyle = (): ViewStyle => {
    const baseStyle: ViewStyle = {
      borderRadius: BORDER_RADIUS,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
    };

    // Size variants
    switch (size) {
      case 'sm':
        Object.assign(baseStyle, { height: 36, paddingHorizontal: 12 });
        break;
      case 'lg':
        Object.assign(baseStyle, { height: 44, paddingHorizontal: 32 });
        break;
      case 'icon':
        Object.assign(baseStyle, {
          height: 40,
          width: 40,
          paddingHorizontal: 0,
        });
        break;
      default:
        Object.assign(baseStyle, { height: HEIGHT, paddingHorizontal: 16 });
    }

    // Variant styles
    switch (variant) {
      case 'destructive':
        return { ...baseStyle, backgroundColor: destructiveColor };
      case 'outline':
        return {
          ...baseStyle,
          backgroundColor: 'transparent',
          borderWidth: 1,
          borderColor,
        };
      case 'secondary':
        return { ...baseStyle, backgroundColor: secondaryColor };
      case 'ghost':
        return { ...baseStyle, backgroundColor: 'transparent' };
      case 'link':
        return {
          ...baseStyle,
          backgroundColor: 'transparent',
          height: 'auto',
          paddingHorizontal: 0,
        };
      default:
        return { ...baseStyle, backgroundColor: primaryColor };
    }
  };

  const getTextStyle = (): TextStyle => {
    const baseTextStyle: TextStyle = {
      fontSize: 14,
      fontWeight: '500',
    };

    switch (variant) {
      case 'destructive':
        return { ...baseTextStyle, color: destructiveForegroundColor };
      case 'outline':
        return { ...baseTextStyle, color: primaryColor };
      case 'secondary':
        return { ...baseTextStyle, color: secondaryForegroundColor };
      case 'ghost':
        return { ...baseTextStyle, color: primaryColor };
      case 'link':
        return {
          ...baseTextStyle,
          color: primaryColor,
          textDecorationLine: 'underline',
        };
      default:
        return { ...baseTextStyle, color: primaryForegroundColor };
    }
  };

  const buttonStyle = getButtonStyle();
  const finalTextStyle = getTextStyle();

  return (
    <TouchableOpacity
      style={[buttonStyle, disabled && { opacity: 0.5 }, style]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}
    >
      {loading && (
        <ActivityIndicator
          size='small'
          color={
            variant === 'outline' || variant === 'ghost'
              ? primaryColor
              : primaryForegroundColor
          }
          style={{ marginRight: 8 }}
        />
      )}
      {typeof children === 'string' ? (
        <Text style={[finalTextStyle, textStyle]}>{children}</Text>
      ) : (
        children
      )}
    </TouchableOpacity>
  );
}
