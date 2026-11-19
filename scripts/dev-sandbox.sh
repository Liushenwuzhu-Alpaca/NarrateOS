#!/usr/bin/env bash
# 保留已有脚本入口；参数与调用者工作目录原样交给启动器。
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/dev-sandbox.mjs" "$@"
