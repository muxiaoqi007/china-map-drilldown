/**
 * Power BI 中国地图层级下钻视觉
 * 基于 ECharts 实现省→市→区三级 Choropleth 填充地图
 */

"use strict";

import powerbi from "powerbi-visuals-api";
import * as echarts from "echarts";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { MapDataService, DrillState, DataPoint } from "./mapDataService";
import { VisualFormattingSettingsModel } from "./settings";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import DataView = powerbi.DataView;
import DataViewCategoryColumn = powerbi.DataViewCategoryColumn;

/** 格式化配置提取接口 */
interface MapFormatConfig {
    minColor: string;
    maxColor: string;
    bgColor: string;
    borderColor: string;
    labelShow: boolean;
    labelFontSize: number;
    labelFontColor: string;
    labelShowValue: boolean;
    tooltipShow: boolean;
    roam: boolean;
    showLegend: boolean;
    showBreadcrumb: boolean;
    showSouthChinaSea: boolean;
    southChinaSeaMode: string;
    minValue: number;
    maxValue: number;
}

export class Visual implements IVisual {
    /* ───── DOM 元素 ───── */
    private target: HTMLElement;
    private chartContainer: HTMLElement;
    private chartElement: HTMLElement;
    private breadcrumbElement: HTMLElement;

    /* ───── 核心服务 ───── */
    private host: IVisualHost;
    private chart: echarts.ECharts | null = null;
    private selectionManager: ISelectionManager;
    private formattingSettingsService: FormattingSettingsService;
    private formattingSettings: VisualFormattingSettingsModel;
    private mapDataService: MapDataService;

    /* ───── 状态管理 ───── */
    private currentAdcode: string = MapDataService.CHINA_ADCODE;
    private currentMapName: string = "china";
    private registeredMaps: Set<string> = new Set();
    private currentDataPoints: DataPoint[] = [];
    private level1DataPoints: DataPoint[] = [];
    private previousDataKey: string = "";
    private lastRenderedLevel: number = 0;
    private lastUpdateOptions: VisualUpdateOptions | null = null;

    /* ───── 原始数据缓存（用于内部下钻）───── */
    private rawCatColumns: DataViewCategoryColumn[] = [];
    private rawCatNames: string[][] = [];   // rawCatNames[catIdx][rowIdx]
    private rawMeasureValues: number[] = [];

    /* ───── 工具提示数据 ───── */
    private tooltipColumns: Array<{ displayName: string; values: string[] }> = [];

    /* ───── 南海诸岛特征（供小图使用）───── */
    private scsInsetFeatures: any[] = [];

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.target = options.element;

        // 初始化选择管理器
        this.selectionManager = this.host.createSelectionManager();

        // 初始化格式设置服务
        this.formattingSettingsService = new FormattingSettingsService();

        // 初始化地图数据服务
        this.mapDataService = new MapDataService();

        // 构建 DOM 结构
        this.chartContainer = document.createElement("div");
        this.chartContainer.className = "china-map-container";

        this.breadcrumbElement = document.createElement("div");
        this.breadcrumbElement.className = "map-breadcrumb";
        this.breadcrumbElement.style.display = "none";

        this.chartElement = document.createElement("div");
        this.chartElement.className = "china-map-chart";

        this.chartContainer.appendChild(this.breadcrumbElement);
        this.chartContainer.appendChild(this.chartElement);
        this.target.appendChild(this.chartContainer);

        // 初始化 ECharts 实例
        this.chart = echarts.init(this.chartElement);

        // 注册窗口 resize 事件
        window.addEventListener("resize", this.handleResize);
    }

    /* ═══════════════════════════════════════
     *  公共方法
     * ═══════════════════════════════════════ */

    public update(options: VisualUpdateOptions): void {
        try {
            // 保存 options 引用供面包屑返回时使用
            this.lastUpdateOptions = options;

            const dataView = options.dataViews?.[0];
            if (!dataView) {
                return;
            }

            this.formattingSettings = this.formattingSettingsService
                .populateFormattingSettingsModel(VisualFormattingSettingsModel, dataView);

            if (options.type & powerbi.VisualUpdateType.Resize
                || options.type & powerbi.VisualUpdateType.ResizeEnd) {
                this.chart?.resize();
                return;
            }

            const parsedData = this.parseDataView(dataView);
            if (!parsedData || parsedData.dataPoints.length === 0) {
                this.showOverlay("请将省份字段拖入数据角色以开始");
                return;
            }

            // ── 核心：用数据指纹检测数据结构是否发生变化 ──
            const dataKey = `${parsedData.level}|${parsedData.dataPoints.length}|${parsedData.parentName}`;
            console.log("[ChinaMap] update: dataKey=", dataKey,
                "prevKey=", this.previousDataKey,
                "lastLevel=", this.lastRenderedLevel);
            if (dataKey !== this.previousDataKey) {
                if (parsedData.level <= 1 && this.lastRenderedLevel >= 2) {
                    this.currentAdcode = MapDataService.CHINA_ADCODE;
                    const resetFmt = this.getFormatConfig();
                    this.currentMapName = resetFmt.southChinaSeaMode === "inset" ? "china_no_scs" : "china";
                    this.selectionManager.clear();
                }
                this.previousDataKey = dataKey;
            }

            this.lastRenderedLevel = parsedData.level;
            this.renderMap(parsedData);
        } catch (error) {
            console.error("[ChinaMap] update 错误:", error);
            this.showOverlay(`渲染出错: ${error.message || error}`, true);
        }
    }

    public destroy(): void {
        window.removeEventListener("resize", this.handleResize);
        this.chart?.dispose();
        this.chart = null;
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }

    /* ═══════════════════════════════════════
     *  数据解析
     * ═══════════════════════════════════════ */

    /**
     * 解析 Power BI DataView 为地图数据
     * 核心原则：始终按第一分类列聚合，仅在 Power BI 下钻到单一父级时渲染子级
     */
    private parseDataView(dataView: DataView): DrillState | null {
        const categorical = dataView.categorical;
        if (!categorical?.categories?.length || !categorical.values?.length) {
            console.log("[ChinaMap] ⚠ 无数据: cats=", !!categorical?.categories,
                "vals=", !!categorical?.values);
            return null;
        }

        const categories = categorical.categories;
        const values = categorical.values as any;
        const primaryCat = categories[0] as DataViewCategoryColumn;
        const rowCount = primaryCat.values.length;
        const primaryNames: string[] = [];
        for (let i = 0; i < rowCount; i++) {
            primaryNames.push(String(primaryCat.values[i] ?? ""));
        }

        // ── 检测数据结构 ──
        const firstVal = values[0];
        const isGrouped = firstVal && !firstVal.source && Array.isArray(firstVal?.values);

        // ── 缓存原始数据（用于内部下钻）──
        this.rawCatColumns = [];
        this.rawCatNames = [];
        for (let ci = 0; ci < categories.length; ci++) {
            const cat = categories[ci] as DataViewCategoryColumn;
            this.rawCatColumns.push(cat);
            const names: string[] = [];
            for (let i = 0; i < cat.values.length; i++) {
                names.push(String(cat.values[i] ?? ""));
            }
            this.rawCatNames.push(names);
        }

        // ── 提取度量值（平坦 or 分组）──
        let flatValues: number[];

        if (isGrouped) {
            // 分组数据：聚合每组度量值
            flatValues = new Array(rowCount).fill(0);
            for (const group of values) {
                // 尝试通过 identityFrom.map 映射
                if (group?.identityFrom?.map) {
                    const idxMap: number[] = group.identityFrom.map;
                    const innerVals = group?.values?.[0]?.values;
                    if (innerVals) {
                        for (let j = 0; j < innerVals.length; j++) {
                            const idx = idxMap[j];
                            if (idx != null && idx < rowCount) {
                                flatValues[idx] += Number(innerVals[j] ?? 0);
                            }
                        }
                    }
                    continue;
                }
                // 回退：直接按索引累加
                const innerArr = group?.values;
                if (Array.isArray(innerArr)) {
                    for (const inner of innerArr) {
                        const iv = inner?.values;
                        if (Array.isArray(iv)) {
                            for (let i = 0; i < Math.min(iv.length, rowCount); i++) {
                                flatValues[i] += Number(iv[i] ?? 0);
                            }
                        }
                    }
                }
            }
        } else {
            // 平坦数据：直接从 values[0].values 读取
            const rawVals = values[0]?.values;
            if (!rawVals) {
                return null;
            }
            flatValues = [];
            for (let i = 0; i < rawVals.length; i++) {
                flatValues.push(Number(rawVals[i] ?? 0));
            }
        }

        // ── 缓存原始度量值 ──
        this.rawMeasureValues = flatValues.slice();

        // ── 提取工具提示列（values[1], values[2], ...）──
        this.tooltipColumns = [];
        for (let vi = 1; vi < values.length; vi++) {
            const valCol = values[vi];
            let displayName = "";
            let colValues: any[] = [];

            if (valCol?.source) {
                // 平坦模式：直接读取
                displayName = valCol.source.displayName || "";
                colValues = valCol.values || [];
            } else if (valCol?.values?.[0]?.source) {
                // 分组模式：从内层读取
                displayName = valCol.values[0].source.displayName || "";
                colValues = valCol.values[0].values || [];
            }

            if (displayName) {
                const strValues: string[] = [];
                for (let i = 0; i < colValues.length; i++) {
                    strValues.push(String(colValues[i] ?? ""));
                }
                this.tooltipColumns.push({ displayName, values: strValues });
            }
        }

        // ── 检测下钻层级 ──
        const uniqueProvinceCount = new Set(primaryNames).size;

        // 情况1: 有城市列，且省份只有1个唯一值 → Power BI 下钻到了某省的城市级别
        if (categories.length >= 2 && uniqueProvinceCount === 1) {
            const subCat = categories[1] as DataViewCategoryColumn;
            const subNames: string[] = [];
            for (let i = 0; i < subCat.values.length; i++) {
                subNames.push(String(subCat.values[i] ?? ""));
            }
            const parentProvince = primaryNames[0];
            console.log("[ChinaMap] → 城市下钻: parent=", parentProvince, "cities=", subNames.length);

            // 如果有区县列且城市有重复，进一步聚合到城市级别
            if (categories.length >= 3) {
                const uniqueCityCount = new Set(subNames).size;
                if (uniqueCityCount < subNames.length) {
                    const agg = this.aggregateByPrimaryCategory(subNames, flatValues, subCat);
                    const ttData = this.buildTooltipData(agg.firstIndices);
                    const result = this.buildDrillState(2, parentProvince, agg.category, agg.values, ttData);
                    return result;
                }
            }

            const rowIndices = Array.from({ length: subCat.values.length }, (_, i) => i);
            const ttData = this.buildTooltipData(rowIndices);
            const result = this.buildDrillState(2, parentProvince, subCat, flatValues, ttData);
            return result;
        }

        // 情况2: 有城市列，省份有多个唯一值 → 按省份聚合显示全国地图
        if (categories.length >= 2 && uniqueProvinceCount < rowCount) {
            console.log("[ChinaMap] → 多列聚合模式: uniqueCount=", uniqueProvinceCount, "rowCount=", rowCount);
            const agg = this.aggregateByPrimaryCategory(primaryNames, flatValues, primaryCat);
            const ttData = this.buildTooltipData(agg.firstIndices);
            const result = this.buildDrillState(1, "", agg.category, agg.values, ttData);
            return result;
        }

        // 情况3: 单列模式（只有省份），直接使用
        console.log("[ChinaMap] → 直接使用: rowCount=", rowCount);
        const rowIndices = Array.from({ length: rowCount }, (_, i) => i);
        const ttData = this.buildTooltipData(rowIndices);
        const result = this.buildDrillState(1, "", primaryCat, flatValues, ttData);
        return result;
    }

    /**
     * 按主分类列聚合数据（多个城市→省份汇总）
     * 返回去重后的分类列、聚合后的度量值和原始行索引
     */
    private aggregateByPrimaryCategory(
        names: string[],
        values: number[],
        category: DataViewCategoryColumn
    ): { category: DataViewCategoryColumn; values: number[]; firstIndices: number[] } {
        const seen = new Map<string, { total: number; firstIdx: number }>();
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            const existing = seen.get(name);
            if (existing) {
                existing.total += (values[i] ?? 0);
            } else {
                seen.set(name, { total: values[i] ?? 0, firstIdx: i });
            }
        }

        // 构建去重后的伪分类列
        const uniqueNames: string[] = [];
        const uniqueIndices: number[] = [];
        seen.forEach((info, name) => {
            uniqueNames.push(name);
            uniqueIndices.push(info.firstIdx);
        });

        const aggValues: number[] = [];
        seen.forEach((info) => aggValues.push(info.total));

        const pseudoCategory = {
            values: uniqueNames,
            source: category.source,
            identity: uniqueIndices.map((idx) => category.identity?.[idx])
        } as DataViewCategoryColumn;

        console.log("[ChinaMap] 聚合:", uniqueNames.length, "个唯一值, 原始行数:", names.length);
        return { category: pseudoCategory, values: aggValues, firstIndices: uniqueIndices };
    }

    /** 构建 DrillState 结果对象 */
    private buildDrillState(
        level: number,
        primaryName: string,
        category: DataViewCategoryColumn,
        measureValues: number[],
        tooltipData?: Array<Array<{ displayName: string; value: string }>>
    ): DrillState {
        const dataPoints: DataPoint[] = [];
        let minValue = Infinity;
        let maxValue = -Infinity;

        for (let i = 0; i < category.values.length; i++) {
            const name = String(category.values[i] ?? "");
            const value = measureValues[i] ?? 0;
            if (isNaN(value)) continue;

            const selectionId = this.host.createSelectionIdBuilder()
                .withCategory(category, i)
                .createSelectionId();

            const dp: DataPoint = { name, value, selectionId };
            if (tooltipData && i < tooltipData.length) {
                dp.tooltips = tooltipData[i];
            }
            dataPoints.push(dp);
            minValue = Math.min(minValue, value);
            maxValue = Math.max(maxValue, value);
        }

        if (minValue === maxValue && dataPoints.length > 1) {
            minValue = maxValue > 0 ? 0 : maxValue - 1;
            maxValue = maxValue > 0 ? maxValue * 1.1 : 1;
        }

        const parentName = level >= 2 ? primaryName : "";

        console.log("[ChinaMap] buildDrillState: level=", level, "parent=", parentName,
            "points=", dataPoints.length, "range=[", minValue, ",", maxValue, "]");

        return {
            level,
            parentName,
            parentAdcode: MapDataService.CHINA_ADCODE,
            mapName: this.getMapName(level, parentName),
            dataPoints,
            minValue,
            maxValue
        };
    }

    /**
     * 为数据点构建工具提示数据
     * @param rowIndices 每个数据点对应的原始行索引
     */
    private buildTooltipData(rowIndices: number[]): Array<Array<{ displayName: string; value: string }>> {
        if (this.tooltipColumns.length === 0) return [];
        return rowIndices.map((rowIdx) =>
            this.tooltipColumns
                .filter((col) => rowIdx < col.values.length)
                .map((col) => ({ displayName: col.displayName, value: col.values[rowIdx] }))
        );
    }

    /** 从聚合结果构建带工具提示的数据 */
    private buildTooltipDataFromAgg(
        aggResult: { category: DataViewCategoryColumn; values: number[]; firstIndices?: number[] }
    ): Array<Array<{ displayName: string; value: string }>> {
        if (!aggResult.firstIndices || this.tooltipColumns.length === 0) return [];
        return this.buildTooltipData(aggResult.firstIndices);
    }

    /* ═══════════════════════════════════════
     *  地图渲染
     * ═══════════════════════════════════════ */

    private async renderMap(drillState: DrillState): Promise<void> {
        if (!this.chart) return;

        console.log("[ChinaMap] renderMap: level=", drillState.level,
            "parentName=", drillState.parentName,
            "dataPoints=", drillState.dataPoints.length,
            "first3names=", drillState.dataPoints.slice(0, 3).map((dp) => dp.name));

        // ── 根据数据自动决定加载哪个 GeoJSON ──
        let targetAdcode: string;
        if (drillState.level <= 1) {
            targetAdcode = MapDataService.CHINA_ADCODE;
        } else {
            // 从数据中获取父级省份名，查找其 adcode
            let adcode = this.findRegionAdcode(drillState.parentName);
            if (!adcode) {
                // 尝试从全国地图查找（确保全国地图已加载）
                if (!this.registeredMaps.has(MapDataService.CHINA_ADCODE)) {
                    try {
                        const chinaGeo = await this.mapDataService.getGeoJSON(MapDataService.CHINA_ADCODE);
                        echarts.registerMap("china", chinaGeo);
                        this.registeredMaps.add(MapDataService.CHINA_ADCODE);
                    } catch (e) { /* ignore */ }
                }
                adcode = this.findRegionAdcodeFromMap(drillState.parentName, "china");
            }
            targetAdcode = adcode || MapDataService.CHINA_ADCODE;
        }

        // 如果目标 adcode 变化，加载新的 GeoJSON
        const fmt = this.getFormatConfig();
        const useInset = fmt.southChinaSeaMode === "inset" && targetAdcode === MapDataService.CHINA_ADCODE;
        const mapName = targetAdcode === MapDataService.CHINA_ADCODE
            ? (useInset ? "china_no_scs" : "china")
            : `map_${targetAdcode}`;
        const cacheKey = targetAdcode + (useInset ? "_no_scs" : "");
        const needsReload = this.currentMapName !== mapName
            || !this.registeredMaps.has(cacheKey);

        if (needsReload) {
            this.showLoading();
            try {
                let geoJson = await this.mapDataService.getGeoJSON(targetAdcode);

                // 南海诸岛过滤（仅对小图模式下的全国地图生效）
                if (useInset) {
                    const scsResult = MapDataService.filterSouthChinaSea(geoJson);
                    geoJson = scsResult.cleanedGeoJson;
                    this.scsInsetFeatures = scsResult.scsFeatures;
                    // inset 模式总是重新注册，确保使用过滤后的 GeoJSON
                    echarts.registerMap(mapName, geoJson);
                    this.registeredMaps.add(cacheKey);
                } else {
                    // 完整模式：清除小图特征，确保不渲染南海小图
                    this.scsInsetFeatures = [];
                    if (!this.registeredMaps.has(cacheKey)) {
                        echarts.registerMap(mapName, geoJson);
                        this.registeredMaps.add(cacheKey);
                    }
                }

                this.currentAdcode = targetAdcode;
                this.currentMapName = mapName;
            } catch (error) {
                this.showOverlay(`加载地图数据失败: ${error.message}`, true);
                return;
            }
        }

        this.currentDataPoints = drillState.dataPoints;
        if (drillState.level <= 1) {
            this.level1DataPoints = drillState.dataPoints;
        }
        this.hideOverlay();

        const option = this.buildEChartsOption(drillState);
        this.chart.setOption(option, true);
        this.bindChartEvents();
        this.updateBreadcrumb(drillState);
    }

    /**
     * 构建完整的 ECharts 配置
     */
    private buildEChartsOption(state: DrillState): echarts.EChartsOption {
        const fmt = this.getFormatConfig();

        // 准备地图数据（带名称匹配）
        const mapData = this.buildMapData(state.dataPoints);

        const seriesOption: any = {
            name: this.getLevelLabel(state.level),
            type: "map",
            map: this.currentMapName,
            roam: fmt.roam,
            selectedMode: false,
            itemStyle: {
                areaColor: fmt.bgColor,
                borderColor: fmt.borderColor,
                borderWidth: 1
            },
            emphasis: {
                label: {
                    show: true,
                    color: "#333",
                    fontWeight: "bold"
                },
                itemStyle: {
                    areaColor: "#bde0fe"
                }
            },
            select: {
                label: { show: true },
                itemStyle: {
                    areaColor: "#ffc300"
                }
            },
            label: {
                show: fmt.labelShow,
                fontSize: fmt.labelFontSize,
                color: fmt.labelFontColor,
                formatter: (params: any) => {
                    if (fmt.labelShowValue && params.value != null) {
                        return `${params.name}\n${this.formatNumber(params.value)}`;
                    }
                    return params.name;
                }
            },
            data: mapData
        };

        const option: any = {
            tooltip: {
                show: fmt.tooltipShow,
                trigger: "item",
                formatter: (params: any) => {
                    const lines: string[] = [];
                    lines.push(`<b>${params.name}</b>`);
                    if (params.value != null && !isNaN(params.value)) {
                        lines.push(`${this.getMeasureName()}: ${this.formatNumber(params.value)}`);
                    }
                    // 查找数据点的工具提示字段
                    const dpIdx = params.data?._index;
                    if (dpIdx != null && dpIdx < state.dataPoints.length) {
                        const dp = state.dataPoints[dpIdx];
                        if (dp.tooltips) {
                            for (const tt of dp.tooltips) {
                                if (tt.value && tt.value !== "undefined" && tt.value !== "null") {
                                    lines.push(`${tt.displayName}: ${tt.value}`);
                                }
                            }
                        }
                    }
                    if (lines.length === 1 && (params.value == null || isNaN(params.value))) {
                        return `<b>${params.name}</b><br/>暂无数据`;
                    }
                    return lines.join("<br/>");
                }
            },
            series: [seriesOption]
        };

        // 图例条（visualMap）
        if (fmt.showLegend) {
            const vMin = fmt.minValue || state.minValue;
            const vMax = fmt.maxValue || state.maxValue;

            option.visualMap = {
                type: "continuous",
                min: vMin,
                max: vMax,
                left: "left",
                bottom: 20,
                formatter: (value: number) => this.formatNumber(value),
                inRange: {
                    color: [fmt.minColor, fmt.maxColor]
                },
                calculable: true,
                orient: "vertical",
                itemWidth: 15,
                itemHeight: 120
            };
        }

        // 下钻时显示返回标题
        if (state.level > 1 && state.parentName) {
            option.title = {
                text: `${state.parentName}`,
                left: "center",
                top: 5,
                textStyle: {
                    fontSize: 15,
                    fontWeight: "bold",
                    color: "#333"
                }
            };
        }

        // 南海诸岛小图模式
        const fmtCheck = this.getFormatConfig();
        if (fmtCheck.southChinaSeaMode === "inset" && state.level <= 1) {
            this.addSouthChinaSeaInset(option);
        } else {
            // 完整模式下清除 geo 组件，避免残留
            option.geo = null;
        }

        return option;
    }

    /**
     * 添加南海诸岛小图（inset 模式）
     * 在右下角用 geo 组件显示南海诸岛轮廓
     * 使用 renderMap 阶段从 filterSouthChinaSea 提取的 scsInsetFeatures
     */
    private addSouthChinaSeaInset(option: any): void {
        if (!this.scsInsetFeatures || this.scsInsetFeatures.length === 0) {
            console.warn("[SCS inset] 无南海诸岛特征，跳过小图渲染");
            return;
        }

        // ── 1. 重命名所有特征为"南海诸岛"并计算边界框 ──
        let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
        const namedFeatures = this.scsInsetFeatures.map((f: any) => {
            // 计算边界框
            const coords = f.geometry?.coordinates;
            if (coords) {
                const traverse = (c: any) => {
                    if (typeof c[0] === "number") {
                        minLng = Math.min(minLng, c[0]);
                        maxLng = Math.max(maxLng, c[0]);
                        minLat = Math.min(minLat, c[1]);
                        maxLat = Math.max(maxLat, c[1]);
                    } else {
                        c.forEach(traverse);
                    }
                };
                traverse(coords);
            }
            // 重命名特征，确保 ECharts 能渲染
            return {
                ...f,
                properties: { ...f.properties, name: "南海诸岛" }
            };
        });

        const centerLng = (minLng + maxLng) / 2;
        const centerLat = (minLat + maxLat) / 2;
        console.log(`[SCS inset] 特征数=${namedFeatures.length}, ` +
            `bounds=[${minLng.toFixed(1)},${minLat.toFixed(1)}]-[${maxLng.toFixed(1)},${maxLat.toFixed(1)}], ` +
            `center=[${centerLng.toFixed(1)},${centerLat.toFixed(1)}]`);

        // ── 2. 注册南海诸岛地图 ──
        const scsGeo = { type: "FeatureCollection" as const, features: namedFeatures };
        const scsMapName = "scs_inset";
        // 每次都重新注册，确保数据最新
        echarts.registerMap(scsMapName, scsGeo);
        this.registeredMaps.add("scs_inset");

        // ── 3. 添加 geo 组件作为小图 ──
        // 使用 center+zoom 精确控制视口，不用 layoutCenter/layoutSize 避免冲突
        option.geo = {
            map: scsMapName,
            center: [centerLng, centerLat],
            zoom: 1,
            right: 5,
            bottom: 5,
            width: 80,
            height: 100,
            itemStyle: {
                areaColor: "#f0f5fa",
                borderColor: "#999",
                borderWidth: 0.5
            },
            emphasis: { disabled: true },
            select: { disabled: true },
            silent: true,
            roam: false,
            label: { show: false },
            z: 10,
            data: [{ name: "南海诸岛" }]
        };

        // ── 4. 小图边框背景和标题 ──
        if (!option.graphic) option.graphic = [];
        option.graphic.push({
            type: "rect",
            right: 0,
            bottom: 0,
            shape: { width: 90, height: 120 },
            style: {
                fill: "rgba(255,255,255,0.9)",
                stroke: "#bbb",
                lineWidth: 1
            },
            z: 9
        });
        option.graphic.push({
            type: "text",
            right: 20,
            bottom: 122,
            style: {
                text: "南海诸岛",
                fontSize: 11,
                fill: "#555",
                fontWeight: "bold",
                textAlign: "center"
            },
            z: 11
        });
    }

    /**
     * 构建地图数据数组，尝试多种名称匹配策略
     */
    private buildMapData(dataPoints: DataPoint[]): Array<{ name: string; value: number; _index: number }> {
        // 构建名称→数据点映射（支持多种名称变体）
        const nameMap = new Map<string, { value: number; index: number }>();

        dataPoints.forEach((dp, idx) => {
            // 精确匹配
            nameMap.set(dp.name, { value: dp.value, index: idx });
            // 添加常见后缀变体（让 ECharts 能匹配 GeoJSON 中的全称）
            const suffixes = [
                "省", "市", "自治区", "特别行政区",
                "壮族自治区", "回族自治区", "维吾尔自治区",
                "藏族羌族自治州", "藏族彝族自治州"
            ];
            for (const suffix of suffixes) {
                if (!dp.name.endsWith(suffix)) {
                    nameMap.set(dp.name + suffix, { value: dp.value, index: idx });
                }
            }
            // 去除后缀的短名称（如 GeoJSON 中是"内蒙古"但数据中是"内蒙古自治区"）
            const shortName = MapDataService.normalizeRegionName(dp.name);
            if (shortName !== dp.name) {
                nameMap.set(shortName, { value: dp.value, index: idx });
            }
        });

        // 遍历 GeoJSON features 进行名称匹配
        const result: Array<{ name: string; value: number; _index: number }> = [];
        const mapGeo = (echarts as any).getMap(this.currentMapName);
        const features = mapGeo?.geoJSON?.features || [];

        console.log("[ChinaMap] buildMapData: mapName=", this.currentMapName,
            "features=", features.length, "dataPoints=", dataPoints.length,
            "nameMap.size=", nameMap.size);

        for (const feature of features) {
            const geoName: string = feature.properties?.name || "";
            // 尝试精确匹配
            let matched = nameMap.get(geoName);
            // 尝试标准化后匹配
            if (!matched) {
                const shortGeoName = MapDataService.normalizeRegionName(geoName);
                matched = nameMap.get(shortGeoName);
            }
            if (matched) {
                result.push({
                    name: geoName,
                    value: matched.value,
                    _index: matched.index
                });
            }
        }

        console.log("[ChinaMap] buildMapData: matched=", result.length, "/", features.length,
            "first5=", result.slice(0, 5).map((r) => r.name + "=" + r.value));

        // 如果 GeoJSON 匹配失败，回退到直接使用数据点名称
        if (result.length === 0) {
            console.warn("[ChinaMap] GeoJSON 名称匹配失败，使用原始数据点名称");
            return dataPoints.map((dp, idx) => ({
                name: dp.name,
                value: dp.value,
                _index: idx
            }));
        }

        return result;
    }

    /* ═══════════════════════════════════════
     *  交互事件
     * ═══════════════════════════════════════ */

    /**
     * 绑定 ECharts 点击事件
     * level=1 (全国): 点击省份 → 内部下钻到城市
     * level>=2 (省/市): 点击区域 → 交叉筛选
     */
    private bindChartEvents(): void {
        if (!this.chart) return;

        // 移除旧事件（避免重复绑定）
        this.chart.off("click");

        this.chart.on("click", "series.map", (params: any) => {
            const dataIndex: number = params.dataIndex;
            const mapData = params.data;
            const dpIndex = mapData?._index ?? dataIndex;

            if (this.lastRenderedLevel <= 1) {
                // ── 全国地图：点击省份 → 内部下钻 ──
                const provinceName = params.name;
                if (provinceName) {
                    console.log("[ChinaMap] 点击省份:", provinceName);
                    this.drillDownToProvince(provinceName);
                }
            } else {
                // ── 城市/区县地图：交叉筛选 ──
                if (dpIndex != null && dpIndex < this.currentDataPoints.length) {
                    const dp = this.currentDataPoints[dpIndex];
                    if (dp.selectionId) {
                        this.selectionManager.select(dp.selectionId);
                    }
                }
            }
        });
    }

    /**
     * 内部下钻：点击省份后，从缓存的原始数据中筛选该省的城市数据并渲染城市地图
     */
    private async drillDownToProvince(provinceName: string): Promise<void> {
        if (!this.chart || this.rawCatNames.length < 2) {
            console.log("[ChinaMap] 无法下钻: 原始分类列数不足");
            return;
        }

        // ── 从原始数据中筛选该省份的城市 ──
        const provinceNames = this.rawCatNames[0];
        const cityNames = this.rawCatNames[1];
        const values = this.rawMeasureValues;

        const cityAgg = new Map<string, { total: number; firstIdx: number }>();
        for (let i = 0; i < provinceNames.length; i++) {
            if (provinceNames[i] !== provinceName) continue;
            const city = cityNames[i];
            const existing = cityAgg.get(city);
            if (existing) {
                existing.total += (values[i] ?? 0);
            } else {
                cityAgg.set(city, { total: values[i] ?? 0, firstIdx: i });
            }
        }

        if (cityAgg.size === 0) {
            console.log("[ChinaMap] 省份无城市数据:", provinceName);
            return;
        }

        // ── 构建城市级数据点 ──
        const cityDataPoints: DataPoint[] = [];
        let minVal = Infinity, maxVal = -Infinity;
        cityAgg.forEach((info, cityName) => {
            const selectionId = this.host.createSelectionIdBuilder()
                .withCategory(this.rawCatColumns[1], info.firstIdx)
                .createSelectionId();
            cityDataPoints.push({ name: cityName, value: info.total, selectionId });
            minVal = Math.min(minVal, info.total);
            maxVal = Math.max(maxVal, info.total);
        });

        if (minVal === maxVal && cityDataPoints.length > 1) {
            minVal = maxVal > 0 ? 0 : maxVal - 1;
            maxVal = maxVal > 0 ? maxVal * 1.1 : 1;
        }

        console.log("[ChinaMap] 下钻到:", provinceName, "城市数:", cityDataPoints.length);

        // ── 查找省份 adcode 并加载 GeoJSON ──
        let adcode = this.findRegionAdcodeFromMap(provinceName, "china");
        if (!adcode) {
            try {
                const chinaGeo = await this.mapDataService.getGeoJSON(MapDataService.CHINA_ADCODE);
                echarts.registerMap("china", chinaGeo);
                this.registeredMaps.add(MapDataService.CHINA_ADCODE);
                adcode = this.findRegionAdcodeFromMap(provinceName, "china");
            } catch (e) { /* ignore */ }
        }
        if (!adcode) {
            console.log("[ChinaMap] 找不到省份 adcode:", provinceName);
            return;
        }

        this.showLoading();
        try {
            const geoJson = await this.mapDataService.getGeoJSON(adcode);
            const mapName = `map_${adcode}`;
            if (!this.registeredMaps.has(adcode)) {
                echarts.registerMap(mapName, geoJson);
                this.registeredMaps.add(adcode);
            }

            this.currentAdcode = adcode;
            this.currentMapName = mapName;
            this.hideOverlay();

            const drillState: DrillState = {
                level: 2,
                parentName: provinceName,
                parentAdcode: MapDataService.CHINA_ADCODE,
                mapName,
                dataPoints: cityDataPoints,
                minValue: minVal,
                maxValue: maxVal
            };

            this.currentDataPoints = cityDataPoints;
            this.lastRenderedLevel = 2;
            this.previousDataKey = `2|${cityDataPoints.length}|${provinceName}`;

            const option = this.buildEChartsOption(drillState);
            this.chart.setOption(option, true);
            this.bindChartEvents();
            this.updateBreadcrumb(drillState);
        } catch (error) {
            this.showOverlay(`加载城市地图失败: ${error.message}`, true);
        }
    }

    /* ═══════════════════════════════════════
     *  辅助方法
     * ═══════════════════════════════════════ */

    /**
     * 查找区域名称对应的行政区划代码（从当前地图）
     */
    private findRegionAdcode(regionName: string): string | null {
        return this.findRegionAdcodeFromMap(regionName, this.currentMapName);
    }

    /**
     * 从指定已注册的地图中查找区域 adcode
     */
    private findRegionAdcodeFromMap(regionName: string, mapName: string): string | null {
        const mapGeo = (echarts as any).getMap(mapName);
        const features = mapGeo?.geoJSON?.features || [];
        const normalizedTarget = MapDataService.normalizeRegionName(regionName);

        for (const feature of features) {
            const name: string = feature.properties?.name || "";
            if (name === regionName
                || MapDataService.normalizeRegionName(name) === normalizedTarget) {
                return String(feature.properties?.adcode || "");
            }
        }
        return null;
    }

    /* ═══════════════════════════════════════
     *  面包屑导航
     * ═══════════════════════════════════════ */

    private updateBreadcrumb(state: DrillState): void {
        const fmt = this.getFormatConfig();

        if (!fmt.showBreadcrumb || state.level <= 1) {
            this.breadcrumbElement.style.display = "none";
            return;
        }

        // 层级 >= 2：显示 "全国 › 省份名"
        this.breadcrumbElement.style.display = "block";
        while (this.breadcrumbElement.firstChild) {
            this.breadcrumbElement.removeChild(this.breadcrumbElement.firstChild);
        }

        // "全国" - 可点击返回
        const rootSpan = document.createElement("span");
        rootSpan.textContent = "全国";
        rootSpan.addEventListener("click", () => {
            if (!this.chart) return;

            // 重置所有状态到全国视图
            this.currentAdcode = MapDataService.CHINA_ADCODE;
            const fmtNow = this.getFormatConfig();
            const useInsetNow = fmtNow.southChinaSeaMode === "inset";
            this.currentMapName = useInsetNow ? "china_no_scs" : "china";
            this.lastRenderedLevel = 1;
            this.previousDataKey = "";
            this.selectionManager.clear();
            this.breadcrumbElement.style.display = "none";

            // 直接从已有聚合数据重建全国地图（无需等待 Power BI 回调）
            const restoreData = this.level1DataPoints.length > 0
                ? this.level1DataPoints : this.currentDataPoints;
            if (restoreData.length > 0) {
                const restoreState: DrillState = {
                    level: 1,
                    parentName: "",
                    parentAdcode: MapDataService.CHINA_ADCODE,
                    mapName: "全国",
                    dataPoints: restoreData,
                    minValue: Infinity,
                    maxValue: -Infinity
                };
                for (const dp of restoreState.dataPoints) {
                    restoreState.minValue = Math.min(restoreState.minValue, dp.value);
                    restoreState.maxValue = Math.max(restoreState.maxValue, dp.value);
                }
                if (restoreState.minValue === restoreState.maxValue && restoreState.dataPoints.length > 1) {
                    restoreState.minValue = restoreState.maxValue > 0 ? 0 : restoreState.maxValue - 1;
                    restoreState.maxValue = restoreState.maxValue > 0 ? restoreState.maxValue * 1.1 : 1;
                }
                const option = this.buildEChartsOption(restoreState);
                this.chart.setOption(option, true);
                this.bindChartEvents();
            }
        });
        this.breadcrumbElement.appendChild(rootSpan);

        if (state.parentName) {
            const sep = document.createElement("span");
            sep.className = "separator";
            sep.textContent = "›";
            this.breadcrumbElement.appendChild(sep);

            const currentSpan = document.createElement("span");
            currentSpan.className = "current";
            currentSpan.textContent = state.parentName;
            this.breadcrumbElement.appendChild(currentSpan);
        }
    }

    /* ═══════════════════════════════════════
     *  工具方法
     * ═══════════════════════════════════════ */

    private getFormatConfig(): MapFormatConfig {
        const s = this.formattingSettings;
        return {
            minColor: s?.mapColorCard?.minColor?.value?.value || "#e0f3f8",
            maxColor: s?.mapColorCard?.maxColor?.value?.value || "#045a8d",
            bgColor: s?.mapColorCard?.bgColor?.value?.value || "#f0f5fa",
            borderColor: s?.mapColorCard?.borderColor?.value?.value || "#d4d4d4",
            labelShow: s?.mapLabelsCard?.show?.value ?? true,
            labelFontSize: s?.mapLabelsCard?.fontSize?.value ?? 12,
            labelFontColor: s?.mapLabelsCard?.fontColor?.value?.value || "#333333",
            labelShowValue: s?.mapLabelsCard?.showValue?.value ?? false,
            tooltipShow: s?.mapTooltipCard?.show?.value ?? true,
            roam: s?.mapConfigCard?.roam?.value ?? true,
            showLegend: s?.mapConfigCard?.showLegend?.value ?? true,
            showBreadcrumb: s?.mapConfigCard?.showBreadcrumb?.value ?? true,
            showSouthChinaSea: String(s?.mapConfigCard?.southChinaSeaMode?.value?.value ?? "full") === "full",
            southChinaSeaMode: String(s?.mapConfigCard?.southChinaSeaMode?.value?.value ?? "full"),
            minValue: s?.mapColorCard?.minValue?.value ?? 0,
            maxValue: s?.mapColorCard?.maxValue?.value ?? 0,
        };
    }

    private getMapName(level: number, parentName: string): string {
        switch (level) {
            case 1: return "全国";
            case 2: return parentName || "省级";
            case 3: return parentName || "市级";
            default: return "地图";
        }
    }

    private getLevelLabel(level: number): string {
        switch (level) {
            case 1: return "省份数据";
            case 2: return "城市数据";
            case 3: return "区县数据";
            default: return "数据";
        }
    }

    private getMeasureName(): string {
        // 尝试从 DataView 获取度量名称
        return "度量值";
    }

    private formatNumber(value: number): string {
        if (value == null || isNaN(value)) return "0";
        if (Math.abs(value) >= 100000000) {
            return (value / 100000000).toFixed(2) + "亿";
        }
        if (Math.abs(value) >= 10000) {
            return (value / 10000).toFixed(2) + "万";
        }
        return value.toLocaleString("zh-CN");
    }

    private handleResize = (): void => {
        this.chart?.resize();
    };

    /* ───── Overlay 提示 ───── */

    private showOverlay(message: string, isError: boolean = false): void {
        // 移除已有的 overlay
        this.hideOverlay();

        const overlay = document.createElement("div");
        overlay.className = `map-overlay${isError ? " error" : ""}`;
        overlay.id = "map-overlay";

        if (!isError) {
            const spinner = document.createElement("div");
            spinner.className = "spinner";
            overlay.appendChild(spinner);
        }

        const text = document.createElement("div");
        text.textContent = message;
        overlay.appendChild(text);

        this.chartContainer.appendChild(overlay);
    }

    private hideOverlay(): void {
        const existing = this.chartContainer.querySelector("#map-overlay");
        if (existing) {
            existing.remove();
        }
    }

    private showLoading(): void {
        this.showOverlay("正在加载地图数据...");
    }

}
