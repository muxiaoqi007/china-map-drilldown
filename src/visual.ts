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
    labelContent: string;
    labelFontSize: number;
    labelFontColor: string;
    tooltipShow: boolean;
    roam: boolean;
    showLegend: boolean;
    showBreadcrumb: boolean;
    southChinaSeaMode: string;
    minValue: number;
    maxValue: number;
}

export class Visual implements IVisual {
    private target: HTMLElement;
    private chartContainer: HTMLElement;
    private chartElement: HTMLElement;
    private breadcrumbElement: HTMLElement;

    private host: IVisualHost;
    private chart: echarts.ECharts | null = null;
    private selectionManager: ISelectionManager;
    private formattingSettingsService: FormattingSettingsService;
    private formattingSettings: VisualFormattingSettingsModel;
    private mapDataService: MapDataService;

    private currentAdcode: string = MapDataService.CHINA_ADCODE;
    private currentMapName: string = "china";
    private registeredMaps: Set<string> = new Set();
    private currentDataPoints: DataPoint[] = [];
    private level1DataPoints: DataPoint[] = [];
    private level2DataPoints: DataPoint[] = [];
    private level2ParentName: string = "";
    private previousDataKey: string = "";
    private lastRenderedLevel: number = 0;
    private lastUpdateOptions: VisualUpdateOptions | null = null;
    /** 底层数据指纹：仅在数据真正变化时重绘，避免 Power BI 重复发送全量数据覆盖内部下钻状态 */
    private dataFingerprint: string = "";

    private rawCatColumns: DataViewCategoryColumn[] = [];
    private rawCatNames: string[][] = [];
    private rawMeasureValues: number[] = [];

    private tooltipColumns: Array<{ displayName: string; values: string[] }> = [];
    private scsInsetFeatures: any[] = [];

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.target = options.element;
        this.selectionManager = this.host.createSelectionManager();
        this.formattingSettingsService = new FormattingSettingsService();
        this.mapDataService = new MapDataService();

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

        // SVG 渲染器：兼容 Power BI Service CSP
        this.chart = echarts.init(this.chartElement, null, { renderer: "svg" });
        window.addEventListener("resize", this.handleResize);
    }

    public update(options: VisualUpdateOptions): void {
        try {
            this.lastUpdateOptions = options;

            // 始终用 viewport 设置容器尺寸
            if (options.viewport) {
                const { width, height } = options.viewport;
                this.chartElement.style.width = `${width}px`;
                this.chartElement.style.height = `${height}px`;
                if (this.chart) {
                    this.chart.resize({ width, height });
                }
            }

            const dataView = options.dataViews?.[0];
            if (!dataView) return;

            this.formattingSettings = this.formattingSettingsService
                .populateFormattingSettingsModel(VisualFormattingSettingsModel, dataView);

            if (options.type & powerbi.VisualUpdateType.Resize
                || options.type & powerbi.VisualUpdateType.ResizeEnd) {
                return;
            }

            const parsedData = this.parseDataView(dataView);
            if (!parsedData || parsedData.dataPoints.length === 0) {
                this.showOverlay("请将省份字段拖入数据角色以开始");
                return;
            }

            // 数据指纹：底层数据未变化时跳过重绘，保住内部下钻状态
            // （Power BI 在内部下钻后会重复发送全量数据，若不跳过会把省级地图重置回全国）
            const fingerprint = `${this.rawCatNames.map((c) => c.length).join(",")}|${this.rawMeasureValues.length}|${parsedData.level}|${parsedData.dataPoints.length}`;
            if (fingerprint === this.dataFingerprint && this.lastRenderedLevel >= 2) {
                return;
            }
            this.dataFingerprint = fingerprint;

            const dataKey = `${parsedData.level}|${parsedData.dataPoints.length}|${parsedData.parentName}`;
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
            console.error("[ChinaMap] update error:", error);
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

    /* ═══ 数据解析 ═══ */

    private parseDataView(dataView: DataView): DrillState | null {
        const categorical = dataView.categorical;
        if (!categorical?.categories?.length || !categorical.values?.length) return null;

        const categories = categorical.categories;
        const values = categorical.values as any;
        const primaryCat = categories[0] as DataViewCategoryColumn;
        const rowCount = primaryCat.values.length;
        const primaryNames: string[] = [];
        for (let i = 0; i < rowCount; i++) {
            primaryNames.push(String(primaryCat.values[i] ?? ""));
        }

        // 缓存分类列
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

        // 提取度量值 (values[0])
        const flatValues = this.extractValues(values[0], rowCount);
        if (!flatValues) return null;
        this.rawMeasureValues = flatValues.slice();

        // 提取工具提示 (values[1+])
        this.tooltipColumns = [];
        for (let vi = 1; vi < values.length; vi++) {
            const valCol = values[vi];
            let displayName = "";
            let colValues: any[] = [];
            if (valCol?.source) {
                displayName = valCol.source.displayName || "";
                colValues = valCol.values || [];
            } else if (valCol?.values?.[0]?.source) {
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

        // 检测层级
        const uniqueProvinceCount = new Set(primaryNames).size;

        // Level 3
        if (categories.length >= 3 && uniqueProvinceCount === 1) {
            const cityNames = this.rawCatNames[1];
            const uniqueCityCount = new Set(cityNames).size;
            if (uniqueCityCount === 1) {
                const districtCat = categories[2] as DataViewCategoryColumn;
                const parentCity = cityNames[0];
                const rowIndices = Array.from({ length: districtCat.values.length }, (_, i) => i);
                const ttData = this.buildTooltipData(rowIndices);
                const result = this.buildDrillState(3, parentCity, districtCat, flatValues, ttData);
                result.parentName = parentCity;
                return result;
            }
            // Level 2
            const subCat = categories[1] as DataViewCategoryColumn;
            const subNames = this.rawCatNames[1];
            const parentProvince = primaryNames[0];
            const uniqueCityCount2 = new Set(subNames).size;
            if (uniqueCityCount2 < subNames.length) {
                const agg = this.aggregateByCategory(subNames, flatValues, subCat);
                const ttData = this.buildTooltipData(agg.firstIndices);
                return this.buildDrillState(2, parentProvince, agg.category, agg.values, ttData);
            }
            const rowIndices = Array.from({ length: subCat.values.length }, (_, i) => i);
            const ttData = this.buildTooltipData(rowIndices);
            return this.buildDrillState(2, parentProvince, subCat, flatValues, ttData);
        }

        // Level 1 聚合
        if (categories.length >= 2 && uniqueProvinceCount < rowCount) {
            const agg = this.aggregateByCategory(primaryNames, flatValues, primaryCat);
            const ttData = this.buildTooltipData(agg.firstIndices);
            return this.buildDrillState(1, "", agg.category, agg.values, ttData);
        }

        // Level 1 单列
        const rowIndices = Array.from({ length: rowCount }, (_, i) => i);
        const ttData = this.buildTooltipData(rowIndices);
        return this.buildDrillState(1, "", primaryCat, flatValues, ttData);
    }

    private extractValues(valCol: any, rowCount: number): number[] | null {
        if (!valCol) return null;
        if (valCol.source && valCol.values) {
            const rawVals = valCol.values;
            const result: number[] = [];
            for (let i = 0; i < rawVals.length; i++) {
                result.push(Number(rawVals[i] ?? 0));
            }
            return result;
        }
        // 分组模式
        const flatValues = new Array(rowCount).fill(0);
        if (valCol.identityFrom?.map) {
            const idxMap: number[] = valCol.identityFrom.map;
            const innerVals = valCol.values?.[0]?.values || valCol.values;
            if (Array.isArray(innerVals)) {
                for (let j = 0; j < innerVals.length; j++) {
                    const idx = idxMap[j];
                    if (idx != null && idx < rowCount) {
                        flatValues[idx] += Number(innerVals[j] ?? 0);
                    }
                }
            }
        } else if (Array.isArray(valCol.values)) {
            for (const inner of valCol.values) {
                const iv = inner?.values;
                if (Array.isArray(iv)) {
                    for (let i = 0; i < Math.min(iv.length, rowCount); i++) {
                        flatValues[i] += Number(iv[i] ?? 0);
                    }
                }
            }
        }
        return flatValues;
    }

    private aggregateByCategory(
        names: string[], values: number[], category: DataViewCategoryColumn
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
        const uniqueNames: string[] = [];
        const uniqueIndices: number[] = [];
        const aggValues: number[] = [];
        seen.forEach((info, name) => {
            uniqueNames.push(name);
            uniqueIndices.push(info.firstIdx);
            aggValues.push(info.total);
        });
        const pseudoCategory = {
            values: uniqueNames,
            source: category.source,
            identity: uniqueIndices.map((idx) => category.identity?.[idx])
        } as DataViewCategoryColumn;
        return { category: pseudoCategory, values: aggValues, firstIndices: uniqueIndices };
    }

    private buildDrillState(
        level: number, primaryName: string, category: DataViewCategoryColumn,
        measureValues: number[], tooltipData?: Array<Array<{ displayName: string; value: string }>>
    ): DrillState {
        const dataPoints: DataPoint[] = [];
        let minValue = Infinity, maxValue = -Infinity;
        for (let i = 0; i < category.values.length; i++) {
            const name = String(category.values[i] ?? "");
            const value = measureValues[i] ?? 0;
            if (isNaN(value)) continue;
            const selectionId = this.host.createSelectionIdBuilder()
                .withCategory(category, i).createSelectionId();
            const dp: DataPoint = { name, value, selectionId };
            if (tooltipData && i < tooltipData.length) dp.tooltips = tooltipData[i];
            dataPoints.push(dp);
            minValue = Math.min(minValue, value);
            maxValue = Math.max(maxValue, value);
        }
        if (minValue === maxValue && dataPoints.length > 1) {
            minValue = maxValue > 0 ? 0 : maxValue - 1;
            maxValue = maxValue > 0 ? maxValue * 1.1 : 1;
        }
        return {
            level,
            parentName: level >= 2 ? primaryName : "",
            parentAdcode: MapDataService.CHINA_ADCODE,
            mapName: this.getMapName(level, primaryName),
            dataPoints, minValue, maxValue
        };
    }

    private buildTooltipData(rowIndices: number[]): Array<Array<{ displayName: string; value: string }>> {
        if (this.tooltipColumns.length === 0) return [];
        return rowIndices.map((rowIdx) =>
            this.tooltipColumns
                .filter((col) => rowIdx < col.values.length)
                .map((col) => ({ displayName: col.displayName, value: col.values[rowIdx] }))
        );
    }

    /* ═══ 地图渲染 ═══ */

    private async renderMap(drillState: DrillState): Promise<void> {
        if (!this.chart) return;

        let targetAdcode: string;
        if (drillState.level <= 1) {
            targetAdcode = MapDataService.CHINA_ADCODE;
        } else {
            let adcode = this.findRegionAdcodeFromMap(drillState.parentName, this.currentMapName);
            if (!adcode) {
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

        const fmt = this.getFormatConfig();
        const useInset = fmt.southChinaSeaMode === "inset" && targetAdcode === MapDataService.CHINA_ADCODE;
        const mapName = targetAdcode === MapDataService.CHINA_ADCODE
            ? (useInset ? "china_no_scs" : "china")
            : `map_${targetAdcode}`;
        const cacheKey = targetAdcode + (useInset ? "_no_scs" : "");
        const needsReload = this.currentMapName !== mapName || !this.registeredMaps.has(cacheKey);

        if (needsReload) {
            this.showLoading();
            try {
                let geoJson = await this.mapDataService.getGeoJSON(targetAdcode);
                if (useInset) {
                    const scsResult = MapDataService.filterSouthChinaSea(geoJson);
                    geoJson = scsResult.cleanedGeoJson;
                    this.scsInsetFeatures = scsResult.scsFeatures;
                    echarts.registerMap(mapName, geoJson);
                    this.registeredMaps.add(cacheKey);
                } else {
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
        } else if (drillState.level === 2) {
            this.level2DataPoints = drillState.dataPoints;
            this.level2ParentName = drillState.parentName;
        }
        this.hideOverlay();

        const option = this.buildEChartsOption(drillState);
        this.chart.clear();
        this.chart.setOption(option, true);
        this.bindChartEvents();
        this.updateBreadcrumb(drillState);
    }

    private buildEChartsOption(state: DrillState): echarts.EChartsOption {
        const fmt = this.getFormatConfig();
        const mapData = this.buildMapData(state.dataPoints);

        const seriesOption: any = {
            name: this.getLevelLabel(state.level),
            type: "map",
            map: this.currentMapName,
            roam: fmt.roam,
            selectedMode: false,
            itemStyle: { areaColor: fmt.bgColor, borderColor: fmt.borderColor, borderWidth: 1 },
            emphasis: {
                label: { show: true, color: "#333", fontWeight: "bold" },
                itemStyle: { areaColor: "#bde0fe" }
            },
            select: { label: { show: true }, itemStyle: { areaColor: "#ffc300" } },
            label: {
                show: fmt.labelShow,
                fontSize: fmt.labelFontSize,
                color: fmt.labelFontColor,
                formatter: (params: any) => this.formatLabel(params, fmt)
            },
            data: mapData
        };

        const option: any = {
            tooltip: {
                show: fmt.tooltipShow,
                trigger: "item",
                formatter: (params: any) => {
                    const lines: string[] = [`<b>${params.name}</b>`];
                    if (params.value != null && !isNaN(params.value)) {
                        lines.push(`${this.getMeasureName()}: ${this.formatNumber(params.value)}`);
                    }
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

        if (fmt.showLegend) {
            option.visualMap = {
                type: "continuous",
                min: fmt.minValue || state.minValue,
                max: fmt.maxValue || state.maxValue,
                left: "left", bottom: 20,
                formatter: (value: number) => this.formatNumber(value),
                inRange: { color: [fmt.minColor, fmt.maxColor] },
                calculable: true, orient: "vertical", itemWidth: 15, itemHeight: 120
            };
        }

        if (state.level > 1 && state.parentName) {
            option.title = {
                text: state.parentName, left: "center", top: 5,
                textStyle: { fontSize: 15, fontWeight: "bold", color: "#333" }
            };
        }

        if (fmt.southChinaSeaMode === "inset" && state.level <= 1) {
            this.addSouthChinaSeaInset(option);
        } else {
            // 完整显示模式：显式清空小图组件和图形元素，避免残留
            option.geo = null;
            option.graphic = [];
        }

        return option;
    }

    private formatLabel(params: any, fmt: MapFormatConfig): string {
        switch (fmt.labelContent) {
            case "value":
                return params.value != null ? this.formatNumber(params.value) : params.name;
            case "nameAndValue":
                return params.value != null ? `${params.name}\n${this.formatNumber(params.value)}` : params.name;
            default:
                return params.name;
        }
    }

    private addSouthChinaSeaInset(option: any): void {
        if (!this.scsInsetFeatures || this.scsInsetFeatures.length === 0) return;

        let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
        const namedFeatures = this.scsInsetFeatures.map((f: any) => {
            const coords = f.geometry?.coordinates;
            if (coords) {
                const traverse = (c: any) => {
                    if (typeof c[0] === "number") {
                        minLng = Math.min(minLng, c[0]); maxLng = Math.max(maxLng, c[0]);
                        minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]);
                    } else { c.forEach(traverse); }
                };
                traverse(coords);
            }
            return { ...f, properties: { ...f.properties, name: "南海诸岛" } };
        });

        const scsGeo = { type: "FeatureCollection" as const, features: namedFeatures };
        echarts.registerMap("scs_inset", scsGeo);
        this.registeredMaps.add("scs_inset");

        option.geo = {
            map: "scs_inset",
            center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2],
            zoom: 1, right: 5, bottom: 5, width: 80, height: 100,
            itemStyle: { areaColor: "#f0f5fa", borderColor: "#999", borderWidth: 0.5 },
            emphasis: { disabled: true }, select: { disabled: true },
            silent: true, roam: false, label: { show: false }, z: 10,
            data: [{ name: "南海诸岛" }]
        };

        if (!option.graphic) option.graphic = [];
        option.graphic.push(
            { type: "rect", right: 0, bottom: 0, shape: { width: 90, height: 120 }, style: { fill: "rgba(255,255,255,0.9)", stroke: "#bbb", lineWidth: 1 }, z: 9 },
            { type: "text", right: 20, bottom: 122, style: { text: "南海诸岛", fontSize: 11, fill: "#555", fontWeight: "bold", textAlign: "center" }, z: 11 }
        );
    }

    private buildMapData(dataPoints: DataPoint[]): Array<{ name: string; value: number; _index: number }> {
        const nameMap = new Map<string, { value: number; index: number }>();
        const shortMap = new Map<string, { value: number; index: number }>();
        const coreEntries: Array<{ core: string; value: number; index: number }> = [];

        dataPoints.forEach((dp, idx) => {
            const clean = dp.name.trim();
            const entry = { value: dp.value, index: idx };
            // 精确（含 trim）
            if (!nameMap.has(clean)) nameMap.set(clean, entry);
            // 加后缀变体
            const suffixes = ["省", "市", "自治区", "特别行政区", "壮族自治区", "回族自治区", "维吾尔自治区", "自治州", "地区"];
            for (const suffix of suffixes) {
                if (!clean.endsWith(suffix) && !nameMap.has(clean + suffix)) nameMap.set(clean + suffix, entry);
            }
            // 标准化短名
            const shortName = MapDataService.normalizeRegionName(clean);
            if (shortName && !shortMap.has(shortName)) shortMap.set(shortName, entry);
            // 前缀匹配用的核心名（取标准化短名，去掉常见后缀）
            const core = shortName.replace(/(地区|新区|城区|郊区)$/g, "") || shortName;
            coreEntries.push({ core, value: dp.value, index: idx });
        });

        const result: Array<{ name: string; value: number; _index: number }> = [];
        const unmatchedFeatures: string[] = [];
        const mapGeo = (echarts as any).getMap(this.currentMapName);
        const features = mapGeo?.geoJSON?.features || [];

        for (const feature of features) {
            const geoName: string = (feature.properties?.name || "").trim();
            if (!geoName) continue;
            let matched = nameMap.get(geoName);
            if (!matched) matched = shortMap.get(MapDataService.normalizeRegionName(geoName));
            // 前缀兜底：数据核心名与 GeoJSON 短名互为前缀
            if (!matched) {
                const geoShort = MapDataService.normalizeRegionName(geoName);
                let best: { value: number; index: number } | null = null;
                let bestLen = 1;
                for (const e of coreEntries) {
                    if (e.core.length < 2) continue;
                    if (geoShort.startsWith(e.core) || e.core.startsWith(geoShort)) {
                        if (e.core.length > bestLen) { bestLen = e.core.length; best = { value: e.value, index: e.index }; }
                    }
                }
                if (best) matched = best;
            }
            if (matched) {
                result.push({ name: geoName, value: matched.value, _index: matched.index });
            } else {
                unmatchedFeatures.push(geoName);
            }
        }

        if (unmatchedFeatures.length > 0) {
            console.warn("[ChinaMap] 未匹配的区域:", unmatchedFeatures.join(", "));
        }
        if (result.length === 0) {
            return dataPoints.map((dp, idx) => ({ name: dp.name.trim(), value: dp.value, _index: idx }));
        }
        return result;
    }

    /* ═══ 交互 ═══ */

    private bindChartEvents(): void {
        if (!this.chart) return;
        this.chart.off("click");
        this.chart.on("click", "series.map", (params: any) => {
            const dpIndex = params.data?._index ?? params.dataIndex;
            if (this.lastRenderedLevel <= 1) {
                if (params.name) this.drillDownToProvince(params.name);
            } else if (this.lastRenderedLevel === 2) {
                if (params.name) this.drillDownToCity(params.name);
            } else {
                if (dpIndex != null && dpIndex < this.currentDataPoints.length) {
                    const dp = this.currentDataPoints[dpIndex];
                    if (dp.selectionId) this.selectionManager.select(dp.selectionId);
                }
            }
        });
    }

    private async drillDownToProvince(provinceName: string): Promise<void> {
        if (!this.chart || this.rawCatNames.length < 2) return;
        const provinceNames = this.rawCatNames[0];
        const cityNames = this.rawCatNames[1];
        const values = this.rawMeasureValues;

        // ── 直辖市检测：省份名==城市名（北京/天津/上海/重庆），无地级层，直接下钻到区县 ──
        const normProvince = MapDataService.normalizeRegionName(provinceName);
        let isMunicipality = true;
        for (let i = 0; i < provinceNames.length; i++) {
            if (MapDataService.normalizeRegionName(provinceNames[i]) !== normProvince) continue;
            if (MapDataService.normalizeRegionName(cityNames[i]) !== normProvince) {
                isMunicipality = false;
                break;
            }
        }
        if (isMunicipality && this.rawCatNames.length >= 3) {
            await this.drillDownMunicipalityToDistrict(provinceName, normProvince);
            return;
        }

        const cityAgg = new Map<string, { total: number; firstIdx: number }>();
        for (let i = 0; i < provinceNames.length; i++) {
            if (provinceNames[i] !== provinceName
                && MapDataService.normalizeRegionName(provinceNames[i]) !== MapDataService.normalizeRegionName(provinceName)) continue;
            const city = cityNames[i];
            const existing = cityAgg.get(city);
            if (existing) { existing.total += (values[i] ?? 0); }
            else { cityAgg.set(city, { total: values[i] ?? 0, firstIdx: i }); }
        }
        if (cityAgg.size === 0) return;

        const cityDataPoints: DataPoint[] = [];
        let minVal = Infinity, maxVal = -Infinity;
        cityAgg.forEach((info, cityName) => {
            const sid = this.host.createSelectionIdBuilder().withCategory(this.rawCatColumns[1], info.firstIdx).createSelectionId();
            cityDataPoints.push({ name: cityName, value: info.total, selectionId: sid });
            minVal = Math.min(minVal, info.total);
            maxVal = Math.max(maxVal, info.total);
        });
        if (minVal === maxVal && cityDataPoints.length > 1) { minVal = maxVal > 0 ? 0 : maxVal - 1; maxVal = maxVal > 0 ? maxVal * 1.1 : 1; }

        const adcode = await this.resolveAdcode(provinceName);
        if (!adcode) return;
        await this.loadAndRenderDrillMap(adcode, provinceName, 2, cityDataPoints, minVal, maxVal);
        // 下钻优先：省份级不联动表格（避免表格被过滤成单行），仅地图内部下钻
    }

    /**
     * 直辖市下钻：省==市，直接聚合区县列并渲染区县级地图（level 3）
     * 地图使用该直辖市的省级 adcode（如北京 110000），其 features 即各区
     */
    private async drillDownMunicipalityToDistrict(provinceName: string, normProvince: string): Promise<void> {
        if (!this.chart) return;
        const provinceNames = this.rawCatNames[0];
        const districtNames = this.rawCatNames[2];
        const values = this.rawMeasureValues;

        const districtAgg = new Map<string, { total: number; firstIdx: number }>();
        for (let i = 0; i < provinceNames.length; i++) {
            if (MapDataService.normalizeRegionName(provinceNames[i]) !== normProvince) continue;
            const district = districtNames[i];
            const existing = districtAgg.get(district);
            if (existing) { existing.total += (values[i] ?? 0); }
            else { districtAgg.set(district, { total: values[i] ?? 0, firstIdx: i }); }
        }
        if (districtAgg.size === 0) return;

        const districtDataPoints: DataPoint[] = [];
        let minVal = Infinity, maxVal = -Infinity;
        districtAgg.forEach((info, name) => {
            const sid = this.host.createSelectionIdBuilder().withCategory(this.rawCatColumns[2], info.firstIdx).createSelectionId();
            districtDataPoints.push({ name, value: info.total, selectionId: sid });
            minVal = Math.min(minVal, info.total);
            maxVal = Math.max(maxVal, info.total);
        });
        if (minVal === maxVal && districtDataPoints.length > 1) { minVal = maxVal > 0 ? 0 : maxVal - 1; maxVal = maxVal > 0 ? maxVal * 1.1 : 1; }

        const adcode = await this.resolveAdcode(provinceName);
        if (!adcode) return;
        // 直辖市无地级层，面包屑的"省份"层即该直辖市本身
        this.level2ParentName = provinceName;
        await this.loadAndRenderDrillMap(adcode, provinceName, 3, districtDataPoints, minVal, maxVal);
        // 下钻优先：不联动表格，仅地图内部下钻
    }

    private async drillDownToCity(cityName: string): Promise<void> {
        if (!this.chart || this.rawCatNames.length < 3) { this.crossFilter(cityName); return; }
        const cityNames = this.rawCatNames[1];
        const districtNames = this.rawCatNames[2];
        const values = this.rawMeasureValues;

        const districtAgg = new Map<string, { total: number; firstIdx: number }>();
        for (let i = 0; i < cityNames.length; i++) {
            if (cityNames[i] !== cityName
                && MapDataService.normalizeRegionName(cityNames[i]) !== MapDataService.normalizeRegionName(cityName)) continue;
            const district = districtNames[i];
            const existing = districtAgg.get(district);
            if (existing) { existing.total += (values[i] ?? 0); }
            else { districtAgg.set(district, { total: values[i] ?? 0, firstIdx: i }); }
        }
        if (districtAgg.size === 0) { this.crossFilter(cityName); return; }

        const districtDataPoints: DataPoint[] = [];
        let minVal = Infinity, maxVal = -Infinity;
        districtAgg.forEach((info, name) => {
            const sid = this.host.createSelectionIdBuilder().withCategory(this.rawCatColumns[2], info.firstIdx).createSelectionId();
            districtDataPoints.push({ name, value: info.total, selectionId: sid });
            minVal = Math.min(minVal, info.total);
            maxVal = Math.max(maxVal, info.total);
        });
        if (minVal === maxVal && districtDataPoints.length > 1) { minVal = maxVal > 0 ? 0 : maxVal - 1; maxVal = maxVal > 0 ? maxVal * 1.1 : 1; }

        let adcode = this.findRegionAdcodeFromMap(cityName, this.currentMapName);
        if (!adcode) adcode = await this.resolveAdcode(cityName);
        if (!adcode) { this.crossFilter(cityName); return; }
        await this.loadAndRenderDrillMap(adcode, cityName, 3, districtDataPoints, minVal, maxVal);
    }

    private crossFilter(name: string): void {
        const dp = this.currentDataPoints.find(
            (d) => d.name === name || MapDataService.normalizeRegionName(d.name) === MapDataService.normalizeRegionName(name)
        );
        if (dp?.selectionId) this.selectionManager.select(dp.selectionId);
    }

    private async resolveAdcode(regionName: string): Promise<string | null> {
        let adcode = this.findRegionAdcodeFromMap(regionName, this.currentMapName);
        if (adcode) return adcode;
        if (!this.registeredMaps.has(MapDataService.CHINA_ADCODE)) {
            try {
                const chinaGeo = await this.mapDataService.getGeoJSON(MapDataService.CHINA_ADCODE);
                echarts.registerMap("china", chinaGeo);
                this.registeredMaps.add(MapDataService.CHINA_ADCODE);
            } catch (e) { /* ignore */ }
        }
        return this.findRegionAdcodeFromMap(regionName, "china");
    }

    private async loadAndRenderDrillMap(
        adcode: string, parentName: string, level: number,
        dataPoints: DataPoint[], minVal: number, maxVal: number
    ): Promise<void> {
        if (!this.chart) return;
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
                level, parentName, parentAdcode: MapDataService.CHINA_ADCODE,
                mapName, dataPoints, minValue: minVal, maxValue: maxVal
            };
            this.currentDataPoints = dataPoints;
            this.lastRenderedLevel = level;
            this.previousDataKey = `${level}|${dataPoints.length}|${parentName}`;
            if (level === 2) { this.level2DataPoints = dataPoints; this.level2ParentName = parentName; }

            const option = this.buildEChartsOption(drillState);
            this.chart.clear();
            this.chart.setOption(option, true);
            this.bindChartEvents();
            this.updateBreadcrumb(drillState);
        } catch (error) {
            this.showOverlay(`加载地图失败: ${error.message}`, true);
        }
    }

    /* ═══ 辅助 ═══ */

    private findRegionAdcodeFromMap(regionName: string, mapName: string): string | null {
        const mapGeo = (echarts as any).getMap(mapName);
        const features = mapGeo?.geoJSON?.features || [];
        const normalizedTarget = MapDataService.normalizeRegionName(regionName);
        for (const feature of features) {
            const name: string = feature.properties?.name || "";
            if (name === regionName || MapDataService.normalizeRegionName(name) === normalizedTarget) {
                return String(feature.properties?.adcode || "");
            }
        }
        return null;
    }

    private updateBreadcrumb(state: DrillState): void {
        const fmt = this.getFormatConfig();
        if (!fmt.showBreadcrumb || state.level <= 1) { this.breadcrumbElement.style.display = "none"; return; }

        this.breadcrumbElement.style.display = "block";
        while (this.breadcrumbElement.firstChild) this.breadcrumbElement.removeChild(this.breadcrumbElement.firstChild);

        const rootSpan = document.createElement("span");
        rootSpan.textContent = "全国";
        rootSpan.addEventListener("click", () => this.navigateToLevel1());
        this.breadcrumbElement.appendChild(rootSpan);

        if (state.level === 2 && state.parentName) {
            this.breadcrumbElement.appendChild(this.createSep());
            const cur = document.createElement("span");
            cur.className = "current";
            cur.textContent = state.parentName;
            this.breadcrumbElement.appendChild(cur);
        }
        if (state.level === 3) {
            this.breadcrumbElement.appendChild(this.createSep());
            const prov = document.createElement("span");
            prov.textContent = this.level2ParentName || "省份";
            prov.addEventListener("click", () => this.navigateToLevel2());
            this.breadcrumbElement.appendChild(prov);
            this.breadcrumbElement.appendChild(this.createSep());
            const city = document.createElement("span");
            city.className = "current";
            city.textContent = state.parentName;
            this.breadcrumbElement.appendChild(city);
        }
    }

    private createSep(): HTMLElement {
        const sep = document.createElement("span");
        sep.className = "separator";
        sep.textContent = "›";
        return sep;
    }

    private navigateToLevel1(): void {
        if (!this.chart) return;
        this.currentAdcode = MapDataService.CHINA_ADCODE;
        const fmtNow = this.getFormatConfig();
        this.currentMapName = fmtNow.southChinaSeaMode === "inset" ? "china_no_scs" : "china";
        this.lastRenderedLevel = 1;
        this.previousDataKey = "";
        this.dataFingerprint = "";
        this.selectionManager.clear();
        this.breadcrumbElement.style.display = "none";
        const data = this.level1DataPoints.length > 0 ? this.level1DataPoints : this.currentDataPoints;
        if (data.length > 0) {
            const state = this.buildRestoreState(1, "", data);
            this.chart.clear();
            this.chart.setOption(this.buildEChartsOption(state), true);
            this.bindChartEvents();
        }
    }

    private navigateToLevel2(): void {
        if (!this.chart || this.level2DataPoints.length === 0) return;
        const provinceName = this.level2ParentName;
        const adcode = this.findRegionAdcodeFromMap(provinceName, "china")
            || this.findRegionAdcodeFromMap(provinceName, this.currentMapName);
        if (!adcode) { this.navigateToLevel1(); return; }
        this.currentAdcode = adcode;
        this.currentMapName = `map_${adcode}`;
        this.lastRenderedLevel = 2;
        this.previousDataKey = `2|${this.level2DataPoints.length}|${provinceName}`;
        this.selectionManager.clear();
        const state = this.buildRestoreState(2, provinceName, this.level2DataPoints);
        this.chart.clear();
        this.chart.setOption(this.buildEChartsOption(state), true);
        this.bindChartEvents();
        this.updateBreadcrumb(state);
    }

    private buildRestoreState(level: number, parentName: string, dataPoints: DataPoint[]): DrillState {
        let minV = Infinity, maxV = -Infinity;
        for (const dp of dataPoints) { minV = Math.min(minV, dp.value); maxV = Math.max(maxV, dp.value); }
        if (minV === maxV && dataPoints.length > 1) { minV = maxV > 0 ? 0 : maxV - 1; maxV = maxV > 0 ? maxV * 1.1 : 1; }
        return { level, parentName, parentAdcode: MapDataService.CHINA_ADCODE, mapName: this.currentMapName, dataPoints, minValue: minV, maxValue: maxV };
    }

    private getFormatConfig(): MapFormatConfig {
        const s = this.formattingSettings;
        return {
            minColor: s?.mapColorCard?.minColor?.value?.value || "#e0f3f8",
            maxColor: s?.mapColorCard?.maxColor?.value?.value || "#045a8d",
            bgColor: s?.mapColorCard?.bgColor?.value?.value || "#f0f5fa",
            borderColor: s?.mapColorCard?.borderColor?.value?.value || "#d4d4d4",
            labelShow: s?.mapLabelsCard?.show?.value ?? true,
            labelContent: String(s?.mapLabelsCard?.labelContent?.value?.value ?? "name"),
            labelFontSize: s?.mapLabelsCard?.fontSize?.value ?? 12,
            labelFontColor: s?.mapLabelsCard?.fontColor?.value?.value || "#333333",
            tooltipShow: s?.mapTooltipCard?.show?.value ?? true,
            roam: s?.mapConfigCard?.roam?.value ?? true,
            showLegend: s?.mapConfigCard?.showLegend?.value ?? true,
            showBreadcrumb: s?.mapConfigCard?.showBreadcrumb?.value ?? true,
            southChinaSeaMode: String(s?.mapConfigCard?.southChinaSeaMode?.value?.value ?? "full"),
            minValue: s?.mapColorCard?.minValue?.value ?? 0,
            maxValue: s?.mapColorCard?.maxValue?.value ?? 0,
        };
    }

    private getMapName(level: number, parentName: string): string {
        switch (level) { case 1: return "全国"; case 2: return parentName || "省级"; case 3: return parentName || "市级"; default: return "地图"; }
    }
    private getLevelLabel(level: number): string {
        switch (level) { case 1: return "省份数据"; case 2: return "城市数据"; case 3: return "区县数据"; default: return "数据"; }
    }
    private getMeasureName(): string { return "数值"; }
    private formatNumber(value: number): string {
        if (value == null || isNaN(value)) return "0";
        if (Math.abs(value) >= 100000000) return (value / 100000000).toFixed(2) + "亿";
        if (Math.abs(value) >= 10000) return (value / 10000).toFixed(2) + "万";
        return value.toLocaleString("zh-CN");
    }
    private handleResize = (): void => { this.chart?.resize(); };

    private showOverlay(message: string, isError: boolean = false): void {
        this.hideOverlay();
        const overlay = document.createElement("div");
        overlay.className = `map-overlay${isError ? " error" : ""}`;
        overlay.id = "map-overlay";
        if (!isError) { const spinner = document.createElement("div"); spinner.className = "spinner"; overlay.appendChild(spinner); }
        const text = document.createElement("div");
        text.textContent = message;
        overlay.appendChild(text);
        this.chartContainer.appendChild(overlay);
    }
    private hideOverlay(): void {
        const existing = this.chartContainer.querySelector("#map-overlay");
        if (existing) existing.remove();
    }
    private showLoading(): void { this.showOverlay("正在加载地图数据..."); }
}
