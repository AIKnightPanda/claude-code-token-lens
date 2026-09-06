#!/usr/bin/env bash
#
# 打一个「已签名 + 已公证」的 macOS 包。
#
#   bash scripts/build-signed.sh                 # 签名 + 公证
#   SKIP_NOTARIZE=1 bash scripts/build-signed.sh # 只签名（快，本机能开，别人下载会被拦）
#   bash scripts/build-signed.sh --save-password  # 只把 App 专用密码存进钥匙串，不构建
#
# 公证需要两样东西：
#   1. Developer ID Application 证书 —— 已经在登录钥匙串里，不用管；
#   2. Apple ID + App 专用密码 —— 第一次运行会问你，之后存在登录钥匙串里，不用再输。
# 密码是交互输入的，不会进 shell 历史，也不会写进仓库里的任何文件。
set -euo pipefail
cd "$(dirname "$0")/.."

KEYCHAIN_SERVICE="claude-code-token-lens-notary"

: "${APPLE_SIGNING_IDENTITY:=Developer ID Application: Wei Xiong (C95F3RNX59)}"
: "${APPLE_TEAM_ID:=C95F3RNX59}"

save_password() {
  local account="$1"
  local pw pw2
  read -r -s -p "App 专用密码（形如 abcd-efgh-ijkl-mnop）: " pw; echo
  read -r -s -p "再输一次确认: " pw2; echo
  [ "$pw" = "$pw2" ] || { echo "两次输入不一致" >&2; exit 1; }
  security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$account" -w "$pw"
  echo "已存入登录钥匙串（服务名 $KEYCHAIN_SERVICE），下次不用再输。"
}

# 钥匙串里存过的 Apple ID（account 字段），用来省掉重复输入
stored_account() {
  security find-generic-password -s "$KEYCHAIN_SERVICE" 2>/dev/null \
    | awk -F'"' '/"acct"<blob>/ {print $4}'
}

case "${1:-}" in
  --save-password)
    read -r -p "Apple ID（邮箱）: " acct
    save_password "$acct"
    exit 0
    ;;
  -h|--help)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "")
    ;;
  *)
    echo "未知参数：$1（用 --help 看用法）" >&2
    exit 2
    ;;
esac

if ! security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY"; then
  echo "钥匙串里找不到签名证书：$APPLE_SIGNING_IDENTITY" >&2
  echo "当前可用身份：" >&2
  security find-identity -v -p codesigning >&2
  exit 1
fi
export APPLE_SIGNING_IDENTITY APPLE_TEAM_ID

if [ "${SKIP_NOTARIZE:-0}" = "1" ]; then
  echo "==> 只签名，跳过公证"
else
  if [ -z "${APPLE_ID:-}" ]; then
    APPLE_ID="$(stored_account || true)"
  fi
  if [ -z "${APPLE_ID:-}" ]; then
    read -r -p "Apple ID（邮箱）: " APPLE_ID
  fi
  if [ -z "${APPLE_PASSWORD:-}" ]; then
    APPLE_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$APPLE_ID" -w 2>/dev/null || true)"
  fi
  if [ -z "${APPLE_PASSWORD:-}" ]; then
    echo "钥匙串里还没有 $APPLE_ID 的 App 专用密码。"
    save_password "$APPLE_ID"
    APPLE_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$APPLE_ID" -w)"
  fi
  export APPLE_ID APPLE_PASSWORD
  echo "==> 签名并提交 Apple 公证（一般 1-5 分钟，慢的时候会更久）"
fi

npm run tauri:build

APP="src-tauri/target/release/bundle/macos/Claude Code Token Lens.app"
DMG="$(ls -t src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)"

# Tauri 只公证 .app。但用户下载到的是 dmg，Gatekeeper 首先校验的也是 dmg，
# 所以 dmg 得单独再走一遍公证 —— 否则双击 dmg 仍会弹「无法验证开发者」。
if [ "${SKIP_NOTARIZE:-0}" != "1" ] && [ -n "$DMG" ]; then
  echo
  echo "==> 公证 DMG 本身"
  xcrun notarytool submit "$DMG" \
    --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
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
  echo "==> 公证票据是否已订进包里"
  xcrun stapler validate "$APP" || true
  xcrun stapler validate "$DMG" || true
  echo
  echo "产物：$DMG"
fi
