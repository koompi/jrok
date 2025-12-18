#!/usr/bin/env node

const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['cli/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'cli/dist/index.js',
  minify: true
}).catch(() => process.exit(1));
