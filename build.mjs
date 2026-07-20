import { build } from "esbuild";
import { chmodSync } from "node:fs";

const outfile = "dist/cli.mjs";

await build({
  entryPoints: ["src/cli.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  minify: true,
  sourcemap: false,
  // ESM shim so bundled CJS deps that reference require/__dirname keep working.
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __cowlCreateRequire } from 'node:module';",
      "const require = __cowlCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
