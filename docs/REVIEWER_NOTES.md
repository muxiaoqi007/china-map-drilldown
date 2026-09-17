# 审核人员测试说明 / Reviewer notes

版本：2.3.2.0。发布者：木小桼。联系：muxiaoqi@outlook.com。免费，无付费功能、许可密钥或产品登录要求。

## 提交文件

- 安装包：`chinaMapDrilldownV2F4A1C8D973E64B5AA27D1E6C80B42951.2.3.2.0.pbiviz`
- 示例：`sample/china-map-sample-2.3.2.0.pbix`，由发布者提供并确认其中数据为测试数据。
- 示例内嵌的视觉对象资源已与提交安装包逐字节比较，一致。

## 使用方法

在 Power BI Desktop 中打开示例。右侧为地图，左侧为原生明细表。全国状态下明细表销售额总计为 26,282,791。地图绑定省份、城市、区县和销售额；仅支持可加总的指标。

点击黑龙江省，明细表合计应为 1,034,219；再点击哈尔滨市，应为 155,991；点击尚志市，应只显示该地区，合计 14,620。再次点击尚志市，应恢复哈尔滨市明细。点击面包屑黑龙江省、全国，应依次恢复省级和全国数据。

工具提示显示区域及指标，不显示“汇总方式”。可在格式设置中调整地图标签、颜色和图例。

全国和省级地图内置；部分城市区县地图通过 HTTPS 访问 `geo.datav.aliyun.com` 或 `geojson.cn`。普通 AppSource 上架不等于 Power BI Certified；本次不申请认证。

## 已执行与尚未执行

2026-09-17 在 Desktop 实际执行并通过上述黑龙江 → 哈尔滨 → 尚志市 → 重复点击取消 → 返回省份 → 返回全国路径。最终保存于全国状态，没有残留的地图 `general.filter`。

尚未完成：省份单字段和省市两字段实际宿主测试、其他区县切换、Power BI Service、断网重开和数据刷新验证。示例包含 DataModel，不据此宣称刷新不依赖外部源。

## English testing notes

This is a free visual with no paid features or product sign-in. Open the supplied PBIX in Power BI Desktop. The sample contains publisher-provided test data. The map interacts with a native detail table.

Test China → Heilongjiang → Harbin → Shangzhi. Expected sales totals are 26,282,791 → 1,034,219 → 155,991 → 14,620. Click Shangzhi again to restore Harbin, then use the breadcrumbs to return to the province and China. This route was verified in Desktop on September 17, 2026. Service and offline validation remain pending.

Use additive measures only. Some district maps require internet access. This submission does not request Power BI certification.
