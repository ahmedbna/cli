import { Link, Stack } from 'expo-router';
import { Text, View } from 'react-native';
import { useColor } from '@/hooks/useColor';

export default function NotFoundScreen() {
  const text = useColor('text');
  return (
    <>
      <Stack.Screen options={{ title: 'Oops!' }} />
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
          gap: 16,
        }}
      >
        <Text style={{ color: text, fontSize: 20, fontWeight: '700' }}>
          This screen doesn&apos;t exist.
        </Text>
        <Link href='/'>
          <Text style={{ color: text, fontSize: 15, textDecorationLine: 'underline' }}>
            Go to home screen
          </Text>
        </Link>
      </View>
    </>
  );
}
