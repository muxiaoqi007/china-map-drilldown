# 第三方软件与地图数据

- Apache ECharts：Apache-2.0；发布时应保留包内许可及 NOTICE。
- Power BI 开发工具及格式工具：以锁定版本各 npm 包中的 LICENSE 为准。
- `src/assets/*.json`：来源包括阿里云 DataV.GeoAtlas 和 GeoJSON.CN。现有仓库未提供逐文件下载日期、版本、授权证明；不能据此断言已获商店再分发许可。

发布前必须补齐地图数据的使用及再分发授权证据、来源链接、获取日期，并核对边界版本及展示要求。项目 MIT 许可不代表地图数据也按 MIT 授权。这项检查尚未完成，不应将本文件视为授权证明。

## 2.3.2.0 资料整理

`map-data-inventory.csv` 已逐一记录35份本地地图的路径、大小、SHA-256、要素数量及从数据属性推断的父级行政区代码。候选 DataV 地址由该代码构造，只供追查来源；未验证下载内容一致性，原始获取日期未知，再分发许可仍待证据。

`python scripts/prepare_store.py` 按 package-lock.json 收集当前安装的非开发、非可选依赖根目录 LICENSE / NOTICE / COPYING，以及 licenses 子目录，随交接包保留原文。附件 `third-party/index.json` 记录包名、锁定版本和许可标识。该收集覆盖 ECharts、zrender、tslib、Power BI 工具包及其已安装运行依赖，不代表地图授权已解决，也不替代最终发行产物的许可复核。
