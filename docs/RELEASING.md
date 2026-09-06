# 发布流程（维护者向）

面向仓库维护者，普通用户不需要看这份文档。

## 发版

推一个 `v*` 标签，`.github/workflows/release.yml` 会在 GitHub 的机器上把两个平台都构建、
签名、公证好，挂到一个草稿 Release 上：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

macOS 出的是 universal 包（Apple 芯片与 Intel 通用），Windows 出 `.exe` 和 `.msi`。
手动触发（workflow_dispatch）则只构建、不建 Release，产物在 Actions 的 artifact 里。

## 签名与公证（macOS）

要让别人下载后双击就能打开，需要两步：**签名**（证明是谁做的）和**公证**（把包传给
Apple 扫一遍，Apple 回一张票据装订进包里）。只签名不公证，别人下载后照样被 Gatekeeper 拦。

需要的东西：

1. **Developer ID Application 证书** —— 装在登录钥匙串里即可，脚本会自己找；
2. **App Store Connect API 密钥** —— 一个 `.p8` 私钥 + Key ID + Issuer ID。
   在 App Store Connect → 用户和访问 → 集成 → 密钥 里创建，权限选 Developer 就够。
   `.p8` 只能下载一次，存好；Issuer ID 是该页面上方那串 UUID。

### 本地打包

配置写在 `~/.config/apple-notary.env`（权限 600，不在仓库里），多个项目可以共用同一把密钥：

```bash
bash scripts/build-signed.sh --setup    # 交互填 .p8 路径 / Key ID / Issuer ID
bash scripts/build-signed.sh            # 签名 + 公证 + 装订 + 校验
```

只想快速验证不公证：`SKIP_NOTARIZE=1 bash scripts/build-signed.sh`。

脚本也兼容 `APPLE_ID` + `APPLE_PASSWORD`（App 专用密码）那套 —— 环境变量里有就直接用。
但不推荐：Tauri 是把密码作为**命令行参数**传给 `notarytool` 的，`ps` 能看到；
API 密钥传的是文件路径，没有这个问题，而且可以按 key 单独吊销。

### GitHub Actions

在仓库 Settings → Secrets and variables → Actions 里加下面这些。一个都不配也能构建，
只是产出未签名的包。

| Secret | 值 |
|---|---|
| `APPLE_CERTIFICATE` | 证书导出的 `.p12` 转 base64：钥匙串访问 → 我的证书 → 右键「导出」存成 `.p12` 并设个密码，然后 `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | 上一步导出 `.p12` 时设的密码 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: 你的名字 (团队ID)` |
| `APPLE_API_KEY_P8` | `.p8` 文件的**内容**（整个文本，含 `-----BEGIN PRIVATE KEY-----`） |
| `APPLE_API_KEY` | Key ID（10 位，就是文件名里 `AuthKey_` 后面那段） |
| `APPLE_API_ISSUER` | Issuer ID（UUID） |

Windows 侧要去掉 SmartScreen 提示需要另买一张代码签名证书，目前没配。

### 为什么 .app 和 .dmg 都要公证

Tauri 只公证并装订 `.app`，然后给 `.dmg` 签个名就完事了。但用户下载到手的是 `.dmg`，
Gatekeeper 首先校验的也是 `.dmg` —— 只公证 `.app` 的话，双击 dmg 仍会弹「无法验证开发者」。
所以本地脚本和 CI 都在 Tauri 之后又单独把 dmg 提交了一次公证并装订。

CI 里也正因为这一步，`tauri-action` 只负责构建，Release 的创建和上传交给后面的
`gh release`——否则挂上去的会是还没公证的那份 dmg。

### 验证是否真的过关

模拟「从网上下载」：

```bash
cp "src-tauri/target/release/bundle/dmg/"*.dmg /tmp/t.dmg
xattr -w com.apple.quarantine "0083;00000000;Safari;|com.apple.Safari" /tmp/t.dmg
spctl -a -t open --context context:primary-signature -vvv /tmp/t.dmg
```

打印 `accepted / source=Notarized Developer ID` 才算彻底搞定。
