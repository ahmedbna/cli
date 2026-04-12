// src/agent/tools/docs/convex/index.ts
// Central registry of all documentation topics

import { convexFileStorageDocs } from './convex-file-storage.js';
import { convexFullTextSearchDocs } from './convex-full-text-search.js';
import { convexPaginationDocs } from './convex-pagination.js';
import { convexHttpActionsDocs } from './convex-http-actions.js';
import {
  convexSchedulingCronDocs,
  convexSchedulingRuntimeDocs,
} from './convex-scheduling.js';
import { convexNodeActionsDocs } from './convex-node-actions.js';
import { convexTypesDocs } from './convex-types.js';
import { convexAdvancedQueriesDocs } from './convex-advanced-queries.js';
import { convexAdvancedMutationsDocs } from './convex-advanced-mutations.js';
import { convexFunctionCallingDocs } from './convex-function-calling.js';
import { convexPresenceDocs } from './convex-presence.js';

export const convexDocs: Record<string, string> = {
  'file-storage': convexFileStorageDocs,
  'full-text-search': convexFullTextSearchDocs,
  pagination: convexPaginationDocs,
  'http-actions': convexHttpActionsDocs,
  'scheduling-cron': convexSchedulingCronDocs,
  'scheduling-runtime': convexSchedulingRuntimeDocs,
  'actions-nodejs': convexNodeActionsDocs,
  'typescript-types': convexTypesDocs,
  'function-calling': convexFunctionCallingDocs,
  'query-advanced': convexAdvancedQueriesDocs,
  'mutation-advanced': convexAdvancedMutationsDocs,
  presence: convexPresenceDocs,
};

export type ConvexDocTopic = keyof typeof convexDocs;

export const CONVEX_DOC_TOPICS = Object.keys(convexDocs) as ConvexDocTopic[];
