import { SignOutButton } from '@/components/auth/singout';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/convex/_generated/api';
import { useQuery } from 'convex/react';
import { Text, View } from 'react-native';
import { useColor } from '@/hooks/useColor';
import { Button } from '@/components/ui/button';
import { useModeToggle } from '@/hooks/useModeToggle';

export default function ProfileScreen() {
  const text = useColor('text');
  const user = useQuery(api.auth.loggedInUser);
  const { mode, toggleMode } = useModeToggle();

  if (user === undefined) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <Spinner color={text} />
      </View>
    );
  }

  if (user === null) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <Text
          style={{
            color: text,
            fontSize: 15,
            fontWeight: '700',
          }}
        >
          Not Authenticated
        </Text>
      </View>
    );
  }

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
        YOUR CONVEX User ID
      </Text>
      <Text
        style={{
          fontSize: 13,
          color: text,
          fontWeight: '500',
        }}
        numberOfLines={1}
        ellipsizeMode='middle'
      >
        {user._id}
      </Text>

      <SignOutButton />

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
