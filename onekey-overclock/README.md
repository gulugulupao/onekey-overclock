# 一键超频 OneKey-OC

fnOS 应用中心应用：在**飞牛 OS（Amlogic A311D）** 上对 **A73 大核** 进行安全的**三档一键超频**管理，内置**自愈回滚**机制，加载后实时切换、杜绝变砖。

**中文 / English 双语说明。**

A fnOS App Center application: safely manage **A73 big-core** overclocking in three presets on **fnOS (Amlogic A311D)**, with a built-in **self-healing rollback** — switch live without multiple reboots, never brick.

---

## 简介 · Introduction

「一键超频」为飞牛 OS（Amlogic A311D 平台，如网心云 OES）提供一套三档大核频率管理器：

- 加载超频档位后，三档之间**实时切换、无需反复重启**；
- 实时读取当前 / 最大可调频率、电压（估算）、CPU 温度与调度策略；
- 内置满载烧机与实时温度 / 频率曲线，验证稳定性与是否降频；
- **自愈回滚**：任意未授权重启 / 宕机 / 断电后再开机，自动回落默认频率；
- 可选硬件看门狗作为"保险"，以及一键恢复出厂、导出诊断日志。

> 重要：本应用**不含任何超出零售三档的实验性超频**，也无法经由本应用触发任何未发布档位。

---

## 功能特性 · Features

| 中文 | English |
|---|---|
| **三档一键切换**（实时生效）| One-tap preset switching (live) |
| 乖巧 `2.2 GHz`（出厂 · 最稳）| Gentle `2.2 GHz`(default · stablest) |
| 野兽 `2.4 GHz`（加速 · 1.03V）| Beast `2.4 GHz`(accelerated · 1.03V) |
| 狂暴 `2.5 GHz`（满载峰值 · 1.04V）| Beast+ `2.5 GHz`(peak · 1.04V) |
| 实时读数（频率 / 电压 / 温度 / 策略）| Live readouts (freq / voltage / temp / policy) |
| 动态生成超频 DTB（dtc + fdtoverlay，原子写入）| Dynamically generated overclock DTB (atomic write) |
| **自愈回滚**（未授权重启 / 宕机 / 断电自动回落）| Self-healing rollback (auto-revert after any unauthorized reset) |
| 频率跨重启持久化 | Persistent frequency across reboots |
| 满载烧机 + 温度/频率曲线 | Burn-in stress test + temp/freq curve |
| 硬件看门狗（可选，默认 OFF）| Hardware watchdog (optional, OFF by default) |
| 一键恢复出厂 + 导出近 7 天日志（zip）| One-tap factory reset + export 7-day logs (zip) |

---

## 系统要求 · System Requirements

- 平台：`arm`，Amlogic A311D（`meson-g12b-a311d-oes`，如网心云 OES）
- 需要：`dtc` / `fdtoverlay` / `fdtget`、root 权限
- OS：fnOS `>= 0.9.25`
- 运行后端（二选一，见下）：
  - **node 运行时版**：自带 aarch64 node 运行时；
  - **Python 精简版**：复用宿主系统 Python3 标准库（推荐，约 0.3MB）。

---

## 安装 · Installation

在飞牛 OS 应用中心的 "上传应用包" 中选择其中一个 fpk 安装即可。两个包功能完全一致，仅后端运行方式不同：

| 安装包 | 体积 | 后端 | 适用 | English |
|---|---|---|---|---|
| `一键超频_v1.0.0_node.fpk` | 约 51MB | 内置 aarch64 node | 兼容性最可控 | Bundled node runtime |
| `一键超频_v1.0.0_lite.fpk` | 约 0.3MB | 宿主 Python3 (推荐) | 轻量、无捆绑 | Host Python3 (recommended) |

安装完成后进入应用，切换至「野兽 / 狂暴」档**首次会触发一次自动重启**以加载超频 DTB；此后三档实时切换、无需再重启。

卸载回调会完整移除三个 systemd 单元、根分区脚本与看门狗持久配置，不留残留。

---

## 重点机制 · Key Mechanisms

- **自愈回滚（Self-healing rollback）**：任意未授权重启、宕机或断电后再开机，自动回落默认频率，是超频场景下最重要的安全网。硬件看门狗为可选补充，非强制。
- **供电提醒**：插满 3 块机械盘且同时高速读写、或组建 RAID 0/1/5 时，总功耗可能逼近 36W（12V/3A）电源上限，易致掉压不稳，建议降至「野兽」档或改用 SSD。

---

## 目录结构 · Directory Layout

```
onekey-overclock
├── manifest            # fnOS 应用清单（版本 / 描述 / 更新日志）
├── cmd/                # 生命周期 main + install / upgrade / uninstall 回调
├── config/
│   ├── privilege       # run-as root
│   ├── resource        # 数据目录权限
│   └── systemd/        # oc-health / oc-reboot / oc-cap 单元模板
├── app/
│   ├── bin/            # 档位应用 / 上限 / 自愈 / 回滚 / 看门狗 shell 脚本
│   ├── runtime/        # aarch64 node 运行时（第三方，不入 Git 仓库）
│   ├── web/            # server.js / server.py 后端 + public 前端
│   └── ui/             # fnOS 桌面图标 / 端口注册
├── README.md
└── LICENSE.txt
```

---

## 构建与部署 · Build & Deploy

源码根为 `one_oc_build/`，一次构建生成两个版本：

```bash
python one_oc_build/build_both.py
```

产物输出到 `一键超频_releases/`：

- `一键超频_v1.0.0_node.fpk`（内置 node 运行时，体积较大）
- `一键超频_v1.0.0_lite.fpk`（复用宿主 Python3，精简）

> 说明：`app/runtime/` 下的 aarch64 node 为第三方二进制（体积大），**有意不入 Git 仓库**。克隆后如需构建 node 版，请自行准备并在构建前放置到该目录；Python 精简版不依赖任何运行时，可直接构建。

---

## 版本历史 · Changelog

- **v1.0.0**：首个正式公开发布版。三档一键超频（2.2G / 2.4G / 2.5G）+ 加载后实时切换 + 自愈回滚 + 烧机曲线 + 可选看门狗 + 一键恢复出厂 + 日志导出；同步提供 node 运行时版与 Python 精简版两种安装包。
  English: First public release. Three-preset overclocking + live switching + self-healing rollback + burn-in curve + optional watchdog + factory reset + log export; shipped as both node-runtime and Python-lite packages.

---

## 许可证 · License

本仓库源码采用 **MIT License + 附加保护条款**（禁止商用、保留署名等），详见 [LICENSE.txt](./LICENSE.txt)。

---

## 免责声明 · Disclaimer

- 本应用会改写系统 `/boot` 与 `/etc/systemd` 等底层配置以调整频率与电压。**超频存在导致系统不稳定、频繁重启、数据异常，极端情况下无法启动（变砖）的风险。** 安装使用即视为已知悉并自行承担全部后果。
- 本应用为社区工具，与飞牛（fnOS）官方及任何硬件厂商无关，不提供任何明示或默示担保。
- 设备具体表现因固件与硬件环境而异，请以实际测试为准；如遇不兼容请及时卸载恢复。
- 请勿将本应用用于数据重要性超过其可承受范围的场景；关键数据请始终保留独立备份。

---

作者 · Author：很多问题的小明同学（GitHub [@gulugulupao](https://github.com/gulugulupao)）

微信搜一搜「**很多问题的小明同学**」。