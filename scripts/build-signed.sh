#!/usr/bin/env bash
#
# 打一个「已签名 + 已公证」的 macOS 包。
#
#   bash scripts/build-signed.sh                 # 签名 + 公证
#   SKIP_NOTARIZE=1 bash scripts/build-signed.sh # 只签名（快，本机能开，别人下载会被拦）
#   bash scripts/build-signed.sh --setup         # 只写公证凭据配置，不构建
#
# 需要两样东西：
#   1. Developer ID Application 证书 —— 装在登录钥匙串里即可，脚本会自己找；
#   2. App Store Connect API 密钥 —— 一个 .p8 私钥 + Key ID + Issuer ID，
#      配置写在 ~/.config/apple-notary.env，多个项目可以共用同一把。
# 也兼容 APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID 那套；环境变量里有就直接用。
set -euo pipefail
cd "$(dirname "$0")/.."

NOTARY_ENV="${NOTARY_ENV:-$HOME/.config/apple-notary.env}"

: "${APPLE_SIGNING_IDENTITY:=Developer ID Application: Wei Xiong (C95F3RNX59)}"
: "${APPLE_TEAM_ID:=C95F3RNX59}"

setup() {
  local p8 keyid issuer
  echo "配置 App Store Connect API 密钥（写入 $NOTARY_ENV）"
  echo "密钥在 App Store Connect → 用户和访问 → 集成 → 密钥 里创建/查看。"
  read -r -p ".p8 私钥文件路径: " p8
  p8="${p8/#\~/$HOME}"
  [ -f "$p8" ] || { echo "找不到文件：$p8" >&2; exit 1; }
  read -r -p "Key ID（10 位，通常就是文件名里 AuthKey_ 后面那段）: " keyid
  read -r -p "Issuer ID（一串 UUID）: " issuer
  mkdir -p "$(dirname "$NOTARY_ENV")"
  umask 077
  cat > "$NOTARY_ENV" <<EOF
# App Store Connect API 密钥，用于 xcrun notarytool 公证。
# 真正的私钥是下面这个 .p8 文件，这里只存路径和两个 ID。
APPLE_API_KEY_PATH=$p8
APPLE_API_KEY=$keyid
APPLE_API_ISSUER=$issuer
EOF
  chmod 600 "$NOTARY_ENV"
  echo "已写入 $NOTARY_ENV（权限 600）。"
}

case "${1:-}" in
  --setup) setup; exit 0 ;;
  -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
esac

if ! security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY"; then
  echo "钥匙串里找不到签名证书：$APPLE_SIGNING_IDENTITY" >&2
  echo "当前可用身份：" >&2
  security find-identity -v -p codesigning >&2
  exit 1
fi
export APPLE_SIGNING_IDENTITY APPLE_TEAM_ID

# 公证凭据。notarytool 支持两套，二选一即可；这里优先 API 密钥。
NOTARY_ARGS=()
if [ "${SKIP_NOTARIZE:-0}" = "1" ]; then
  echo "==> 只签名，跳过公证"
else
  if [ -z "${APPLE_API_KEY_PATH:-}" ] && [ -f "$NOTARY_ENV" ]; then
    # shellcheck disable=SC1090
    set -a; . "$NOTARY_ENV"; set +a
  fi
  if [ -n "${APPLE_API_KEY_PATH:-}" ] && [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    [ -f "$APPLE_API_KEY_PATH" ] || { echo "找不到私钥文件：$APPLE_API_KEY_PATH" >&2; exit 1; }
    export APPLE_API_KEY_PATH APPLE_API_KEY APPLE_API_ISSUER
    NOTARY_ARGS=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
    echo "==> 用 App Store Connect API 密钥公证（Key ID $APPLE_API_KEY）"
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ]; then
    export APPLE_ID APPLE_PASSWORD
    NOTARY_ARGS=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
    echo "==> 用 Apple ID + App 专用密码公证"
  elif [ -n "${APPLE_API_KEY_PATH:-}" ] && [ -z "${APPLE_API_ISSUER:-}" ]; then
    echo "$NOTARY_ENV 里的 APPLE_API_ISSUER 还没填。" >&2
    echo "去 App Store Connect → 用户和访问 → 集成 → 密钥，页面上方那串 UUID 就是，填进去即可。" >&2
    exit 1
  else
    echo "没有找到公证凭据。先跑一次：bash scripts/build-signed.sh --setup" >&2
    exit 1
  fi
fi

npm run tauri:build

APP="src-tauri/target/release/bundle/macos/Claude Code Token Lens.app"
DMG="$(ls -t src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)"

# Tauri 只公证并装订 .app。但用户下载到的是 dmg，Gatekeeper 首先校验的也是 dmg，
# 所以 dmg 得单独再走一遍 —— 否则双击 dmg 仍会弹「无法验证开发者」。
if [ "${SKIP_NOTARIZE:-0}" != "1" ] && [ -n "$DMG" ]; then
  echo
  echo "==> 公证 DMG 本身"
  xcrun notarytool submit "$DMG" "${NOTARY_ARGS[@]}" --wait
  xcrun stapler staple "$DMG"
fi

echo
echo "==> 校验签名"
codesign --verify --deep --strict --verbose=2 "$APP"
echo
echo "==> Gatekeeper 判定（accepted 才算彻底搞定）"
spctl -a -vvv "$APP" || true
if [ -n "$DMG" ]; then
  echo
  echo "==> 公证票据"
  xcrun stapler validate "$APP" || true
  xcrun stapler validate "$DMG" || true
  echo
  echo "产物：$DMG"
fi
