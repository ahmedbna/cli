// src/agent/tools/docs/expo/index.ts
// Central registry of all documentation topics

import { expoDevBuildDocs } from './expo-dev-build.js';
import { expoEasBuildDocs } from './expo-eas-build.js';
import { expoRoutingDocs } from './expo-routing.js';
import { expoImageMediaDocs } from './expo-image-media.js';
import { expoAnimationsDocs } from './expo-animations.js';
import { expoHapticsGesturesDocs } from './expo-haptics-gestures.js';

export const expoDocs: Record<string, string> = {
  'dev-build': expoDevBuildDocs,
  'eas-build': expoEasBuildDocs,
  routing: expoRoutingDocs,
  'image-media': expoImageMediaDocs,
  animations: expoAnimationsDocs,
  'haptics-gestures': expoHapticsGesturesDocs,
};

export type ExpoDocTopic = keyof typeof expoDocs;

export const EXPO_DOC_TOPICS = Object.keys(expoDocs) as ExpoDocTopic[];
