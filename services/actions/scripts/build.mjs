import { build } from 'esbuild'

// one bundle per function, so each Lambda ships only what it imports
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
