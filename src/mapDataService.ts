/**
 * 地图数据服务 - 负责获取和缓存 GeoJSON 地图数据
 * 数据源：阿里云 DataV.GeoAtlas（高德开放数据）
 */

export interface DrillState {
    /** 当前层级：1=全国, 2=省内城市, 3=市内区县 */
    level: number;
    /** 父级名称（如 "广东省"、"深圳市"） */
    parentName: string;
    /** 父级行政区划代码 */
    parentAdcode: string;
    /** 当前层级的 ECharts 地图名称 */
    mapName: string;
    /** 当前层级的数据点 */
    dataPoints: DataPoint[];
    /** 数据最小值 */
    minValue: number;
    /** 数据最大值 */
    maxValue: number;
}

export interface DataPoint {
    /** 区域名称 */
    name: string;
    /** 度量值 */
    value: number;
    /** Power BI 选择标识（用于交互） */
    selectionId?: powerbi.visuals.ISelectionId;
    /** 原始数据行索引 */
    identity?: powerbi.visuals.ISelectionId;
    /** 工具提示字段 */
    tooltips?: Array<{ displayName: string; value: string }>;
}

export class MapDataService {
    private cache: Map<string, any> = new Map();

    /** 全国地图行政区划代码 */
    static readonly CHINA_ADCODE = "100000";

    /** DataV GeoAtlas API 基础 URL */
    static readonly GEO_API_BASE = "https://geo.datav.aliyun.com/areas_v3/bound";

    constructor() {
        // 无需额外初始化
    }

    /**
     * 根据行政区划代码获取 GeoJSON 数据
     * @param adcode 行政区划代码
     * @returns GeoJSON 对象
     */
    async getGeoJSON(adcode: string): Promise<any> {
        // 先查缓存
        if (this.cache.has(adcode)) {
            return this.cache.get(adcode);
        }

        const url = `${MapDataService.GEO_API_BASE}/${adcode}_full.json`;

        try {
            const geoJson = await this.fetchJSON(url);
            this.cache.set(adcode, geoJson);
            return geoJson;
        } catch (error) {
            console.error(`获取地图数据失败 (adcode: ${adcode}):`, error);
            throw new Error(`无法获取地图数据，请检查网络连接。行政区划代码: ${adcode}`);
        }
    }

    /**
     * 清空缓存
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * 从 features 中提取区域名称与 adcode 的映射
     */
    static extractAdcodeMap(features: any[]): Map<string, string> {
        const map = new Map<string, string>();
        if (!features) return map;

        for (const feature of features) {
            const name = feature.properties?.name;
            const adcode = String(feature.properties?.adcode || "");
            if (name && adcode) {
                map.set(name, adcode);
            }
        }
        return map;
    }

    /**
     * 标准化区域名称，用于模糊匹配
     * 去除常见的行政区后缀
     */
    static normalizeRegionName(name: string): string {
        if (!name) return "";
        return name
            .replace(/(省|市|自治区|特别行政区|壮族|回族|维吾尔|藏族)/g, "")
            .trim();
    }

    /**
     * 过滤南海诸岛相关 features，同时提取南海特征供小图使用
     *
     * DataV 100000_full.json 中南海诸岛分布在两处:
     *   1. 独立特征: adcode="100000_JD", name=""（九段线区域，10 个多边形）
     *   2. 海南省 (460000) 几何体内: 133 个多边形中 129 个是南海岛屿 (minLat < 18)
     *
     * 返回:
     *   cleanedGeoJson - 移除南海的主地图 GeoJSON（海南省只保留本岛）
     *   scsFeatures    - 南海诸岛特征数组，用于右下角小图
     */
    static filterSouthChinaSea(geoJson: any): { cleanedGeoJson: any; scsFeatures: any[] } {
        if (!geoJson?.features) return { cleanedGeoJson: geoJson, scsFeatures: [] };

        const scsFeatures: any[] = [];
        const cleanedFeatures: any[] = [];

        for (const f of geoJson.features) {
            const adcode = String(f.properties?.adcode || "");
            const name: string = f.properties?.name || "";

            // ── 1. 完全移除：100000_JD（九段线独立特征）──
            if (adcode === "100000_JD" || adcode.endsWith("_JD")
                || (name === "" && adcode.includes("_"))) {
                scsFeatures.push(f);
                continue;
            }

            // ── 2. 完全移除：其他南海关键词特征 ──
            if (adcode === "469025" || adcode === "460300" || adcode.startsWith("4690")
                || name.includes("南海") || name.includes("诸岛")
                || name.includes("十段线") || name.includes("九段线")
                || name.includes("三沙") || name.includes("南沙")
                || name.includes("西沙") || name.includes("中沙")
                || name.includes("东沙")) {
                scsFeatures.push(f);
                continue;
            }

            // ── 3. 海南省 (460000): 裁剪南海岛屿多边形，保留海南本岛 ──
            if (adcode === "460000" && f.geometry?.type === "MultiPolygon") {
                const mainlandPolygons: any[] = [];
                const scsPolygons: any[] = [];

                for (const polygon of f.geometry.coordinates) {
                    let minLat = 90;
                    for (const ring of polygon) {
                        for (const coord of ring) {
                            if (coord[1] < minLat) minLat = coord[1];
                        }
                    }
                    // 海南本岛纬度 > 18°N，南海岛屿纬度 < 18°N
                    if (minLat >= 18) {
                        mainlandPolygons.push(polygon);
                    } else {
                        scsPolygons.push(polygon);
                    }
                }

                // 主地图：海南省只保留本岛多边形
                if (mainlandPolygons.length > 0) {
                    cleanedFeatures.push({
                        ...f,
                        geometry: { ...f.geometry, coordinates: mainlandPolygons }
                    });
                }

                // 小图：收集被裁剪的南海多边形
                if (scsPolygons.length > 0) {
                    scsFeatures.push({
                        ...f,
                        geometry: { ...f.geometry, coordinates: scsPolygons }
                    });
                }

                console.log(`[SCS filter] 海南省: 保留 ${mainlandPolygons.length} 个本岛多边形, ` +
                    `移除 ${scsPolygons.length} 个南海岛屿多边形`);
                continue;
            }

            // ── 4. 正常省份：保留 ──
            cleanedFeatures.push(f);
        }

        console.log(`[SCS filter] features: ${geoJson.features.length} → ${cleanedFeatures.length}, ` +
            `scsFeatures: ${scsFeatures.length}`);

        return {
            cleanedGeoJson: { ...geoJson, features: cleanedFeatures },
            scsFeatures
        };
    }

    /**
     * 使用 fetch API 获取 JSON 数据
     */
    private async fetchJSON(url: string): Promise<any> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.json();
    }
}
