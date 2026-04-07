// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

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

  // Get production dependency names (not devDependencies)
  const pkg = JSON.parse(
    fs.readFileSync(path.join(context.packager.projectDir, "package.json"), "utf-8")
  );
  const prodDeps = Object.keys(pkg.dependencies || {});

  let copied = 0;
  for (const dep of prodDeps) {
    const destPath = path.join(destModules, dep);
    const srcPath = path.join(srcModules, dep);

    if (!fs.existsSync(destPath) && fs.existsSync(srcPath)) {
      const stat = fs.lstatSync(srcPath);
      if (stat.isSymbolicLink()) {
        // Resolve symlink and copy the real directory (e.g., nemoclaw -> ../nemoclaw)
        const realPath = fs.realpathSync(srcPath);
        execSync(`cp -r "${realPath}" "${destPath}"`, { stdio: "inherit" });
      } else {
        execSync(`cp -r "${srcPath}" "${destPath}"`, { stdio: "inherit" });
      }
      copied++;
    }
  }

  // Also copy transitive deps: walk each production dep's own dependencies
  const visited = new Set();
  function copyTransitiveDeps(pkgDir) {
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

    const allDeps = {
      ...depPkg.dependencies,
      ...depPkg.optionalDependencies,
    };

    for (const name of Object.keys(allDeps || {})) {
      const destPath = path.join(destModules, name);
      const srcPath = path.join(srcModules, name);

      if (!fs.existsSync(destPath) && fs.existsSync(srcPath)) {
        const stat = fs.lstatSync(srcPath);
        if (stat.isSymbolicLink()) {
          const realPath = fs.realpathSync(srcPath);
          try {
            execSync(`cp -r "${realPath}" "${destPath}"`, { stdio: "pipe" });
            copied++;
          } catch { /* optional dep may fail */ }
        } else {
          try {
            execSync(`cp -r "${srcPath}" "${destPath}"`, { stdio: "pipe" });
            copied++;
          } catch { /* optional dep may fail */ }
        }
      }

      // Recurse into this dep
      const installed = fs.existsSync(path.join(srcPath, "package.json"))
        ? srcPath
        : null;
      if (installed) copyTransitiveDeps(installed);
    }
  }

  // Walk transitive deps of each production dependency
  for (const dep of prodDeps) {
    const srcPath = path.join(srcModules, dep);
    copyTransitiveDeps(srcPath);
  }

  console.log(`[afterPack] Copied ${copied} missing modules into packaged app.`);
};
