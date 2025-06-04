import { Tabs } from 'expo-router';
import React from 'react';
import { Platform } from 'react-native';

import BlurBackground from '@/components/ui/blur-background';
import { HapticTab } from '@/components/ui/haptic-tab';
import { Icon } from '@/components/ui/icon';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { Earth, Home, TestTube2 } from 'lucide-react-native';

export default function TabLayout() {
  const colorScheme = useColorScheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? 'light'].tint,
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarBackground: BlurBackground,
        tabBarStyle: Platform.select({
          ios: {
            // Use a transparent background on iOS to show the blur effect
            position: 'absolute',
          },
          default: {},
        }),
      }}
    >
      <Tabs.Screen
        name='index'
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => (
            <Icon IconComponent={Home} size={24} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name='explore'
        options={{
          title: 'Explore',
          tabBarIcon: ({ color }) => (
            <Icon IconComponent={Earth} size={24} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name='test'
        options={{
          title: 'Test',
          tabBarIcon: ({ color }) => (
            <Icon IconComponent={TestTube2} size={24} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
