import { build } from 'esbuild'

// one bundle per function, so the authorizer, which stands in front of every request, ships without the route
// handlers and the SQS client
for (const name of ['api', 'authorizer']) {
  const result = await build({
    entryPoints: [`src/lambda/${name}.ts`],
    outfile: `dist/${name}/index.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    minify: true,
    sourcemap: 'linked',
    metafile: true,
    legalComments: 'none',
    // Bundled CommonJS dependencies still call require(), which ESM output does not define.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })
  const bundled = Object.keys(result.metafile.inputs)
  if (name === 'authorizer' && bundled.some((input) => input.includes('client-sqs'))) {
    throw new Error('the authorizer bundle contains the SQS client')
  }
  // importing the bundle proves it resolves and loads without its environment; the handlers read it on first call
  const loaded = await import(new URL(`../dist/${name}/index.mjs`, import.meta.url).href)
  if (typeof loaded.handler !== 'function') throw new Error(`dist/${name}/index.mjs exports no handler`)
  console.log(`built dist/${name}/index.mjs`)
}
