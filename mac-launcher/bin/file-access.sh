#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# File Access Helper for Agent
# Routes file operations to mac-launcher HTTP API
# Usage:
#   file-access.sh read /path/to/folder
#   file-access.sh write /path/to/file "content"
#   file-access.sh list /path/to/folder

ACTION=$1
FILEPATH=$2
CONTENT=$3

case $ACTION in
  read|list)
    curl -s -X POST http://127.0.0.1:3001/api/files/read \
      -H "Content-Type: application/json" \
      -d "{\"filePath\": \"$FILEPATH\"}"
    ;;
  write)
    curl -s -X POST http://127.0.0.1:3001/api/files/write \
      -H "Content-Type: application/json" \
      -d "{\"filePath\": \"$FILEPATH\", \"content\": $(echo "$CONTENT" | jq -Rs .)}"
    ;;
  *)
    echo '{"error":"Usage: file-access.sh (read|write|list) <path> [content]"}'
    ;;
esac
