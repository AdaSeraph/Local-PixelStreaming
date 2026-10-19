# Local-PixelStreaming

**Unreal Engine 5.5 Pixel Streaming 2 内网 / 离线部署包** —— 不联网、不开 VPN、不查公网 IP, 双击即可在局域网里把打包好的 UE 程序推流到浏览器 / Pad。

> Offline (intranet) launcher for Unreal Engine 5.5 **Pixel Streaming 2**, built on top of Epic Games' official Pixel Streaming Infrastructure. No internet, no VPN, no public-IP lookup, no public STUN/TURN.

---

## 原项目 / Upstream

本仓库基于 Epic Games 官方的 Pixel Streaming 前端与信令服务器:

| | |
| --- | --- |
| 原项目 | **[EpicGamesExt/PixelStreamingInfrastructure](https://github.com/EpicGamesExt/PixelStreamingInfrastructure)** |
| 分支 / 版本 | `UE5.5` 分支, release **4.1.2**(`WebServers/DOWNLOAD_VERSION` = `UE5.5-4.1.2`) |
| 对应插件 | UE 5.5 自带的 Pixel Streaming 2 插件 |
| 原项目许可 | MIT License, Copyright 2004-2025 Epic Games, Inc.(见 [`WebServers/LICENSE.md`](WebServers/LICENSE.md)) |
| 本地 TURN | coturn Windows 便携包, 来自原项目 release [`v4.5.2-coturn-windows`](https://github.com/EpicGamesExt/PixelStreamingInfrastructure/releases/tag/v4.5.2-coturn-windows) |

`WebServers/` 目录是原项目代码(由 UE 插件的 `get_ps_servers.bat` 下载), 只做了少量为离线运行所需的修改(见下文 [对原项目的修改](#对原项目的修改))。根目录和 `Offline/` 下的启动器、脚本、配置是本项目新增的。

本项目不是 Epic Games 官方项目, 与 Epic Games 没有关联。

---

## 为什么需要它

Epic 自带的 `WebServers/SignallingWebServer/platform_scripts/cmd/start.bat` 启动时会:

1. 第一次运行时从外网下载 Node.js 和 coturn, 再执行 `npm install`;
2. 访问 `api.ipify.org` 查询公网 IP;
3. 用查到的 IP 拼出 TURN 地址, 连同 Google 的 STUN 服务器一起下发给浏览器和 UE。

在内网 / 不开 VPN 时第 2 步查不到 IP, TURN 地址被拼成 `turn::19303` 这种非法地址, 浏览器拒绝创建 `RTCPeerConnection`, 画面出不来。

而同一内网里浏览器和 UE 本来就能直接互通, ICE 服务器列表留空即可连上(UE 编辑器内置的信令服务器下发的也是空列表)。本项目的启动器用自带的便携 Node 直接运行已编译好的信令服务器(Wilbur), 启动过程中:

- 不下载、不编译、不 `npm install`;
- 不查询公网 IP, 不使用公网 STUN / TURN;
- 可选: 启动自带的本机 coturn, 或使用网管提供的内网 TURN(只放行 TCP、UDP 被拦时用);
- 启动 UE 时自动带上 `-httpproxy=""`, 避免 UE 在设置了系统代理的电脑上连不上本机信令服务器;
- 网页首页默认使用"悬停鼠标"和"触摸当鼠标", 浏览器里能直接点中 UE 的 UI 按钮, Pad 单指点按即鼠标点击。

---

## 目录结构

```
PixelStreaming2/
├─ Start-PixelStreaming.bat     一键启动: 信令服务器 + UE 程序
├─ Start-SignallingServer.bat   只启动信令服务器(UE 在别的电脑上 / 手动启动 UE 时用)
├─ Stop-PixelStreaming.bat      停止信令服务器、TURN、UE 程序
├─ Check-PixelStreaming.bat     自检: 运行时是否完整、网卡地址、端口占用、UE 程序位置
├─ Open-Firewall.bat            添加 Windows 防火墙入站规则(管理员运行)
├─ PixelStreaming.ini           设置: 端口、UE 窗口模式、分辨率、TURN 等
├─ README-Intranet.txt          现场使用说明 + 常见问题(给现场人员看的纯文本版)
├─ Offline/
│  ├─ ps2-offline.js            启动器(start / server / stop / check / firewall)
│  ├─ web/index.html            网页首页: 带上默认参数跳转到 player.html
│  ├─ Prepare-OfflineRuntime.*  在开发机上生成离线运行时
│  ├─ Install-ToPackage.bat     把本目录拷进 UE 打包产物并验证
│  ├─ node/                     便携 Node      (生成产物, 不进 Git)
│  └─ coturn/                   便携 coturn    (生成产物, 不进 Git)
└─ WebServers/                  Epic Pixel Streaming Infrastructure(原项目)
```

---

## 使用方法

### 1. 开发机: 生成离线运行时(只需一次)

便携 Node、编译好的信令服务器、运行期 `node_modules` 和 coturn 体积较大, **不在 Git 里**, clone 之后需要在一台能上网的电脑上生成:

```bat
Offline\Prepare-OfflineRuntime.bat              :: nodejs.org + registry.npmjs.org
Offline\Prepare-OfflineRuntime.bat -Mirror cn   :: npmmirror.com 国内镜像, 不开 VPN 也行
Offline\Prepare-OfflineRuntime.bat -NodeZip D:\node-v22.14.0-win-x64.zip   :: 使用已下载好的 Node
```

它会:

1. 下载便携 Node(版本取 `WebServers/NODE_VERSION`, 目前是 v22.14.0)并校验 SHA256;
2. 在临时目录安装依赖, 编译 `Common` / `Signalling` / `SignallingWebServer`;
3. 生成只含运行期依赖、**没有符号链接 / 目录联接**的 `node_modules`(npm workspaces 默认的目录联接存的是绝对路径, 拷到别的电脑就会断);
4. 替换进 `WebServers/SignallingWebServer` 的 `dist/` 和 `node_modules/`;
5. 去掉自带网页里的 Google 字体外链(内网里会卡住网页加载);
6. 准备 coturn 便携版(`-NoTurn` 可跳过)。

全部成功之后才替换现有运行时, 中途失败不会破坏已有的可用版本。更新了 `WebServers/`(重新运行过 `get_ps_servers.bat`)之后需要重新生成。

### 2. 放到 UE 打包目录

启动器按 UE 打包后的目录布局查找程序:

```
<打包目录>/
├─ <项目名>.exe
└─ <项目名>/
   └─ Samples/PixelStreaming2/   ← 本目录
```

可以手动拷贝, 也可以在打包脚本最后一步调用:

```bat
Offline\Install-ToPackage.bat E:\pack\MyProject-Shipping\Windows
```

它会把整个目录镜像过去, 并用拷过去的 Node 加载一次信令服务器, 确认运行时完整。

UE 程序需要启用 **Pixel Streaming 2** 插件。

### 3. 现场电脑(内网)

1. 把整个打包目录拷过去, 不用装 Node, 不用联网。
2. 每台新电脑第一次使用(或移动了目录、改了端口)时: 右键 `Open-Firewall.bat` → **以管理员身份运行**。
3. 双击 `Start-PixelStreaming.bat`: 先启动信令服务器, 再启动 UE。窗口里会显示访问地址, 例如 `http://192.168.1.40/`。
4. 其他电脑 / Pad 用 Chrome / Edge / Safari 打开这个地址, 点一下画面开始播放。
5. 停止: 关闭信令服务器窗口(会同时关闭 UE), 或双击 `Stop-PixelStreaming.bat`。

UE 默认和平时一样正常显示窗口, 本机屏幕与网页画面同步; **不要最小化 UE 窗口**, 否则网页画面会停住。不需要本机显示时把 `WindowMode` 改成 `offscreen`。

### UE 和信令服务器不在同一台电脑

- 信令电脑: 双击 `Start-SignallingServer.bat`。
- UE 电脑: 在 `PixelStreaming.ini` 里设置 `[Signalling] Enabled=0`、`[Game] SignallingAddress=<信令电脑 IP>`, 然后双击 `Start-PixelStreaming.bat`。
- 两台电脑都运行一次 `Open-Firewall.bat`。

手动启动 UE 时至少需要:

```bat
MyProject.exe -PixelStreamingURL=ws://<信令电脑 IP>:8888 -httpproxy=""
```

---

## 配置(`PixelStreaming.ini`)

用记事本修改, 保存后重新运行 `Start-PixelStreaming.bat` 生效。完整说明见文件内注释。

| 节 | 键 | 默认 | 说明 |
| --- | --- | --- | --- |
| `[Signalling]` | `Enabled` | `1` | 本机是否运行信令服务器 |
| | `PlayerPort` | `80` | 浏览器访问端口, 被占用时改成 `8080` 之类 |
| | `StreamerPort` | `8888` | UE 连接信令服务器的端口 |
| | `HostAddress` | 自动 | 显示给其他设备的内网 IPv4, 多网卡选错时手动填 |
| | `ConsoleMessages` | `basic` | 信令消息显示: `none` / `basic` / `verbose` / `formatted` |
| | `MaxPlayers` | `0` | 每个 UE 最多同时连接的浏览器数, `0` = 不限 |
| `[Game]` | `LaunchGame` | `1` | 是否顺带启动 UE |
| | `GameExe` | 自动 | UE 程序路径, 留空 = 打包目录里的 `<项目名>.exe` |
| | `SignallingAddress` | | 信令服务器在别的电脑上时填它的 IP |
| | `WindowMode` | `normal` | `normal` / `windowed` / `fullscreen` / `offscreen` |
| | `ResX` / `ResY` | `1920` / `1080` | 只对 `windowed` / `fullscreen` / `offscreen` 生效 |
| | `WebRTCMinPort` / `WebRTCMaxPort` | | 固定 WebRTC 媒体端口范围(网管只放行固定端口时用) |
| | `ExtraArgs` | | 追加给 UE 的启动参数 |
| | `StopGameOnExit` | `1` | 关闭信令窗口时是否同时关闭 UE |
| `[Turn]` | `Mode` | `off` | `off` 内网直连 / `local` 本机 coturn / `external` 内网 TURN |
| | `Port` | `3478` | `local` 模式的监听端口(TCP + UDP) |
| | `Server` / `User` / `Password` | | `external` 模式必填; `local` 留空则每次随机生成 |
| | `ForceRelay` | `0` | `1` = 强制浏览器媒体全部走 TURN |

网页操作方式通过地址参数控制, 打开 `http://IP/` 时会自动带上 `HoveringMouse=true` 和 `FakeMouseWithTouches=true`; 需要 Pad 多指手势时用 `http://IP/?FakeMouseWithTouches=false`。

---

## 对原项目的修改

相对 [PixelStreamingInfrastructure](https://github.com/EpicGamesExt/PixelStreamingInfrastructure) `UE5.5-4.1.2`, `WebServers/` 下只改动了以下内容:

- **`Frontend/implementations/typescript/src/*.html`、`SignallingWebServer/www/*.html`**: 去掉 Google Fonts 外链, 字体回退到 `Arial, sans-serif`(内网里加载外链会卡住网页)。
- **`SignallingWebServer/www/`**: 原 `.gitignore` 忽略了预编译前端, 这里改为提交进仓库, 离线运行时直接使用; 新增 `www/index.html`(由 `Offline/web/index.html` 生成), 带默认参数跳转到 `player.html`。
- **`SignallingWebServer/.gitignore`**: 不再忽略 `www/`, 新增忽略 `logs/`。
- **`SignallingWebServer/platform_scripts/cmd/common.bat`**: 查询公网 IP 加 5 秒超时, 查不到时退回本机内网地址, 不再拼出非法 TURN 地址(仅影响 Epic 原版启动脚本; 本项目的启动器不调用它)。

除此之外均为原项目代码, 版权归 Epic Games, Inc. 所有。

---

## 常见问题

现场排查(端口占用、其他电脑打不开、没有画面、按钮点不了、画面卡住、Pad 打不开、卡顿延迟等)见 [`README-Intranet.txt`](README-Intranet.txt) 第五节。需要远程协助时, 双击 `Check-PixelStreaming.bat` 截图, 连同 `Logs/` 目录一起发给开发。

注意: 现场电脑**不要**运行 `WebServers/get_ps_servers.bat` 和 `WebServers/SignallingWebServer/platform_scripts/cmd/*.bat`, 它们会去外网下载东西。

---

## 许可 / License

- `WebServers/` 下的原项目代码: MIT License, Copyright 2004-2025 Epic Games, Inc., 见 [`WebServers/LICENSE.md`](WebServers/LICENSE.md)。
- coturn: 见其自带的 `LICENSE.txt`(随离线运行时生成, 不在仓库中)。
- Node.js: 见其自带的 `LICENSE`(随离线运行时生成, 不在仓库中)。
- 本项目新增的启动器、脚本和文档沿用 MIT License。

Unreal Engine 与 Pixel Streaming 是 Epic Games, Inc. 的商标或注册商标。
