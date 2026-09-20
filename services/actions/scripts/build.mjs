import { build } from 'esbuild'

// One bundle per function. Both currently carry every sender's client code: handlers.ts holds the entry for
// both functions and names all four ports, so either entry pulls the lot in. Splitting that would mean a
// handler module per function, and the dispatcher's own reaper already sends to the dead-letter queue, so
// the saving would be a few hundred kilobytes of cold start for a second copy of the wiring to keep in step.
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
    // Bundled CommonJS dependencies still call require(), which ESM output does not define.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })
  // importing the bundle proves it resolves and loads without its environment; the handlers read it on first call
  const loaded = await import(new URL(`../dist/${name}/index.mjs`, import.meta.url).href)
  if (typeof loaded.handler !== 'function') throw new Error(`dist/${name}/index.mjs exports no handler`)
  console.log(`built dist/${name}/index.mjs`)
}
