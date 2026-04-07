import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/index.js',
  banner: { js: '#!/usr/bin/env node' },
  packages: 'external',
  define: { 'process.env.NODE_ENV': '"production"' },
});

console.log('✅ Build complete → dist/index.js');
