import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";

const outfile = "dist/cli.mjs";

// Single source of truth for the version: package.json, injected at build time so
// the CLI and the manifest can never drift apart.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/cli.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  minify: true,
  sourcemap: false,
  define: {
    "process.env.COWL_VERSION": JSON.stringify(pkg.version),
  },
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
