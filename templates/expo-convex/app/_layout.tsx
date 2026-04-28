import { View } from 'react-native';
import { Authentication } from '@/components/auth/authentication';
import { ConvexAuthProvider } from '@convex-dev/auth/react';
import {
  Authenticated,
  AuthLoading,
  ConvexReactClient,
  Unauthenticated,
} from 'convex/react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { Spinner } from '@/components/ui/spinner';
import { ThemeProvider } from '@/theme/theme-provider';
import { ThemeToggleProvider, useModeToggle } from '@/hooks/useModeToggle';
import * as SecureStore from 'expo-secure-store';
import 'react-native-reanimated';
import { useColor } from '@/hooks/useColor';

const secureStorage = {
  getItem: SecureStore.getItemAsync,
  setItem: SecureStore.setItemAsync,
  removeItem: SecureStore.deleteItemAsync,
};

const convex = new ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL!, {
  unsavedChangesWarning: false,
});

export const unstable_settings = {
  anchor: '(home)',
};

export default function RootLayout() {
  return (
    <ThemeToggleProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ThemeToggleProvider>
  );
}

const App = () => {
  const text = useColor('text');
  const background = useColor('background');
  const { isDark } = useModeToggle(); // NOW SAFE

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ConvexAuthProvider client={convex} storage={secureStorage}>
          <AuthLoading>
            <View
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: background,
              }}
            >
              <Spinner color={text} />
            </View>
          </AuthLoading>

          <Unauthenticated>
            <Authentication />
          </Unauthenticated>

          <Authenticated>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name='(home)' />
              <Stack.Screen name='+not-found' />
            </Stack>
          </Authenticated>
        </ConvexAuthProvider>
      </KeyboardProvider>

      {/* StatusBar MUST also be inside */}
      <StatusBar style={isDark ? 'light' : 'dark'} />
    </GestureHandlerRootView>
  );
};
