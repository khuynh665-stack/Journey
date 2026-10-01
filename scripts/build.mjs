import { build } from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
fs.mkdirSync('dist/public', { recursive: true });

await Promise.all([
  // Capture snippet: small IIFE for customer sites.
  build({ entryPoints: ['src/sdk/index.ts'], bundle: true, minify: true, format: 'iife', target: 'es2018', outfile: 'dist/public/journey.js', sourcemap: true }),
  // Dashboard SPA.
  build({ entryPoints: ['src/dashboard/main.tsx'], bundle: true, minify: true, format: 'iife', target: 'es2020', outfile: 'dist/public/app.js', loader: { '.tsx': 'tsx' }, define: { 'process.env.NODE_ENV': '"production"' }, jsx: 'transform' }),
  // Collector.
  build({ entryPoints: ['src/collector/main.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist/server.js', sourcemap: true, packages: 'external' }),
]);
fs.copyFileSync('src/dashboard/index.html', 'dist/public/index.html');
console.log('built dist/public/journey.js, dist/public/app.js, dist/server.js');
