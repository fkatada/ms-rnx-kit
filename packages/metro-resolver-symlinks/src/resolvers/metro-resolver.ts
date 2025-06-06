import { isFileModuleRef, parseModuleRef } from "@rnx-kit/tools-node/module";
import { normalizePath } from "@rnx-kit/tools-node/path";
import type { CustomResolver, Resolution } from "metro-resolver";
import * as path from "node:path";
import type { ModuleResolver, ResolutionContextCompat } from "../types";
import { resolveFrom } from "../utils/package";

export const resolveModulePath: ModuleResolver = (
  { extraNodeModules, originModulePath },
  moduleName,
  _platform
) => {
  // Performance: Assume relative links are not going to hit symlinks
  const ref = parseModuleRef(moduleName);
  if (isFileModuleRef(ref)) {
    return moduleName;
  }

  const pkgName = ref.scope ? `${ref.scope}/${ref.name}` : ref.name;
  const pkgRoot =
    extraNodeModules?.[pkgName] ?? resolveFrom(pkgName, originModulePath);
  if (!pkgRoot) {
    return moduleName;
  }

  const replaced = moduleName.replace(pkgName, pkgRoot);
  const relativePath = path.relative(path.dirname(originModulePath), replaced);
  return relativePath.startsWith(".")
    ? relativePath
    : `.${path.sep}${relativePath}`;
};

export function applyMetroResolver(
  resolve: CustomResolver,
  ctx: ResolutionContextCompat,
  moduleName: string,
  platform: string
): Resolution {
  // Resolve redirects before we try to resolve the module:
  // https://github.com/facebook/metro/blob/v0.76.7/docs/Resolution.md#redirectmodulepath-string--string--false
  const realModuleName = ctx.redirectModulePath(moduleName);
  if (realModuleName === false) {
    return { type: "empty" };
  }

  const modifiedModuleName = resolveModulePath(ctx, realModuleName, platform);
  // @ts-expect-error We pass 4 arguments instead of 3 to be backwards compatible
  return resolve(ctx, normalizePath(modifiedModuleName), platform, null);
}
