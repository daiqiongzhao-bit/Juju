# Juju · 飞牛 fnOS 应用（FPK）

本目录是 Juju 家庭管家的**飞牛 fnOS 应用打包工程**，用于生成可上传至
[飞牛应用商店](https://developer.fnnas.com/)（或应用中心手动安装）的 `.fpk` 安装包。

应用本体即标准 Docker 服务（镜像 `daiqiongzhao/juju:<版本>`，见根目录
`docker-compose.yml`），FPK 只是飞牛平台的安装壳：负责安装向导、数据目录、
密钥初始化与生命周期管理。

## 目录结构

```
deploy/fnos/
├── manifest                 # 应用元信息（名称/版本/平台/端口/changelog）
├── ICON.PNG / ICON_256.PNG  # 应用图标（应用中心展示）
├── app/
│   ├── docker/
│   │   └── docker-compose.yaml   # 容器定义（镜像 tag = 应用版本）
│   └── ui/
│       ├── config               # 桌面入口（URL 类型，端口 ${wizard_port}）
│       └── images/icon_64.png   # 桌面入口小图标
│       └── images/icon_256.png
├── cmd/                     # 生命周期脚本（飞牛平台调用，均要求幂等）
│   ├── main                 # start/stop/status 入口
│   ├── install_init / install_callback
│   ├── upgrade_init / upgrade_callback
│   ├── uninstall_init / uninstall_callback
│   └── config_init / config_callback
├── config/
│   ├── resource            # docker-project + data-share 声明
│   └── privilege           # 运行身份（run-as: package）
└── wizard/
    ├── install             # 安装向导：服务端口（默认 3000）
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
   fnpack build          # 在 deploy/fnos/ 目录执行，产出 Juju.fpk
   ```

4. **分发**（二选一）：
   - 上传 GitHub Release assets（随版本发布，附 `Juju.fpk`）——
     v0.0.27 安装包：<https://github.com/daiqiongzhao-bit/Juju/releases/download/v0.0.27/Juju.fpk>；
   - 登录 [飞牛开发者中心](https://developer.fnnas.com/) 提交上架
     （需先注册并通过开发者认证，账号操作只能由本人完成）。

## 安装后行为说明

- **端口**：安装向导收集 `wizard_port`（默认 3000），写入
  `docker/.env` 供 compose 的 `${wizard_port}` 占位使用。
- **密钥**：首次安装由 `install_callback` 自动生成
  `DB_ENCRYPTION_KEY` / `JUJU_SM4_KEY` / `SESSION_SECRET`，保存在
  `/var/apps/Juju/etc/juju.env`（权限 600）。**升级与重装不会覆盖**
  ——覆盖会导致已加密数据库无法解密。重装前请先备份
  `/var/apps/Juju/shares/Juju/data`。
- **数据**：数据库与上传文件位于共享目录 `Juju/data`（用户在飞牛文件
  管理器中可见）；每日自动备份在 `Juju/backups`，保留最近 7 份。
- **卸载**：默认保留全部数据，仅当用户在卸载向导选择"删除数据"时才清理。

## 注意事项 / 已知限制

- **平台架构**：当前 `platform = x86`，镜像仅推送 x86_64。飞牛 ARM
  机型无法安装，需为镜像补齐 `linux/arm64` 多架构（buildx
  `--platform linux/amd64,linux/arm64`）后再发 ARM 版 FPK。
- **未经真机验证**：本包按 fnpack 1.2.3 模板与官方文档制作，尚未在真实
  飞牛设备上测试。首次上架建议先通过"应用中心 → 手动安装"本地验证
  安装/升级/卸载全流程，再提交商店审核。
- 若飞牛后续调整 FPK 规范，以 `fnpack create` 生成的新模板为准，
  对照更新本目录的 `wizard/`、`config/`、`cmd/` 结构。
