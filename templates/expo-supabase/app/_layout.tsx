import { View } from 'react-native';
import { Authentication } from '@/components/auth/authentication';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { Spinner } from '@/components/ui/spinner';
import { ThemeProvider } from '@/theme/theme-provider';
import { ThemeToggleProvider, useModeToggle } from '@/hooks/useModeToggle';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { useColor } from '@/hooks/useColor';
import 'react-native-reanimated';

// TanStack Query is our reactivity layer — the Supabase equivalent of
// Convex's automatic re-rendering on data change. Configure once, here.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export const unstable_settings = {
  anchor: '(home)',
};

export default function RootLayout() {
  return (
    <ThemeToggleProvider>
      <ThemeProvider>
        <AuthProvider>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </AuthProvider>
      </ThemeProvider>
    </ThemeToggleProvider>
  );
}

const App = () => {
  const text = useColor('text');
  const background = useColor('background');
  const { isDark } = useModeToggle();
  const { status } = useAuth();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        {status === 'loading' && (
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
        )}

        {status === 'unauthenticated' && <Authentication />}

        {status === 'authenticated' && (
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name='(home)' />
            <Stack.Screen name='+not-found' />
          </Stack>
        )}
      </KeyboardProvider>

      <StatusBar style={isDark ? 'light' : 'dark'} />
    </GestureHandlerRootView>
  );
};
