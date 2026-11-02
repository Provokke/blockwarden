import { build } from 'esbuild'

await build({
  entryPoints: ['src/handler.ts'],
  outfile: 'dist/monitor/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  sourcemap: 'linked',
  legalComments: 'none',
  // Bundled CommonJS deps still call require(), which ESM output doesn't define.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})

console.log('built dist/monitor/index.mjs')
