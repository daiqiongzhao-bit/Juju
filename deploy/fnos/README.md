# Juju · 飞牛 fnOS 应用（FPK）

本目录是 Juju 家庭管家的**飞牛 fnOS 应用打包工程**，用于生成可上传至
[飞牛应用商店](https://developer.fnnas.com/)（或应用中心手动安装）的 `.fpk` 安装包。

应用本体即标准 Docker 服务（镜像 `daiqiongzhao/juju:<版本>`，见根目录
`docker-compose.yml`），FPK 只是飞牛平台的安装壳：负责安装向导、数据目录、
密钥初始化与生命周期管理。

## 命名规范（重要）

飞牛要求 `appname`（同时作为 Docker Compose 项目名）**只能由小写字母、数字、
连字符、下划线组成且以字母或数字开头**。本项目统一使用 `juju`：

| 位置 | 值 |
| --- | --- |
| `manifest` → `appname` | `juju` |
| `manifest` → `desktop_applaunchname` | `juju.Application` |
| `config/resource` → docker-project name | `juju` |
| `config/privilege` → username/groupname | `docker-juju` |
| `app/ui/config` → 入口 ID | `juju.Application` |
| compose → `container_name` | `juju` |
| 安装后路径 | `/var/apps/juju/...` |

`display_name`（"Juju 家庭管家"）是展示名，不受此限。历史上曾因 `appname=Juju`
（大写 J）导致安装报错 `invalid project name "Juju"`，改名为 `juju` 后修复。

## 目录结构

```
deploy/fnos/
├── manifest                 # 应用元信息（名称/版本/平台/changelog）
├── ICON.PNG / ICON_256.PNG  # 应用图标（应用中心展示）
├── app/
│   ├── docker/
│   │   └── docker-compose.yaml   # 容器定义（镜像 tag = 应用版本）
│   └── ui/
│       ├── config               # 桌面入口（URL 类型，端口 ${wizard_port}）
│       ├── images/icon_64.png   # 桌面入口小图标
│       └── images/icon_256.png
├── cmd/                     # 生命周期脚本（飞牛平台调用，均要求幂等）
│   ├── main                 # start/stop/status 入口
│   ├── install_init / install_callback
│   ├── upgrade_init / upgrade_callback
│   ├── uninstall_init / uninstall_callback
│   └── config_init / config_callback
├── config/
│   ├── resource            # docker-project 声明
│   └── privilege           # 运行身份（run-as: package）
└── wizard/
    ├── install             # 安装向导：服务端口（默认 3000，1—65535）
    └── uninstall           # 卸载向导：保留/删除数据（默认保留）
```

## 发版流程（每次发布新版本）

1. **确认镜像已推送**：先完成正常发版（`git tag vX.Y.Z` + push），确认
   Docker Hub 上 `daiqiongzhao/juju:X.Y.Z` 与 `:latest` 均已就位。
   飞牛安装时只从 Docker Hub 拉镜像，**不会现场构建**。

2. **同步版本号**（两处必须一致）：
   - `manifest` 的 `version`
   - `app/docker/docker-compose.yaml` 的 `image: daiqiongzhao/juju:<版本>`
   - 顺带更新 `manifest` 的 `changelog` 摘要。

3. **打包**：

   ```bash
   # fnpack 工具（飞牛官方，需 Linux x86_64）
   # 下载：https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64
   fnpack build          # 在 deploy/fnos/ 目录执行，产出 juju.fpk（文件名取自 appname）
   ```

4. **分发**（二选一）：
   - 上传 GitHub Release assets（随版本发布，附 `juju.fpk`）——
     v0.0.27 安装包：<https://github.com/daiqiongzhao-bit/Juju/releases/download/v0.0.27/juju.fpk>；
   - 登录 [飞牛开发者中心](https://developer.fnnas.com/) 提交上架
     （需先注册并通过开发者认证，账号操作只能由本人完成）。

## 安装后行为说明

- **包体小是正常的**：`.fpk` 只有十几 KB，因为它只包含安装壳（manifest、
  compose、向导、生命周期脚本、图标）。应用本体是 Docker Hub 上的镜像
  `daiqiongzhao/juju:<版本>`（约 900+ MB），安装时由飞牛自动拉取。
  代价是安装过程需要能访问 Docker Hub。
- **端口**：安装向导收集 `wizard_port`（默认 3000）。飞牛会把向导答案作为
  环境变量注入 compose 运行环境（真机验证过的机制），compose 中直接写
  `${wizard_port}:3000`，重启/升级后端口保持。
- **数据目录**：`${TRIM_PKGVAR}/data`（数据库与上传文件）和
  `${TRIM_PKGVAR}/backups`（每日自动备份，保留 7 份）。`TRIM_PKGVAR` 即
  `/var/apps/juju/var`（符号链接到存储池 `@appdata/juju`），升级保留、
  卸载可选清除。**注意**：数据不在文件管理器的"应用文件"共享里，需要通过
  SSH 访问 `/var/apps/juju/var/`。
- **为什么不用 `.env` 文件**：实测飞牛运行 compose 的工作目录不是 compose
  文件所在目录，同目录 `.env` 不会被读取（表现为 `variable is not set`
  告警 → `invalid spec` 安装失败）。端口与路径一律使用平台注入的环境变量，
  与官方文档及真机在跑的 Docker 应用（fn-bitwarden 等）做法一致。
- **密钥**：首次安装由 `install_callback` 自动生成
  `DB_ENCRYPTION_KEY` / `JUJU_SM4_KEY` / `SESSION_SECRET`，保存在
  `/var/apps/juju/etc/juju.env`（权限 600，通过 compose `env_file` 注入
  容器）。**升级与重装不会覆盖**——覆盖会导致已加密数据库无法解密。
- **卸载**：默认保留全部数据，仅当用户在卸载向导选择"删除数据"时，才清除
  `TRIM_PKGVAR` 下的 data/backups 与 etc 中的密钥（`TRIM_PKGVAR` 本身不动）。

## 注意事项 / 已知限制

- **平台架构**：当前 `platform = x86`，镜像仅推送 x86_64。飞牛 ARM
  机型无法安装，需为镜像补齐 `linux/arm64` 多架构（buildx
  `--platform linux/amd64,linux/arm64`）后再发 ARM 版 FPK。
- **真机验证进度**：前两版在真机安装分别暴露了两个问题并已修复——①
  `appname` 大写导致项目名非法；② 同目录 `.env` 不被 compose 读取导致卷路径
  为空。当前版本改为真机在跑应用同款的环境变量直注模式，但**尚未完整跑通
  一次真机安装**。再次安装前建议先通过"应用中心 → 手动安装"验证；
  若仍失败，报错截图发来即可继续定位。
- 若飞牛后续调整 FPK 规范，以 `fnpack create` 生成的新模板为准，
  对照更新本目录的 `wizard/`、`config/`、`cmd/` 结构。
