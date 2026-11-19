<div align="center">
  <img src="src-tauri/icons/icon.png" width="96" height="96" alt="Radian Studio 图标" />

  <h1>Radian Studio</h1>

  <p><strong>Radian 相机的桌面取景和控制工作台</strong></p>
  <p>通过局域网直连相机，一边看实时画面，一边调参、拍照和录像。</p>

  <a href="https://github.com/tianrking/radian-studio/actions/workflows/build.yml"><img src="https://github.com/tianrking/radian-studio/actions/workflows/build.yml/badge.svg" alt="桌面端构建状态" /></a>

  <p>
    <a href="#连接相机">连接相机</a> ·
    <a href="#从源码构建">从源码构建</a> ·
    <a href="#用模拟器试用">用模拟器试用</a> ·
    <a href="README.md">English</a>
  </p>

  <img src="docs/studio-preview.webp" width="100%" alt="macOS 上的 Radian Studio，显示模拟器测试画面、AI 检测框、亮度直方图和相机控制" />
  <p><sub>macOS 应用实拍，视频和 AI 事件来自内置模拟器。</sub></p>
</div>

## 连接相机

1. 用网线连接相机，或让电脑加入相机热点。macOS 提示时允许应用访问局域网。
2. 点击 **Find cameras**，也可在 **Device address** 手动填写相机 IPv4 地址。SG2002 参考固件的热点默认地址是 `192.168.88.1`。
3. 第一次预览选择 **HTTP · 8554**，再点 **Connect**。如果要使用 **UDP · 8555**，先关闭 Android 上的 UDP 预览。参考固件同一时间支持一个 UDP 视频接收端和一个 AI 事件订阅端。

Studio 可在直连的 IPv4 网段按接口掩码广播 `GET_CAPS`，支持有线链路本地地址。广播不可用时可直接填写 IP。界面根据 v1.2 的能力声明显示相机控制和 AI 功能，早期设备兼容旧版控制流程。

## 功能

| 功能 | 桌面端支持 |
| --- | --- |
| **实时取景** | H.264 HTTP / UDP 预览、自动重连、数字变焦和平移、镜像翻转、网格、直方图及水平参考线。 |
| **相机控制** | 按设备能力调节码率、GOP、白平衡、曝光、快门、ISO 上限和图像预设。 |
| **设备端 AI** | 选择相机模型，叠加检测框、关键点、分割结果和 CLIP 区域。 |
| **场景搜索** | 使用相机自带的 CLIP 词表。导入匹配的本地模型后，可同步中英文自定义搜索词。 |
| **拍摄与回看** | 单张、定时及连拍 JPEG、MP4 录像、AI 高光标记、片段裁剪和本地导出。 |

## 实测范围

| 平台或设备 | 已验证项目 |
| --- | --- |
| **macOS · Apple Silicon** | 打包应用配合模拟器验证了 720p30 HTTP / UDP 预览、UDP 恢复、拍摄、AI 事件、CLIP 词同步和高光裁剪。 |
| **KICKPI K12S-C · RV1126B** | Mac 有线真机验证了 v1.2 发现、1440p30 HTTP / UDP 预览、重连、设备声明的编码控制及录像。该固件未声明 AI 模型。 |
| **SG2002** | 已对照统一协议及 Android 参考实现检查。Studio 直连 SG2002 真机仍待验证。 |
| **Windows · x64 / Ubuntu · x64** | 已配置 GitHub Actions 原生构建，安装包的实际播放仍待验证。 |

## 从源码构建

安装 Node.js 24、`rustup`、[Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/) 和 FFmpeg。Rust 版本由仓库固定。

```sh
git clone https://github.com/tianrking/radian-studio.git
cd radian-studio
npm ci
npm run tauri -- build --bundles app
```

以上命令在 macOS 生成 `.app`。Windows 使用 `--bundles nsis`，Ubuntu 使用 `--bundles deb`。产物位于 `src-tauri/target/release/bundle/`。本地开发可运行 `npm run tauri -- dev`。[桌面构建记录](https://github.com/tianrking/radian-studio/actions/workflows/build.yml)

Studio 会在可执行文件旁、macOS 常用安装目录和 `PATH` 中查找 FFmpeg，也可通过 `RADIAN_FFMPEG` 指定绝对路径。预览依赖系统 WebView 的 H.264 Media Source Extensions 支持。自定义场景搜索需要另行导入获授权的匹配模型。[模型导入说明](README.md#custom-scene-search)

## 用模拟器试用

按[模拟器步骤](README.md#try-without-a-camera)生成测试视频并启动 Rust 模拟器。在 Studio 中连接 `127.0.0.1`。要查看合成检测框，可在 **On-device AI** 选择 **Full speed**。

## 架构与协议

桌面端使用 Tauri、React 和 Rust。Rust 管理发现、控制、媒体会话与文件保存。FFmpeg 直接把 MPEG-TS 中的 H.264 转封装为 fMP4，由系统 WebView 解码。设备通讯遵循 [Radian Device Protocol](https://github.com/tianrking/radian-protocol)，v1.2 联调使用 [`27e26f3`](https://github.com/tianrking/radian-protocol/tree/27e26f392ffd26627ac672d377aae107c27d487f)。[SG2002 固件](https://github.com/tianrking/radian-fw-sg2002)和 [OpenRadian Android](https://github.com/tianrking/radian-android)是参考实现。
