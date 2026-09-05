// Test-only ESM hook: resolve extensionless relative imports ("./db")
// to their TypeScript source ("./db.ts") so plain `node
// --experimental-strip-types` can run the suite without a bundler.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (typeof specifier === "string" && specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const cand = path.resolve(path.dirname(fileURLToPath(context.parentURL)), `${specifier}.ts`);
      if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
    }
    throw e;
  }
}
