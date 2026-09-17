# AppSource 上架文案草稿

- 名称：中国地图下钻 V2
- 版本：2.3.2.0
- 发布者：木小桼
- 定价：免费，不含应用内付费
- 支持邮箱：muxiaoqi@outlook.com
- 支持地址：https://github.com/muxiaoqi007/china-map-drilldown/issues
- 隐私政策：https://github.com/muxiaoqi007/china-map-drilldown/blob/main/docs/PRIVACY.md
- EULA：https://github.com/muxiaoqi007/china-map-drilldown/blob/main/docs/EULA.md

支持、隐私政策及 EULA 链接已在2026-09-17通过未登录 HTTP 200 检查。

## 简介

在 Power BI 中用中国地图展示销售额、数量等可加总指标，点击省份与城市逐级查看区域明细。

## 详细说明

支持全国、省内城市和市内区县地图，面包屑返回、渐变填色、标签、原生提示框和报表筛选联动。可按业务需求调整颜色、标签内容、图例与缩放设置。

多层级数值和附加指标按下级行求和，不支持任意 DAX 指标的上级重算。请勿将百分比、均价、利润率或跨区域去重计数作为可加总指标使用。报表页提示和钻取在具有准确单行身份的叶子层使用；上级聚合层显示视觉对象生成的原生提示。

全国和34个省级行政区地图内置。部分区县地图需要外网访问，受管理员权限及第三方服务可用性影响。本产品尚未取得 Power BI Certified 认证。

## 待制作材料

1. 商店 Logo 已准备：`assets/store/logo-300.png`（300×300 PNG）。
2. 1–5张1366×768 PNG真实使用截图，每张不超过1024 KB。
3. 离线可用的示例 PBIX；建议用内置地图演示全国、省份和直辖市区县，示例数据由 Power BI“输入数据”导入，避免外部数据源依赖。
4. 按 RELEASE_CHECKLIST.md 完成真实宿主测试后，在 Partner Center 创建免费 Power BI visual offer。
