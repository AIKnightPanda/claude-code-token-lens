# 发布流程（维护者向）

面向仓库维护者，普通用户不需要看这份文档。

## 发版

`.github/workflows/release.yml` 会在 GitHub 的机器上把两个平台都构建出来：推一个 `v*` 标签
（例如 `git tag v1.0.0 && git push origin v1.0.0`），流水线会把 macOS 的 universal `.dmg` 和
Windows 的 `.exe`/`.msi` 挂到一个草稿 Release 上，本地不需要打包。

## 签名与公证（macOS）

macOS 上要让别人下载后双击就能打开，需要两步：**签名**（证明是谁做的）和**公证**
（把包传给 Apple 扫一遍，Apple 回一张票据订在包里）。只签名不公证，别人下载后仍会被
Gatekeeper 拦下。

公证**不需要另外申请证书** —— 用的还是同一张 Developer ID Application 证书，
外加一个 Apple ID 的「App 专用密码」。

**一次性准备：生成 App 专用密码**

1. 浏览器打开 <https://appleid.apple.com>，用你的开发者 Apple ID 登录；
2. 进「登录与安全」→「App 专用密码」→ 点「+」或「生成密码」；
3. 名字随便起（比如 `token-lens-notary`），确定后会显示一串
   `abcd-efgh-ijkl-mnop` 形式的密码 —— **它只显示这一次**，先复制下来；
4. 回到终端：

   ```bash
   bash scripts/build-signed.sh --save-password
   ```

   输入 Apple ID 邮箱和刚才那串密码。它会存进登录钥匙串，以后都不用再输。
   这个密码不会进 shell 历史，也不会写进仓库里的任何文件。

**之后每次打包**

```bash
bash scripts/build-signed.sh
```

签名 → 提交 Apple 公证（一般 1~5 分钟）→ 把票据订进 `.app` 和 `.dmg` → 自动校验。
最后一行 `spctl` 打印 `accepted` 就说明彻底搞定了。只想快速验证不公证，加
`SKIP_NOTARIZE=1`。

**GitHub Actions 打包**：在仓库 Settings → Secrets and variables → Actions 里加下面这些
secret，流水线就会自动签名 + 公证；一个都不配也能构建，只是产出未签名的包。

| Secret | 值 |
|---|---|
| `APPLE_CERTIFICATE` | 证书导出的 `.p12` 转 base64：钥匙串访问 → 我的证书 → 右键「导出」存成 `.p12` 并设个密码，然后 `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | 上一步导出 `.p12` 时设的密码 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: 你的名字 (团队ID)` |
| `APPLE_ID` | 你的 Apple ID 邮箱 |
| `APPLE_PASSWORD` | 上面生成的 App 专用密码 |
| `APPLE_TEAM_ID` | 团队 ID |

Windows 侧要去掉 SmartScreen 提示需要另买一张代码签名证书，目前没配。

### 为什么 .app 和 .dmg 都要公证

Tauri 只公证并装订 `.app`，然后给 `.dmg` 签个名就完事了。但用户下载到手的是 `.dmg`，
Gatekeeper 首先校验的也是 `.dmg` —— 只公证 `.app` 的话，双击 dmg 仍会弹「无法验证开发者」。
所以 `scripts/build-signed.sh` 在 Tauri 之后又单独把 dmg 提交了一次公证并装订。

验证是否真的过关（模拟「从网上下载」）：

```bash
cp "src-tauri/target/release/bundle/dmg/"*.dmg /tmp/t.dmg
xattr -w com.apple.quarantine "0083;00000000;Safari;|com.apple.Safari" /tmp/t.dmg
spctl -a -t open --context context:primary-signature -vvv /tmp/t.dmg
```

打印 `accepted / source=Notarized Developer ID` 才算彻底搞定。

### 另一种凭据：App Store Connect API 密钥

除了「Apple ID + App 专用密码」，`notarytool` 也支持 App Store Connect 的 API 密钥
（一个 `.p8` 私钥 + Key ID + Issuer ID）。Tauri 同样原生支持，把这三个环境变量设上即可，
设了它就不会再看 `APPLE_ID` / `APPLE_PASSWORD`：

```bash
export APPLE_API_KEY_PATH=/path/to/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY=XXXXXXXXXX        # Key ID
export APPLE_API_ISSUER=<Issuer ID>    # 一串 UUID
```

相比 App 专用密码的好处：传的是文件路径而不是密码本身，不会出现在进程命令行里
（`ps` 能看到别人的命令行参数）；可以按 key 单独吊销；多个项目共用一把也不用重复维护。
CI 里把 `.p8` 的内容存成 secret，运行时写到临时文件再指过去就行。
