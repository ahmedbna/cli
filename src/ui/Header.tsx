// src/ui/Header.tsx
//
// Minimal startup header. We print this ONCE, above the Ink render root,
// using chalk + console.log rather than an Ink component. Reason: Ink
// renders inside a live region; content printed above the render root
// sits in the terminal scrollback permanently, which is what we want
// for the welcome banner.

import chalk from 'chalk';

export function printHeader(opts: { stack: string; cwd: string }): void {
  const { stack, cwd } = opts;
  const shortCwd = shortenPath(cwd);
  const accent = chalk.hex('#FAD40B');
  const mute = chalk.hex('#6b7280');

  console.log();
  // console.log(
  //   accent.bold('  BNA') + mute(`  ${model} · ${stack} · ${shortCwd}`),
  // );
  console.log(accent.bold('  BNA') + mute(`  ${shortCwd}`));
  console.log(mute('       esc to interrupt ·  ctrl+c to exit'));
  // console.log(
  //   mute('  Type /help for commands · esc to interrupt · ctrl+c to exit'),
  // );
  console.log();
}

function shortenPath(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}
