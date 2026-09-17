# 上架材料

- `sample/china-map-sample-2.3.2.0.pbix`：用户提供的测试报表，全国状态保存。内嵌2.3.2.0资源与打包版本完全一致。
- `evidence/`：真实 Desktop 原始截图，全国、省份、区县三个层级；未经裁切或缩放。原始尺寸不符合商店规格，不能直接上传。
- `screenshots/`：三张1366×768 PNG成品，每张不超过1024 KB，分别展示全国、黑龙江及哈尔滨区县。仅裁去报表外围界面并补白，不缩放或修改报表像素。来源、裁切范围及哈希记录在 `provenance.json`。

重新制作截图：安装 Pillow 后运行 `python scripts/prepare_screenshots.py`。脚本校验原始尺寸、成品尺寸、文件大小以及主体像素一致性。

实际测试范围见 `docs/HOST_VALIDATION.md`。PBIX 已存在不代表离线验证、Service 验证或地图授权已通过。源文件 `D:\下载\商店示例.pbix` 由用户自行另存；本轮只在其中执行地图交互并保存全国状态。
