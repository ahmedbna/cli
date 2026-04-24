import MaterialIcons from '@expo/vector-icons/Feather';
import {
  Badge,
  Icon,
  Label,
  NativeTabs,
  VectorIcon,
} from 'expo-router/unstable-native-tabs';
import { Platform } from 'react-native';

export default function HomeLayout() {
  return (
    <NativeTabs
      minimizeBehavior='onScrollDown'
      // labelStyle={{
      //   default: { color: COLORS.blackSoft },
      //   selected: { color: COLORS.black },
      // }}
      // iconColor={{
      //   default: COLORS.blackSoft,
      //   selected: COLORS.black,
      // }}
      // badgeBackgroundColor={COLORS.red}
      labelVisibilityMode='labeled'
      disableTransparentOnScrollEdge={true}
    >
      <NativeTabs.Trigger name='index'>
        {Platform.select({
          ios: <Icon sf='house.fill' />,
          android: (
            <Icon src={<VectorIcon family={MaterialIcons} name='home' />} />
          ),
        })}
        <Label>Home</Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name='settings'>
        {Platform.select({
          ios: <Icon sf='gear' />,
          android: (
            <Icon src={<VectorIcon family={MaterialIcons} name='settings' />} />
          ),
        })}
        <Label>Settings</Label>
        <Badge>1</Badge>
      </NativeTabs.Trigger>

      {/* <NativeTabs.Trigger
        name='search'
        role={isLiquidGlassAvailable() ? 'search' : undefined}
      >
        {Platform.select({
          ios: <Icon sf='magnifyingglass' />,
          android: (
            <Icon src={<VectorIcon family={MaterialIcons} name='search' />} />
          ),
        })}
        <Label>Search</Label>
      </NativeTabs.Trigger> */}
    </NativeTabs>
  );
}
