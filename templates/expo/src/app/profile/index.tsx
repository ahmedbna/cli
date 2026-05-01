import { Text, View } from 'react-native';
import { useColor } from '@/hooks/useColor';
import { Button } from '@/components/ui/button';
import { useModeToggle } from '@/hooks/useModeToggle';

export default function SettingsScreen() {
  const text = useColor('text');
  const { mode, toggleMode } = useModeToggle();

  return (
    <View
      style={{
        flex: 1,
        paddingHorizontal: 20,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
      }}
    >
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          color: text,
          textTransform: 'uppercase',
          letterSpacing: 1.2,
        }}
      >
        Profile
      </Text>

      <Button onPress={() => toggleMode()}>
        <Text
          style={{
            color: text,
            fontSize: 14,
            fontWeight: '600',
          }}
        >
          {mode === 'light' ? 'Light' : mode === 'dark' ? 'Dark' : 'System'}
        </Text>
      </Button>
    </View>
  );
}
