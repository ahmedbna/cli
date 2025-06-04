import { HelloWave } from '@/components/ui/hello-wave';
import { ModeToggle } from '@/components/ui/mode-toggle';
import { Text } from '@/components/ui/text';
import { View } from '@/components/ui/view';

export default function HomeScreen() {
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
      }}
    >
      <View style={{ alignItems: 'center', justifyContent: 'center' }}>
        <HelloWave />
        <Text variant='heading'>BNA</Text>
      </View>

      <ModeToggle />
    </View>
  );
}
