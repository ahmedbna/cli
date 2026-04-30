// src/session/backendSetup.ts
//
// Runs between Phase 2 (backend agent) and Phase 3 (frontend agent) of the
// initial build pipeline. Its job is to take a freshly-written backend and
// deploy it so the frontend phase has a real backend to point at.
//
// For expo-convex:
//   1. `npx convex dev --once`         — initialise the Convex project
//   2. `npx @convex-dev/auth`          — set JWT_PRIVATE_KEY + JWKS
//   3. Prompt for any other queued env vars, set them via
//      `npx convex env set NAME "value"`
//   4. `npx convex dev --once`         — redeploy with env vars set
//   5. `npx convex dev` (detached)     — keep the backend running while the
//                                        frontend agent runs and beyond
//
// For expo-supabase:
//   1. Prompt the user for their Supabase project URL and anon key
//      (we do NOT run `npx supabase start` — that requires Docker)
//   2. Prompt for any other queued env vars
//   3. Write everything to .env.local
//
// For expo (no backend): no-op.
//
// All steps are best-effort — a failure here doesn't abort the build, it
// just leaves the user with a TODO they can finish manually. The frontend
// phase still runs.

import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { spawn } from 'child_process';
import { log } from '../utils/logger.js';
import { runInteractive, runStreamed } from '../utils/runProcess.js';
import { getPendingEnvVars, clearPendingEnvVars } from '../agent/tools.js';
import type { Session } from './session.js';
import type { Blueprint } from '../agent/blueprint.js';
import type { StackId } from '../commands/stacks.js';

export interface BackendSetupOptions {
  session: Session;
  stack: StackId;
  blueprint: Blueprint;
}

export interface BackendSetupResult {
  /** True if init/auth/env steps ran successfully and the frontend phase can
   *  rely on a deployed backend. False means the user skipped or it failed. */
  deployed: boolean;
  /** Names of env vars the user actually set during this run. Used by the
   *  finalization step to avoid asking again. */
  envVarsSet: string[];
}

export async function runBackendSetup(
  opts: BackendSetupOptions,
): Promise<BackendSetupResult> {
  const { session, stack, blueprint } = opts;

  if (stack === 'expo') {
    return { deployed: true, envVarsSet: [] };
  }

  console.log();
  log.divider();
  log.info(chalk.bold('Deploying backend before frontend phase'));
  log.divider();

  if (stack === 'expo-convex') {
    return runConvexSetup(session, blueprint);
  }

  if (stack === 'expo-supabase') {
    return runSupabaseSetup(session, blueprint);
  }

  return { deployed: false, envVarsSet: [] };
}

// ─── Convex ───────────────────────────────────────────────────────────────

async function runConvexSetup(
  session: Session,
  blueprint: Blueprint,
): Promise<BackendSetupResult> {
  const projectRoot = session.projectRoot;
  const envVarsSet: string[] = [];

  // Step 1: convex dev --once (interactive — prompts for team / project name)
  console.log();
  log.info(chalk.bold.cyan('Initializing Convex project'));
  log.info(
    chalk.dim(
      'Select your team, enter a project name, and choose deployment type.',
    ),
  );
  console.log();

  const initOk = await runInteractive('npx convex dev --once', projectRoot);
  if (!initOk) {
    log.warn(
      'Convex initialization did not complete. Skipping the rest of backend setup.',
    );
    return { deployed: false, envVarsSet };
  }
  log.success('Convex project initialized.');

  // Step 2: configure auth
  console.log();
  log.info(chalk.bold.cyan('Configuring Convex Auth'));
  log.info(chalk.dim('This sets JWT_PRIVATE_KEY and JWKS on your deployment.'));
  console.log();

  const authOk = await runInteractive('npx @convex-dev/auth', projectRoot);
  if (authOk) {
    log.success('Convex Auth configured.');
  } else {
    log.warn(
      'Convex Auth setup did not complete. You can run ' +
        chalk.cyan('npx @convex-dev/auth') +
        ' manually later.',
    );
  }

  // Step 3: collect env vars (blueprint envVars + agent-queued names),
  //         filter out the ones convex auth already manages.
  const AUTH_MANAGED = new Set(['JWT_PRIVATE_KEY', 'JWKS', 'SITE_URL']);
  const requested = new Set<string>([
    ...blueprint.envVars,
    ...getPendingEnvVars(),
  ]);
  for (const name of session.getConfirmedEnvVars()) requested.delete(name);
  for (const name of AUTH_MANAGED) requested.delete(name);
  const envNames = Array.from(requested).sort();

  if (envNames.length > 0) {
    console.log();
    log.info(chalk.bold.cyan('Environment variables'));
    log.info(
      chalk.dim('The agents asked for the following environment variables:'),
    );
    for (const name of envNames) {
      log.info('  • ' + chalk.yellow(name));
    }
    console.log();

    const { setNow } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'setNow',
        message:
          'Set these now? (You can answer for the ones you have ready and skip the rest.)',
        default: true,
      },
    ]);

    if (setNow) {
      for (const name of envNames) {
        const { value } = await inquirer.prompt([
          {
            type: 'password',
            name: 'value',
            message: `Value for ${chalk.yellow(name)} (leave blank to skip):`,
            mask: '*',
          },
        ]);
        if (!value || !value.trim()) {
          log.info(
            chalk.dim(`Skipped ${name} — set it later with `) +
              chalk.cyan(`npx convex env set ${name} ...`),
          );
          continue;
        }
        const cmd = `npx convex env set ${name} "${value.replace(/"/g, '\\"')}"`;
        const result = await runStreamed(cmd, projectRoot, `Setting ${name}`);
        if (result.ok) {
          log.success(`Set ${name}`);
          session.markEnvVarConfirmed(name);
          envVarsSet.push(name);
        } else {
          log.warn(`Failed to set ${name} — set it manually later.`);
        }
      }
    }
    clearPendingEnvVars();
  }

  // Step 4: redeploy with env vars in place. Auto-fix on schema errors is
  // handled by the typecheck pass in finalization, so we don't loop here.
  console.log();
  const redeploy = await runStreamed(
    'npx convex dev --once',
    projectRoot,
    'Deploying backend to Convex',
    600_000,
  );
  if (!redeploy.ok) {
    log.warn(
      'Backend deploy reported errors — frontend will still run, but ' +
        chalk.cyan('npx convex dev') +
        ' may need a fix-up after generation.',
    );
  } else {
    log.success('Backend deployed.');
  }

  // Step 5: keep convex dev running in the background. Detached + unref so
  // it survives past the CLI exiting; that matches the existing finalization
  // behaviour and means follow-up turns / the simulator launch see live data.
  startBackgroundConvexDev(projectRoot);

  console.log();
  log.divider();
  log.info(chalk.bold('Backend live · running frontend agent next'));
  log.divider();
  console.log();

  return { deployed: redeploy.ok, envVarsSet };
}

function startBackgroundConvexDev(projectRoot: string): void {
  const proc = spawn('npx', ['convex', 'dev'], {
    cwd: projectRoot,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, FORCE_COLOR: '1' },
    shell: true,
  });
  proc.unref();
  log.info(chalk.dim('  npx convex dev — running in background'));
}

// ─── Supabase ─────────────────────────────────────────────────────────────

async function runSupabaseSetup(
  session: Session,
  blueprint: Blueprint,
): Promise<BackendSetupResult> {
  const projectRoot = session.projectRoot;
  const envVarsSet: string[] = [];
  const envLines: string[] = [];

  // Supabase URL + anon key are collected upfront in build.ts before any
  // agent runs and marked confirmed on the session. Skip re-prompting here
  // when they are already in place.
  const confirmed = new Set(session.getConfirmedEnvVars());
  const needUrl = !confirmed.has('EXPO_PUBLIC_SUPABASE_URL');
  const needAnon = !confirmed.has('EXPO_PUBLIC_SUPABASE_ANON_KEY');

  if (needUrl || needAnon) {
    console.log();
    log.info(chalk.bold.cyan('Connecting to your Supabase project'));
    log.info(
      chalk.dim(
        'Create a project at https://supabase.com (free tier is fine), then paste',
      ),
    );
    log.info(
      chalk.dim('the Project URL and anon key below. Both are visible under '),
    );
    log.info(chalk.dim('Project Settings → API in the Supabase dashboard.'));
    console.log();
  }

  if (needUrl) {
    const { url } = await inquirer.prompt([
      {
        type: 'input',
        name: 'url',
        message:
          chalk.yellow('Supabase Project URL') +
          chalk.dim(
            ' (e.g. https://abc123.supabase.co — leave blank to skip):',
          ),
      },
    ]);
    if (url && url.trim()) {
      envLines.push(`EXPO_PUBLIC_SUPABASE_URL=${url.trim()}`);
      session.markEnvVarConfirmed('EXPO_PUBLIC_SUPABASE_URL');
      envVarsSet.push('EXPO_PUBLIC_SUPABASE_URL');
    } else {
      log.info(
        chalk.dim('Skipped Supabase URL — add it to .env.local before running.'),
      );
    }
  }

  if (needAnon) {
    const { anonKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'anonKey',
        message:
          chalk.yellow('Supabase anon (public) key') +
          chalk.dim(' (leave blank to skip):'),
        mask: '*',
      },
    ]);
    if (anonKey && anonKey.trim()) {
      envLines.push(`EXPO_PUBLIC_SUPABASE_ANON_KEY=${anonKey.trim()}`);
      session.markEnvVarConfirmed('EXPO_PUBLIC_SUPABASE_ANON_KEY');
      envVarsSet.push('EXPO_PUBLIC_SUPABASE_ANON_KEY');
    } else {
      log.info(
        chalk.dim(
          'Skipped Supabase anon key — add it to .env.local before running.',
        ),
      );
    }
  }

  // Other env vars the agents queued (excluding the two we just handled)
  const requested = new Set<string>([
    ...blueprint.envVars,
    ...getPendingEnvVars(),
  ]);
  requested.delete('EXPO_PUBLIC_SUPABASE_URL');
  requested.delete('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  for (const name of session.getConfirmedEnvVars()) requested.delete(name);
  const envNames = Array.from(requested).sort();

  if (envNames.length > 0) {
    console.log();
    log.info(chalk.bold.cyan('Additional environment variables'));
    log.info(
      chalk.dim('The agents asked for the following environment variables:'),
    );
    for (const name of envNames) log.info('  • ' + chalk.yellow(name));
    console.log();

    const { setNow } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'setNow',
        message: 'Provide values now? (Leave any blank to skip.)',
        default: true,
      },
    ]);

    if (setNow) {
      for (const name of envNames) {
        const { value } = await inquirer.prompt([
          {
            type: 'password',
            name: 'value',
            message: `Value for ${chalk.yellow(name)} (leave blank to skip):`,
            mask: '*',
          },
        ]);
        if (!value || !value.trim()) {
          log.info(chalk.dim(`Skipped ${name} — add it to .env.local later.`));
          continue;
        }
        envLines.push(`${name}=${value}`);
        session.markEnvVarConfirmed(name);
        envVarsSet.push(name);
      }
    }
    clearPendingEnvVars();
  }

  if (envLines.length > 0) {
    const envFile = path.join(projectRoot, '.env.local');
    const existing = fs.existsSync(envFile)
      ? fs.readFileSync(envFile, 'utf-8')
      : '';
    const merged = mergeDotenv(existing, envLines);
    fs.writeFileSync(envFile, merged, 'utf-8');
    log.success(`Wrote ${envLines.length} value(s) to .env.local`);
  }

  // We consider Supabase "deployed" as long as the URL + anon key are in
  // place — either confirmed upfront in build.ts or captured during this
  // setup pass.
  const finalConfirmed = new Set(session.getConfirmedEnvVars());
  const deployed =
    finalConfirmed.has('EXPO_PUBLIC_SUPABASE_URL') &&
    finalConfirmed.has('EXPO_PUBLIC_SUPABASE_ANON_KEY');

  console.log();
  log.divider();
  log.info(chalk.bold('Supabase config saved · running frontend agent next'));
  log.divider();
  console.log();

  return { deployed, envVarsSet };
}

/**
 * Merge new KEY=VALUE lines into an existing dotenv file, replacing keys
 * that already exist and appending the rest. Comments / blank lines are
 * preserved as-is.
 */
function mergeDotenv(existing: string, newLines: string[]): string {
  const newMap = new Map<string, string>();
  for (const line of newLines) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    newMap.set(line.slice(0, eq), line);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of existing.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(raw);
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      out.push(raw);
      continue;
    }
    const key = trimmed.slice(0, eq);
    if (newMap.has(key)) {
      out.push(newMap.get(key)!);
      seen.add(key);
    } else {
      out.push(raw);
    }
  }
  for (const [key, value] of newMap) {
    if (!seen.has(key)) out.push(value);
  }
  if (out.length > 0 && out[out.length - 1] !== '') out.push('');
  return out.join('\n');
}
