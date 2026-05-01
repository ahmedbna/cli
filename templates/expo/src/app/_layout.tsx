import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { ThemeToggleProvider, useModeToggle } from '@/hooks/useModeToggle';
import { ThemeProvider } from '@/theme/theme-provider';
import 'react-native-reanimated';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeToggleProvider>
          <ThemeProvider>
            <NativeTabs
              minimizeBehavior='onScrollDown'
              labelVisibilityMode='labeled'
            >
              <NativeTabs.Trigger name='(home)' disableTransparentOnScrollEdge>
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
            <StatusBarHandler />
          </ThemeProvider>
        </ThemeToggleProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const StatusBarHandler = () => {
  const { isDark } = useModeToggle();
  return <StatusBar style={isDark ? 'light' : 'dark'} />;
};
