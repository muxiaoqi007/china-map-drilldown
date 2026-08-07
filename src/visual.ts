/**
 * Power BI 中国地图层级下钻视觉
 * 基于 ECharts 实现省→市→区三级 Choropleth 填充地图
 */

"use strict";

import powerbi from "powerbi-visuals-api";
import * as echarts from "echarts";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { valueFormatter } from "powerbi-visuals-utils-formattingutils";
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
import DataViewMetadataColumn = powerbi.DataViewMetadataColumn;
import DataViewTable = powerbi.DataViewTable;

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
    /** 当前下钻的父级名称（level 2=省名, level 3=市名），用于恢复联动 */
    private currentDrillParentName: string = "";
    /** 当前下钻所属的省份名（level 2/3 均有效），用于面包屑省份层级回退 */
    private currentDrillProvinceName: string = "";
    /** 当前 level 3 下钻是否为直辖市（恢复联动时用省级多选） */
    private currentDrillIsMunicipality: boolean = false;
    /** 当前下钻省份的行政区划代码，面包屑回退时不再依赖全国地图是否已注册 */
    private currentDrillProvinceAdcode: string = "";
    private previousDataKey: string = "";
    private lastRenderedLevel: number = 0;
    private lastUpdateOptions: VisualUpdateOptions | null = null;
    /** 底层数据指纹：仅在数据真正变化时重绘，避免 Power BI 重复发送全量数据覆盖内部下钻状态 */
    private dataFingerprint: string = "";
    /** 是否由当前内部下钻应用了 Power BI 联动选择 */
    private drillSelectionActive: boolean = false;
    /** 忽略由本视觉自己发起的 selection 回调，只处理宿主端清除选择 */
    private applyingDrillSelection: boolean = false;

    private rawCatColumns: DataViewCategoryColumn[] = [];
    private rawCatNames: string[][] = [];
    private rawMeasureValues: number[] = [];
    private rawTable: DataViewTable | null = null;

    private tooltipColumns: Array<{ displayName: string; values: any[]; formatString: string }> = [];
    private measureDisplayName: string = "数值";
    private measureFormatString: string = "#,0.##";
    private scsInsetFeatures: any[] = [];

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.target = options.element;
        this.selectionManager = this.host.createSelectionManager();
        this.selectionManager.registerOnSelectCallback((ids) => this.handleHostSelectionChanged(ids));
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
            const fingerprint = this.buildDataFingerprint(parsedData);
            const selectionWasCleared = this.drillSelectionActive
                && this.lastRenderedLevel >= 2
                && this.selectionManager.getSelectionIds().length === 0;

            // 用户取消城市/区县选中时，保留当前下钻地图，并恢复父级区域联动。
            // 例如地图仍在黑龙江省时，右侧表格应恢复为“黑龙江省”，而不是全国。
            if (selectionWasCleared) {
                void this.restoreCurrentLevelLinkage();
                return;
            } else if (fingerprint === this.dataFingerprint && this.lastRenderedLevel >= 2) {
                return;
            }
            this.dataFingerprint = fingerprint;

            const dataKey = `${parsedData.level}|${parsedData.dataPoints.length}|${parsedData.parentName}`;
            if (dataKey !== this.previousDataKey) {
                if (parsedData.level <= 1 && this.lastRenderedLevel >= 2) {
                    this.resetDrillTracking();
                    void this.selectionManager.clear();
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
        if (dataView.table?.rows?.length) {
            return this.parseTableData(dataView.table);
        }

        this.rawTable = null;
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
        const measureSource = values[0]?.source || values[0]?.values?.[0]?.source;
        this.updateMeasureMetadata(measureSource);
        const flatValues = this.extractValues(values[0], rowCount, primaryCat);
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
                const source = valCol?.source || valCol?.values?.[0]?.source;
                this.tooltipColumns.push({
                    displayName,
                    values: colValues,
                    formatString: this.getColumnFormatString(source)
                });
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

    /**
     * 表格映射按原始行返回省/市/区/度量，列之间天然对齐。
     * 这避免多分类 categorical 映射把度量拆成独立分组后产生缺失或错配。
     */
    private parseTableData(table: DataViewTable): DrillState | null {
        const rows = table.rows || [];
        const columns = table.columns || [];
        const roleIndex = (role: string): number =>
            columns.findIndex((column) => !!column.roles?.[role]);

        const provinceIndex = roleIndex("province");
        const cityIndex = roleIndex("city");
        const districtIndex = roleIndex("district");
        const measureIndex = roleIndex("measure");
        if (provinceIndex < 0 || measureIndex < 0 || rows.length === 0) return null;

        this.rawTable = table;
        this.rawCatColumns = [];
        this.updateMeasureMetadata(columns[measureIndex]);
        const provinceNames = rows.map((row) => String(row[provinceIndex] ?? ""));
        const cityNames = cityIndex >= 0 ? rows.map((row) => String(row[cityIndex] ?? "")) : [];
        const districtNames = districtIndex >= 0 ? rows.map((row) => String(row[districtIndex] ?? "")) : [];
        this.rawCatNames = [provinceNames];
        if (cityIndex >= 0) this.rawCatNames.push(cityNames);
        if (districtIndex >= 0) this.rawCatNames.push(districtNames);
        this.rawMeasureValues = rows.map((row) => Number(row[measureIndex] ?? 0));

        this.tooltipColumns = [];
        for (let ci = 0; ci < columns.length; ci++) {
            if (!columns[ci].roles?.tooltips) continue;
            this.tooltipColumns.push({
                displayName: columns[ci].displayName || "",
                values: rows.map((row) => row[ci]),
                formatString: this.getColumnFormatString(columns[ci])
            });
        }

        const normalizeSet = (names: string[]): Set<string> =>
            new Set(names.map((name) => MapDataService.normalizeRegionName(name)));
        const uniqueProvinceCount = normalizeSet(provinceNames).size;

        if (districtIndex >= 0 && uniqueProvinceCount === 1 && cityNames.length > 0) {
            const uniqueCityCount = normalizeSet(cityNames).size;
            if (uniqueCityCount === 1) {
                return this.buildTableDrillState(3, cityNames[0], districtNames);
            }
        }
        if (cityIndex >= 0 && uniqueProvinceCount === 1) {
            return this.buildTableDrillState(2, provinceNames[0], cityNames);
        }
        return this.buildTableDrillState(1, "", provinceNames);
    }

    private buildTableDrillState(level: number, parentName: string, names: string[]): DrillState {
        const grouped = new Map<string, { name: string; total: number; firstIdx: number }>();
        for (let i = 0; i < names.length; i++) {
            const normalized = MapDataService.normalizeRegionName(names[i]);
            const key = normalized || names[i];
            const existing = grouped.get(key);
            if (existing) {
                existing.total += this.rawMeasureValues[i] ?? 0;
            } else {
                grouped.set(key, {
                    name: names[i],
                    total: this.rawMeasureValues[i] ?? 0,
                    firstIdx: i
                });
            }
        }

        const dataPoints: DataPoint[] = [];
        let minValue = Infinity;
        let maxValue = -Infinity;
        grouped.forEach((item) => {
            const dp: DataPoint = {
                name: item.name,
                value: item.total,
                selectionId: this.createRowSelectionId(item.firstIdx, Math.max(0, level - 1))
            };
            const tooltips = this.buildTooltipData([item.firstIdx])[0];
            if (tooltips?.length) dp.tooltips = tooltips;
            dataPoints.push(dp);
            minValue = Math.min(minValue, item.total);
            maxValue = Math.max(maxValue, item.total);
        });

        if (minValue === maxValue && dataPoints.length > 1) {
            minValue = maxValue > 0 ? 0 : maxValue - 1;
            maxValue = maxValue > 0 ? maxValue * 1.1 : 1;
        }
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

    private extractValues(valCol: any, rowCount: number, primaryCat?: DataViewCategoryColumn): number[] | null {
        if (!valCol) return null;

        // 平坦模式：values 直接对应分类行
        if (valCol.source && Array.isArray(valCol.values)) {
            const rawVals = valCol.values;
            const idxMap = valCol.identityFrom?.map;
            if (Array.isArray(idxMap) && idxMap.length > 0) {
                const mappedResult = new Array(rowCount).fill(0);
                for (let i = 0; i < rawVals.length; i++) {
                    const row = idxMap[i];
                    if (typeof row === "number" && row >= 0 && row < rowCount) {
                        mappedResult[row] += Number(rawVals[i] ?? 0);
                    }
                }
                return mappedResult;
            }

            const result: number[] = [];
            for (let i = 0; i < rawVals.length; i++) {
                result.push(Number(rawVals[i] ?? 0));
            }
            return result;
        }

        // 分组模式：按分组的 identity 归并到对应的省份行
        const flatValues = new Array(rowCount).fill(0);

        // 构建省份行 identity → 行索引 的映射
        const identityToRow = new Map<string, number>();
        const nameToRow = new Map<string, number>();
        if (primaryCat?.identity) {
            for (let i = 0; i < primaryCat.identity.length; i++) {
                const key = this.serializeIdentity(primaryCat.identity[i]);
                if (key && !identityToRow.has(key)) identityToRow.set(key, i);
            }
        }
        if (primaryCat?.values) {
            for (let i = 0; i < primaryCat.values.length; i++) {
                const name = MapDataService.normalizeRegionName(String(primaryCat.values[i] ?? ""));
                if (name && !nameToRow.has(name)) nameToRow.set(name, i);
            }
        }

        const sumGroup = (g: any): number => {
            let s = 0;
            const inner = Array.isArray(g?.values) ? g.values : [];
            for (const m of inner) {
                const arr = Array.isArray(m?.values) ? m.values : (Array.isArray(m) ? m : []);
                for (const v of arr) s += Number(v ?? 0);
            }
            return s;
        };

        const groupToRow = (g: any, gi: number): number => {
            // 1) Power BI 分组名（分组通常按度量值排序，不能依赖数组位置）
            const groupName = MapDataService.normalizeRegionName(String(g?.name ?? ""));
            const nameRow = groupName ? nameToRow.get(groupName) : undefined;
            if (nameRow != null) return nameRow;
            // 2) 分组自身 identity
            const gKey = this.serializeIdentity(g?.identity);
            const identityRow = gKey ? identityToRow.get(gKey) : undefined;
            if (identityRow != null) return identityRow;
            // 3) identityFrom.map[0]（部分宿主直接提供分类行索引）
            const m0 = g?.identityFrom?.map?.[0];
            if (typeof m0 === "number" && m0 >= 0 && m0 < rowCount) return m0;
            // 4) 仅在缺少任何映射信息时按位置兜底
            return gi < rowCount ? gi : -1;
        };

        const mappedValues = valCol.values?.[0]?.values;
        const isMappedFlatValues = valCol.identityFrom?.map
            && Array.isArray(mappedValues)
            && mappedValues.every((v: any) => !v || typeof v !== "object" || !Array.isArray(v.values));
        if (isMappedFlatValues) {
            const idxMap: number[] = valCol.identityFrom.map;
            for (let j = 0; j < mappedValues.length; j++) {
                const idx = idxMap[j];
                if (idx != null && idx < rowCount) flatValues[idx] += Number(mappedValues[j] ?? 0);
            }
        } else if (Array.isArray(valCol.values)) {
            for (let gi = 0; gi < valCol.values.length; gi++) {
                const g = valCol.values[gi];
                const row = groupToRow(g, gi);
                if (row >= 0 && row < rowCount) flatValues[row] += sumGroup(g);
            }
        }

        return flatValues;
    }

    /** 序列化 Power BI identity 用于匹配（无法 JSON 化时返回 null） */
    private serializeIdentity(identity: any): string | null {
        if (identity == null) return null;
        try {
            const s = JSON.stringify(identity);
            return s && s !== "{}" ? s : String(identity);
        } catch (e) {
            return typeof identity === "object" ? null : String(identity);
        }
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
                .map((col) => ({
                    displayName: col.displayName,
                    value: this.formatValue(col.values[rowIdx], col.formatString)
                }))
        );
    }

    /**
     * 按实际分类、度量和工具提示内容生成稳定指纹。
     * 仅比较行数会把“行数相同但过滤内容已变”误判为重复更新。
     */
    private buildDataFingerprint(drillState: DrillState): string {
        let hash = 2166136261;
        const append = (value: any): void => {
            const text = value == null ? "<null>" : String(value);
            for (let i = 0; i < text.length; i++) {
                hash ^= text.charCodeAt(i);
                hash = Math.imul(hash, 16777619);
            }
            // 字段分隔符，避免 ["ab", "c"] 与 ["a", "bc"] 产生相同输入序列。
            hash ^= 31;
            hash = Math.imul(hash, 16777619);
        };

        append(drillState.level);
        append(drillState.parentName);
        for (const category of this.rawCatNames) {
            append(category.length);
            for (const name of category) append(name);
        }
        append(this.rawMeasureValues.length);
        for (const value of this.rawMeasureValues) append(value);
        append(this.measureFormatString);
        for (const column of this.tooltipColumns) {
            append(column.displayName);
            append(column.formatString);
            append(column.values.length);
            for (const value of column.values) append(value);
        }
        return `${this.rawCatNames.map((category) => category.length).join(",")}|${hash >>> 0}`;
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
                        const rawChinaGeo = await this.mapDataService.getGeoJSON(MapDataService.CHINA_ADCODE);
                        const chinaGeo = MapDataService.removeBuiltInSouthChinaSeaInset(rawChinaGeo);
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
                    if (targetAdcode === MapDataService.CHINA_ADCODE) {
                        geoJson = MapDataService.removeBuiltInSouthChinaSeaInset(geoJson);
                    }
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
            this.currentDrillProvinceName = drillState.parentName;
            this.currentDrillProvinceAdcode = targetAdcode;
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
        const provinceCodeMap = new Map<string, { value: number; index: number }>();
        const coreEntries: Array<{ core: string; value: number; index: number }> = [];

        dataPoints.forEach((dp, idx) => {
            const clean = dp.name.trim();
            const entry = { value: dp.value, index: idx };
            const provinceAdcode = MapDataService.getProvinceAdcode(clean);
            if (provinceAdcode) provinceCodeMap.set(provinceAdcode, entry);
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
            const geoAdcode = String(feature.properties?.adcode || feature.properties?.code || "");
            let matched = this.currentAdcode === MapDataService.CHINA_ADCODE && geoAdcode
                ? provinceCodeMap.get(geoAdcode)
                : undefined;
            if (!matched) matched = nameMap.get(geoName);
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
                    void this.handleLeafClick(this.currentDataPoints[dpIndex]);
                }
            }
        });
    }

    /**
     * 叶子层点击：三字段模式为区县，两字段模式为城市。
     * 若再次点击导致 selection 变空，自动恢复父级城市/省份多选，
     * 避免其他图表跳回全国数据。
     */
    private async handleLeafClick(dp: DataPoint): Promise<void> {
        if (!dp.selectionId) return;
        let selectedIds: powerbi.extensibility.ISelectionId[] = [];
        this.applyingDrillSelection = true;
        try {
            selectedIds = await this.selectionManager.select(dp.selectionId);
            this.drillSelectionActive = selectedIds.length > 0;
        } finally {
            this.applyingDrillSelection = false;
        }
        if (!this.drillSelectionActive) {
            await this.restoreCurrentLevelLinkage();
        }
    }

    /** 按当前下钻层级重新应用对应的整区域多选（恢复表格联动） */
    private async restoreCurrentLevelLinkage(): Promise<void> {
        if (this.lastRenderedLevel === 3 && this.currentDrillParentName) {
            if (this.currentDrillIsMunicipality) {
                await this.selectProvinceMulti(MapDataService.normalizeRegionName(this.currentDrillParentName));
            } else {
                await this.selectCityMulti(this.currentDrillParentName);
            }
            return;
        }
        if (this.level2ParentName) {
            await this.selectProvinceMulti(MapDataService.normalizeRegionName(this.level2ParentName));
        }
    }

    private async drillDownToProvince(provinceName: string): Promise<void> {
        if (!this.chart) return;
        // 仅配置省份时，省份就是叶子层：直接联动其他图表，再次点击正常取消。
        if (this.rawCatNames.length < 2) {
            await this.crossFilter(provinceName);
            return;
        }
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
            const sid = this.createRowSelectionId(info.firstIdx, 1);
            cityDataPoints.push({ name: cityName, value: info.total, selectionId: sid });
            minVal = Math.min(minVal, info.total);
            maxVal = Math.max(maxVal, info.total);
        });
        if (minVal === maxVal && cityDataPoints.length > 1) { minVal = maxVal > 0 ? 0 : maxVal - 1; maxVal = maxVal > 0 ? maxVal * 1.1 : 1; }

        const adcode = await this.resolveAdcode(provinceName);
        if (!adcode) return;
        this.currentDrillProvinceName = provinceName;
        this.currentDrillProvinceAdcode = adcode;
        await this.loadAndRenderDrillMap(adcode, provinceName, 2, cityDataPoints, minVal, maxVal);
        // 联动表格：多选该省全部数据行，使表格过滤到整个省（数据指纹守卫保证地图不受影响）
        await this.selectProvinceMulti(normProvince);
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
            const sid = this.createRowSelectionId(info.firstIdx, 2);
            districtDataPoints.push({ name, value: info.total, selectionId: sid });
            minVal = Math.min(minVal, info.total);
            maxVal = Math.max(maxVal, info.total);
        });
        if (minVal === maxVal && districtDataPoints.length > 1) { minVal = maxVal > 0 ? 0 : maxVal - 1; maxVal = maxVal > 0 ? maxVal * 1.1 : 1; }

        const adcode = await this.resolveAdcode(provinceName);
        if (!adcode) return;
        // 直辖市无地级层，面包屑的"省份"层即该直辖市本身
        this.level2ParentName = provinceName;
        this.currentDrillProvinceName = provinceName;
        this.currentDrillProvinceAdcode = adcode;
        this.currentDrillIsMunicipality = true;
        await this.loadAndRenderDrillMap(adcode, provinceName, 3, districtDataPoints, minVal, maxVal);
        // 联动表格：多选该直辖市全部数据行
        await this.selectProvinceMulti(normProvince);
    }

    private async drillDownToCity(cityName: string): Promise<void> {
        if (!this.chart || this.rawCatNames.length < 3) {
            await this.crossFilter(cityName);
            return;
        }
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
        if (districtAgg.size === 0) {
            await this.crossFilter(cityName);
            return;
        }

        const districtDataPoints: DataPoint[] = [];
        let minVal = Infinity, maxVal = -Infinity;
        districtAgg.forEach((info, name) => {
            const sid = this.createRowSelectionId(info.firstIdx, 2);
            districtDataPoints.push({ name, value: info.total, selectionId: sid });
            minVal = Math.min(minVal, info.total);
            maxVal = Math.max(maxVal, info.total);
        });
        if (minVal === maxVal && districtDataPoints.length > 1) { minVal = maxVal > 0 ? 0 : maxVal - 1; maxVal = maxVal > 0 ? maxVal * 1.1 : 1; }

        let adcode = this.findRegionAdcodeFromMap(cityName, this.currentMapName);
        if (!adcode) adcode = await this.resolveAdcode(cityName);
        if (!adcode) {
            await this.crossFilter(cityName);
            return;
        }
        this.currentDrillIsMunicipality = false;
        this.currentDrillProvinceName = this.findProvinceOfCity(cityName) || this.currentDrillProvinceName;
        await this.loadAndRenderDrillMap(adcode, cityName, 3, districtDataPoints, minVal, maxVal);
        // 联动表格：多选该市全部数据行，使表格过滤到整个市
        await this.selectCityMulti(cityName);
    }

    private async crossFilter(name: string): Promise<void> {
        const dp = this.currentDataPoints.find(
            (d) => d.name === name || MapDataService.normalizeRegionName(d.name) === MapDataService.normalizeRegionName(name)
        );
        if (dp?.selectionId) await this.handleLeafClick(dp);
    }

    /** 多选该省全部数据行 → 表格等其他视觉过滤到整个省（而非单行） */
    private async selectProvinceMulti(normProvince: string): Promise<void> {
        if (this.rawCatNames.length < 1) return;
        const provinceNames = this.rawCatNames[0];
        const ids: powerbi.visuals.ISelectionId[] = [];
        for (let i = 0; i < provinceNames.length; i++) {
            if (MapDataService.normalizeRegionName(provinceNames[i]) !== normProvince) continue;
            const id = this.createRowSelectionId(i, 0);
            if (id) ids.push(id);
        }
        await this.applyDrillSelection(ids);
    }

    /** 多选该市全部数据行 → 表格等其他视觉过滤到整个市 */
    private async selectCityMulti(cityName: string): Promise<void> {
        if (this.rawCatNames.length < 2) return;
        const cityNames = this.rawCatNames[1];
        const normCity = MapDataService.normalizeRegionName(cityName);
        const ids: powerbi.visuals.ISelectionId[] = [];
        for (let i = 0; i < cityNames.length; i++) {
            if (MapDataService.normalizeRegionName(cityNames[i]) !== normCity) continue;
            const id = this.createRowSelectionId(i, 1);
            if (id) ids.push(id);
        }
        await this.applyDrillSelection(ids);
    }

    /** 应用下钻联动并记录选择状态，用于识别 Power BI 视觉对象头的“清除选择”。 */
    private async applyDrillSelection(ids: powerbi.visuals.ISelectionId[]): Promise<void> {
        if (ids.length === 0) return;
        this.drillSelectionActive = true;
        this.applyingDrillSelection = true;
        try {
            const selectedIds = await this.selectionManager.select(ids, false);
            this.drillSelectionActive = selectedIds.length > 0;
        } catch (error) {
            this.drillSelectionActive = false;
            console.warn("[ChinaMap] 应用联动选择失败:", error);
        } finally {
            this.applyingDrillSelection = false;
        }
    }

    /** Power BI 宿主清除 selection 时，恢复当前下钻区域的表格联动。 */
    private handleHostSelectionChanged(ids: powerbi.extensibility.ISelectionId[]): void {
        if (this.applyingDrillSelection || ids.length > 0) return;
        if (!this.drillSelectionActive || this.lastRenderedLevel < 2) return;
        void this.restoreCurrentLevelLinkage();
    }

    /** 同时兼容 table 与旧 categorical 映射的行选择标识 */
    private createRowSelectionId(rowIndex: number, categoryLevel: number): powerbi.visuals.ISelectionId | undefined {
        const builder = this.host.createSelectionIdBuilder();
        if (this.rawTable) {
            return builder.withTable(this.rawTable, rowIndex).createSelectionId();
        }
        if (this.rawCatColumns.length === 0) return undefined;
        const lastLevel = Math.min(categoryLevel, this.rawCatColumns.length - 1);
        for (let level = 0; level <= lastLevel; level++) {
            builder.withCategory(this.rawCatColumns[level], rowIndex);
        }
        return builder.createSelectionId();
    }

    /** 从缓存分类列中查找某城市所属的省份名 */
    private findProvinceOfCity(cityName: string): string | null {
        if (this.rawCatNames.length < 2) return null;
        const provinceNames = this.rawCatNames[0];
        const cityNames = this.rawCatNames[1];
        const normCity = MapDataService.normalizeRegionName(cityName);
        for (let i = 0; i < cityNames.length; i++) {
            if (MapDataService.normalizeRegionName(cityNames[i]) === normCity) {
                return provinceNames[i];
            }
        }
        return null;
    }

    private async resolveAdcode(regionName: string): Promise<string | null> {
        const adcode = this.findRegionAdcodeFromMap(regionName, this.currentMapName);
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
            this.currentDrillParentName = parentName;
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
            prov.textContent = this.currentDrillProvinceName || this.level2ParentName || "省份";
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

    /** 清理只属于内部下钻的导航和联动状态。 */
    private resetDrillTracking(): void {
        this.currentAdcode = MapDataService.CHINA_ADCODE;
        const fmt = this.getFormatConfig();
        this.currentMapName = fmt.southChinaSeaMode === "inset" ? "china_no_scs" : "china";
        this.lastRenderedLevel = 0;
        this.previousDataKey = "";
        this.dataFingerprint = "";
        this.currentDrillParentName = "";
        this.currentDrillProvinceName = "";
        this.currentDrillProvinceAdcode = "";
        this.currentDrillIsMunicipality = false;
        this.level2DataPoints = [];
        this.level2ParentName = "";
        this.drillSelectionActive = false;
        this.breadcrumbElement.style.display = "none";
    }

    private navigateToLevel1(): void {
        if (!this.chart) return;
        this.resetDrillTracking();
        this.lastRenderedLevel = 1;
        void this.selectionManager.clear();
        const data = this.level1DataPoints.length > 0 ? this.level1DataPoints : this.currentDataPoints;
        if (data.length > 0) {
            const state = this.buildRestoreState(1, "", data);
            this.chart.clear();
            this.chart.setOption(this.buildEChartsOption(state), true);
            this.bindChartEvents();
        }
    }

    private async navigateToLevel2(): Promise<void> {
        if (!this.chart) return;
        // 直辖市无地级层，"省份"层即区县层，回退到全国
        if (this.currentDrillIsMunicipality) { this.navigateToLevel1(); return; }

        const provinceName = this.currentDrillProvinceName || this.level2ParentName;
        if (!provinceName || this.level2DataPoints.length === 0) { this.navigateToLevel1(); return; }

        const adcode = this.currentDrillProvinceAdcode
            || this.findRegionAdcodeFromMap(provinceName, "china")
            || this.findRegionAdcodeFromMap(provinceName, this.currentMapName);
        if (!adcode) { this.navigateToLevel1(); return; }
        const mapName = `map_${adcode}`;
        if (!(echarts as any).getMap(mapName)) {
            try {
                echarts.registerMap(mapName, await this.mapDataService.getGeoJSON(adcode));
                this.registeredMaps.add(adcode);
            } catch (error) {
                this.showOverlay(`加载地图数据失败: ${error.message}`, true);
                return;
            }
        }
        this.currentAdcode = adcode;
        this.currentMapName = mapName;
        this.lastRenderedLevel = 2;
        this.currentDrillParentName = provinceName;
        this.previousDataKey = `2|${this.level2DataPoints.length}|${provinceName}`;
        await this.selectProvinceMulti(MapDataService.normalizeRegionName(provinceName));
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
    private updateMeasureMetadata(column?: DataViewMetadataColumn): void {
        this.measureDisplayName = column?.displayName || "数值";
        this.measureFormatString = this.getColumnFormatString(column);
    }

    private getColumnFormatString(column?: DataViewMetadataColumn): string {
        if (!column) return "#,0.##";
        return valueFormatter.getFormatString(
            column,
            { objectName: "general", propertyName: "formatString" }
        ) || column.format || "#,0.##";
    }

    private formatValue(value: any, formatString?: string): string {
        if (value == null) return "";
        return valueFormatter.format(
            value,
            formatString || "#,0.##",
            false,
            this.host.locale
        );
    }

    private getMeasureName(): string { return this.measureDisplayName; }
    private formatNumber(value: number): string {
        if (value == null || isNaN(value)) return "0";
        return this.formatValue(value, this.measureFormatString);
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
