#!/usr/bin/env bash
# 本地隔离实盘沙盒启动器：
# 1. 自动加载仓库 .env（不打印任何密钥或 Token）；
# 2. 在 /tmp/narrateos-sandbox（可通过 NARRATEOS_SANDBOX_DIR 覆盖）初始化隔离的 DSH_HOME 与工作区；
# 3. 软链当前仓库构建产物并注册 narrateos profile；
# 4. 启动 DSH Web 服务并将标准输出与错误流实时 tee 到 $SANDBOX_DIR/dsh.log（传入 --init-only 仅初始化目录）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX_DIR="${NARRATEOS_SANDBOX_DIR:-/tmp/narrateos-sandbox}"
SANDBOX_HOME="$SANDBOX_DIR/home"
SANDBOX_WS="$SANDBOX_DIR/ws"
PROFILE_DIR="$SANDBOX_HOME/profiles/narrateos"
LOG_FILE="$SANDBOX_DIR/dsh.log"

if [ -f "$REPO_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$REPO_ROOT/.env"
    set +a
fi

mkdir -p "$PROFILE_DIR/node_modules/@narrateos" "$SANDBOX_WS/books"

ln -sfn "$REPO_ROOT/node_modules/@deepseek-ai" "$PROFILE_DIR/node_modules/@deepseek-ai"
ln -sfn "$REPO_ROOT/packages/dsh-book-store" "$PROFILE_DIR/node_modules/@narrateos/dsh-book-store"
ln -sfn "$REPO_ROOT/packages/dsh-book-tools" "$PROFILE_DIR/node_modules/@narrateos/dsh-book-tools"
ln -sfn "$REPO_ROOT/packages/dsh-client-ui-studio" "$PROFILE_DIR/node_modules/@narrateos/dsh-client-ui-studio"
ln -sfn "$REPO_ROOT/packages/dsh-pipeline" "$PROFILE_DIR/node_modules/@narrateos/dsh-pipeline"
ln -sfn "$REPO_ROOT/presets/dsh-preset-narrateos" "$PROFILE_DIR/node_modules/@narrateos/dsh-preset-narrateos"

if [ ! -f "$SANDBOX_HOME/.credentials.yaml" ]; then
    for cred_candidate in "$HOME/.deepseek-harness/.credentials.yaml" "/tmp/narrateos-dsh-live/home/.credentials.yaml"; do
        if [ -f "$cred_candidate" ]; then
            cp "$cred_candidate" "$SANDBOX_HOME/.credentials.yaml"
            chmod 600 "$SANDBOX_HOME/.credentials.yaml"
            break
        fi
    done
fi

cat > "$PROFILE_DIR/package.json" <<'EOF'
{
    "name": "dsh-profile-narrateos",
    "private": true,
    "dsh": {
        "profile": {
            "bundles": [
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                "@narrateos/dsh-preset-narrateos"
            ]
        }
    }
}
EOF

cat > "$PROFILE_DIR/cordis.yml" <<'EOF'
[]
EOF

DEFAULT_AGENT_MODEL="${NARRATEOS_SANDBOX_AGENT_MODEL:-${NARRATEOS_MODEL_STRONG:-}}"
{
    echo "- id: locale"
    echo "  name: \"@deepseek-ai/dsh-client-locale\""
    echo "  config:"
    echo "    preference: zh"
    if [ -n "$DEFAULT_AGENT_MODEL" ]; then
        echo "- id: agent-default-model"
        echo "  name: \"@deepseek-ai/dsh-agent-default-model\""
        echo "  config:"
        echo "    provider: \"${NARRATEOS_SANDBOX_PROVIDER:-deepseek-official}\""
        echo "    model: \"$DEFAULT_AGENT_MODEL\""
        echo "    reasoningEffort: \"${NARRATEOS_SANDBOX_EFFORT:-medium}\""
    fi
} > "$PROFILE_DIR/cordis.patch.yml"

echo "[narrateos-sandbox] 已就绪：HOME=$SANDBOX_HOME | WS=$SANDBOX_WS | LOG=$LOG_FILE"

if [ "${1:-}" = "--init-only" ]; then
    exit 0
fi

cd "$SANDBOX_WS"
DSH_HOME="$SANDBOX_HOME" "$REPO_ROOT/node_modules/.bin/dsh" \
    --profile narrateos \
    --no-open \
    --host "${HOST:-127.0.0.1}" \
    --port "${PORT:-0}" 2>&1 | tee "$LOG_FILE"
