import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ConvexReactClient } from 'convex/react';
import { ConvexAuthProvider } from '@convex-dev/auth/react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { ThemeToggleProvider, useModeToggle } from '@/hooks/useModeToggle';
import { ThemeProvider } from '@/theme/theme-provider';
import { View } from 'react-native';
import { Authenticated, Unauthenticated, AuthLoading } from 'convex/react';
import { useColor } from '@/hooks/useColor';
import { Spinner } from '@/components/ui/spinner';
import { Authentication } from '@/components/auth/authentication';
import * as SecureStore from 'expo-secure-store';
import 'react-native-reanimated';
import { NativeTabs } from 'expo-router/unstable-native-tabs';

const secureStorage = {
  getItem: SecureStore.getItemAsync,
  setItem: SecureStore.setItemAsync,
  removeItem: SecureStore.deleteItemAsync,
};

const convex = new ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL!, {
  unsavedChangesWarning: false,
});

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ConvexAuthProvider client={convex} storage={secureStorage}>
          <ThemeToggleProvider>
            <ThemeProvider>
              <RootNavigator />
              <StatusBarHandler />
            </ThemeProvider>
          </ThemeToggleProvider>
        </ConvexAuthProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const StatusBarHandler = () => {
  const { isDark } = useModeToggle();
  return <StatusBar style={isDark ? 'light' : 'dark'} />;
};

const RootNavigator = () => {
  const text = useColor('text');
  const background = useColor('background');

  return (
    <>
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
        <NativeTabs
          minimizeBehavior='onScrollDown'
          labelVisibilityMode='labeled'
        >
          <NativeTabs.Trigger name='index' disableTransparentOnScrollEdge>
            <NativeTabs.Trigger.Icon
              sf={{ default: 'house', selected: 'house.fill' }}
              md='home'
            />
            <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>

          <NativeTabs.Trigger name='profile' disableTransparentOnScrollEdge>
            <NativeTabs.Trigger.Icon
              sf={{ default: 'person', selected: 'person.fill' }}
              md='person'
            />
            <NativeTabs.Trigger.Label>Profile</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>

          {/* <NativeTabs.Trigger
            name='search'
            role='search'
            disableTransparentOnScrollEdge
          >
            <NativeTabs.Trigger.Icon sf='magnifyingglass' md='search' />
            <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger> */}
        </NativeTabs>
      </Authenticated>
    </>
  );
};
