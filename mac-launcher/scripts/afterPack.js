// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function isModuleComplete(dir) {
  return fs.existsSync(path.join(dir, "package.json"));
}

function copyModule(srcModules, destModules, name) {
  const destPath = path.join(destModules, name);
  const srcPath = path.join(srcModules, name);

  if (!fs.existsSync(srcPath)) return false;
  // Check if module is complete (has package.json), not just if directory exists
  if (isModuleComplete(destPath)) return false;

  // Remove partial/empty directory if present
  if (fs.existsSync(destPath)) {
    execSync(`rm -rf "${destPath}"`, { stdio: "pipe" });
  }

  // Ensure parent directory exists (for scoped packages like @buape/carbon)
  const parentDir = path.dirname(destPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const stat = fs.lstatSync(srcPath);
  const realSrc = stat.isSymbolicLink() ? fs.realpathSync(srcPath) : srcPath;

  try {
    execSync(`cp -r "${realSrc}" "${destPath}"`, { stdio: "pipe" });
    console.log(`[afterPack]   + ${name}`);
    return true;
  } catch (err) {
    console.log(`[afterPack]   ! ${name} (copy failed: ${err.message})`);
    return false;
  }
}

exports.default = async function (context) {
  const appName = context.packager.appInfo.productFilename;
  const appDir = path.join(
    context.appOutDir,
    `${appName}.app`,
    "Contents",
    "Resources",
    "app"
  );
  const srcModules = path.join(context.packager.projectDir, "node_modules");
  const destModules = path.join(appDir, "node_modules");

  console.log(`[afterPack] Source: ${srcModules}`);
  console.log(`[afterPack] Dest:   ${destModules}`);

  const pkg = JSON.parse(
    fs.readFileSync(path.join(context.packager.projectDir, "package.json"), "utf-8")
  );
  const prodDeps = Object.keys(pkg.dependencies || {});

  let copied = 0;

  // Copy direct production deps
  for (const dep of prodDeps) {
    if (copyModule(srcModules, destModules, dep)) copied++;
  }

  // Walk transitive deps
  const visited = new Set();
  function walkDeps(pkgDir) {
    if (visited.has(pkgDir)) return;
    visited.add(pkgDir);

    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) return;

    let depPkg;
    try {
      depPkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    } catch {
      return;
    }

    const allDeps = Object.keys({
      ...depPkg.dependencies,
      ...depPkg.optionalDependencies,
    });

    for (const name of allDeps) {
      if (copyModule(srcModules, destModules, name)) copied++;

      const nested = path.join(srcModules, name);
      if (fs.existsSync(path.join(nested, "package.json"))) {
        walkDeps(nested);
      }
    }
  }

  for (const dep of prodDeps) {
    const depDir = path.join(srcModules, dep);
    if (!fs.existsSync(depDir)) continue;
    if (fs.lstatSync(depDir).isSymbolicLink()) {
      walkDeps(fs.realpathSync(depDir));
    } else {
      walkDeps(depDir);
    }
  }
5
  // Verify critical module
  const carbonCheck = path.join(destModules, "@buape", "carbon", "package.json");
  console.log(`[afterPack] @buape/carbon present: ${fs.existsSync(carbonCheck)}`);
  console.log(`[afterPack] Copied ${copied} missing modules.`);
};
