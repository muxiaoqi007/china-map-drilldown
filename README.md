# ChinaMapDrilldown - 中国地图层级下钻 Power BI 自定义视觉

基于 ECharts 的 Power BI 自定义视觉对象，实现中国地图省→市→区三级 Choropleth 填充地图下钻。

## 功能特性

- 三级层级下钻：省份 → 城市 → 区县
- 内部点击下钻（无需依赖 Power BI 内置下钻功能）
- 面包屑导航返回上级
- 自定义工具提示字段
- 南海诸岛显示模式切换（完整显示 / 小图显示）
- 颜色渐变图例条
- 标签显示控制
- 缩放和平移支持

## 技术栈

- Power BI Custom Visuals SDK (pbiviz v5.5.1, API v5.3.0)
- ECharts 地图组件
- TypeScript
- 数据源：阿里云 DataV.GeoAtlas

## 开发

```bash
# 安装依赖
npm install

# 开发模式（启动本地调试服务器）
npx pbiviz start

# 打包
npx pbiviz package
```

打包后的 `.pbiviz` 文件位于 `dist/` 目录，可导入 Power BI Desktop 使用。

## 数据角色

| 数据角色 | 说明 | 最大数量 |
|---------|------|---------|
| province | 省份字段 | 1 |
| city | 城市字段 | 1 |
| district | 区县字段 | 1 |
| measure | 度量值 | 1 |
| tooltips | 工具提示字段 | 5 |

## 使用说明

1. 将省份、城市字段拖入对应数据角色
2. 将度量值（如销售额）拖入 measure 角色
3. 点击省份可下钻查看城市数据
4. 面包屑导航可返回全国视图
5. 在格式面板中可自定义地图样式和南海诸岛显示方式
