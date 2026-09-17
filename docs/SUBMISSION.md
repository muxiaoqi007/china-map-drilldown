# 2.3.2.0 商店提交准备

更新日期：2026-09-17。发布者：木小桼；支持：muxiaoqi@outlook.com；免费，无应用内付费。

## 当前交付

| 材料 | 位置 / 状态 |
| --- | --- |
| 视觉对象安装包 | `dist/chinaMapDrilldownV2F4A1C8D973E64B5AA27D1E6C80B42951.2.3.2.0.pbiviz` |
| 商店 Logo | `assets/store/logo-300.png`，300×300 PNG，保留原图透明背景 |
| 商店文案 | [STORE_LISTING.md](STORE_LISTING.md) |
| 隐私政策 / EULA | [PRIVACY.md](PRIVACY.md) / [EULA.md](EULA.md)，已公开 |
| 离线示例数据 | [sample-data.m](sample-data.m)，在空白查询中直接粘贴；另附 CSV |
| 示例 PBIX | 已提供：`store/sample/china-map-sample-2.3.2.0.pbix`；与提交视觉对象逐字节一致，离线验证待完成 |
| 截图 | `store/screenshots/` 已有全国、黑龙江、哈尔滨区县三张1366×768 PNG，每张小于1024 KB；保留原图与处理记录 |
| 地图来源 / 授权 | [map-data-inventory.csv](map-data-inventory.csv) 记录35份本地地图及哈希，原始来源和再分发授权待核实 |
| 软件许可 | 打包脚本从锁定的已安装运行依赖中收集 LICENSE / NOTICE，写入附件 `third-party/` |
| 验证记录 | [VALIDATION.md](VALIDATION.md)；[HOST_VALIDATION.md](HOST_VALIDATION.md) 已记录用户样例的黑龙江/哈尔滨/尚志市 Desktop 实测 |

审核测试说明见 [REVIEWER_NOTES.md](REVIEWER_NOTES.md)，后台填写资料见 [PARTNER_CENTER_FIELDS.md](PARTNER_CENTER_FIELDS.md)。用户确认示例中的数据为测试数据，文件可用于上架准备。PBIX 已清除残留地图筛选并保存全国状态。

## 重新制作附件包

在仓库根目录执行：

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run audit:security
npm run package
python scripts/prepare_store.py
```

Python 3.9+，仅使用标准库。附件包输出到 `dist/appsource-2.3.2.0-preparation.zip`，包含安装包、文档、Logo、独立文本 EULA、软件许可和 `manifest.json`（逐文件 SHA-256）。脚本校验安装包内外版本、GUID、作者信息和 Logo 尺寸；状态文件始终明确当前为准备包。此 ZIP 用于交接整理，不能替代 Partner Center 要求的单独 `.pbiviz` 与 `.pbix` 文件。

## 剩余执行顺序

1. 核实地图原始来源、版本、使用及再分发授权，保存证据并填写地图清单；候选 URL 和能够下载不构成许可证明。
2. 用嵌入式示例数据制作 PBIX，完成 Desktop / Service 联动验收，特别记录省份、城市和区县的切换、取消和返回路径。
3. 断网打开示例 PBIX；演示仅使用内置的全国、省内城市和北京区县地图。
4. 截取1–5张1366×768 PNG，每张不超过1024 KB；截图应体现真实使用结果。
5. 完成 Partner Center 发布者资料，创建 Power BI visual offer，使用 STORE_LISTING.md 内容及公开链接。上传安装包、PBIX、Logo、截图和 EULA；本轮不勾选认证请求。
6. 完成预览和最终校验后再提交审核。当前尚未提交、未通过审核、未获认证。

## 官方要求核对

2026-09-17读取下列 Microsoft Learn 页面，确认安装包元数据、离线示例 PBIX、300×300 PNG Logo、1–5张1366×768 PNG截图（每张≤1024 KB）、HTTPS支持与隐私链接，以及 EULA 要求。

- https://learn.microsoft.com/en-us/power-bi/developer/visuals/office-store
- https://learn.microsoft.com/en-us/partner-center/marketplace-offers/power-bi-visual-offer-listing

上架普通视觉对象与 Power BI Certified 认证分别处理；代码打包成功不代表通过商店审核。
