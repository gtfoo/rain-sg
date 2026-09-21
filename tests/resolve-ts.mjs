/**
 * Let the test runner follow the app's own imports.
 *
 * `src/lib/observations.ts` imports `./store`, extensionless, because that is
 * what TypeScript's bundler resolution and Next both expect. Node's ESM loader
 * requires the extension, so importing a library under `--experimental-strip-
 * types` fails on the first relative import.
 *
 * Adding `.ts` to every import in the source would change shipping code to suit
 * the tests. This resolves it in the loader instead, so the tests exercise the
 * files exactly as deployed.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // Not a TypeScript file after all — fall through to normal resolution.
    }
  }
  return next(specifier, context);
}

// Importing this file as `--import` both registers the hook below and exposes
// `resolve` above for the hook itself to use.
if (!process.env.__RAIN_TS_RESOLVER) {
  process.env.__RAIN_TS_RESOLVER = "1";
  register(pathToFileURL(import.meta.filename));
}
