// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const path = require("path");

/** @type {import("vite").UserConfig} */
module.exports = {
  root: path.join(__dirname, "renderer"),
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: path.join(__dirname, "dist-renderer"),
    emptyOutDir: true,
    sourcemap: true,
  },
};
