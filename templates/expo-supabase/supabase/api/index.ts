// supabase/api/index.ts
//
// Single entry point for all business logic. Import as:
//   import { api } from '@/supabase/api';
// then call like:
//   await api.users.get();
//   await api.auth.signIn(email, password);
//
// This matches the shape of Convex's generated `api` object, so
// moving screens between the two backends is a minimal-diff operation.

import { users } from './users';
import { auth } from './auth';

export const api = { users, auth };

export type { User } from './users';
export { ApiError } from './_helpers';
