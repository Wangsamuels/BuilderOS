// Bundles one app (workspace packages inlined, third-party deps left external).
import { build } from "esbuild";
const [entry, outfile] = process.argv.slice(2);
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [
    {
      name: "externalize-deps",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (a) => (a.path.startsWith("@builderos/") ? undefined : { path: a.path, external: true }));
      },
    },
  ],
});
console.log(`built ${outfile}`);
