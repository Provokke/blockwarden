import { build } from 'esbuild'

// One bundle per function. Both carry every sender's client code since handlers.ts names all four
// ports. Splitting would save a few hundred KB of cold start for a second copy of the wiring to
// keep in step.
for (const name of ['dispatcher', 'sender']) {
  await build({
    entryPoints: [`src/lambda/${name}.ts`],
    outfile: `dist/${name}/index.mjs`,
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
  // importing the bundle proves it resolves and loads without its environment
  const loaded = await import(new URL(`../dist/${name}/index.mjs`, import.meta.url).href)
  if (typeof loaded.handler !== 'function') throw new Error(`dist/${name}/index.mjs exports no handler`)
  console.log(`built dist/${name}/index.mjs`)
}
