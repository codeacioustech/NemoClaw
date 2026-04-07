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

  if (!fs.existsSync(destModules)) {
    fs.mkdirSync(destModules, { recursive: true });
  }

  console.log(`[afterPack] Syncing node_modules into packaged app...`);
  // Copy missing modules without overwriting existing ones
  execSync(`rsync -a --ignore-existing "${srcModules}/" "${destModules}/"`, {
    stdio: "inherit",
  });
  console.log(`[afterPack] Done.`);
};
