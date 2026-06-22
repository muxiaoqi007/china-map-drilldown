/**
 * 视觉设置模型 - 定义格式面板的配置项
 */

"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsSlice = formattingSettings.Slice;
import FormattingSettingsModel = formattingSettings.Model;

/**
 * 地图配色卡片
 */
class MapColorCardSettings extends FormattingSettingsCard {
    minColor = new formattingSettings.ColorPicker({
        name: "minColor",
        displayName: "最小值颜色",
        value: { value: "#e0f3f8" }
    });

    maxColor = new formattingSettings.ColorPicker({
        name: "maxColor",
        displayName: "最大值颜色",
        value: { value: "#045a8d" }
    });

    bgColor = new formattingSettings.ColorPicker({
        name: "bgColor",
        displayName: "背景色",
        value: { value: "#f0f5fa" }
    });

    borderColor = new formattingSettings.ColorPicker({
        name: "borderColor",
        displayName: "边界颜色",
        value: { value: "#d4d4d4" }
    });

    minValue = new formattingSettings.NumUpDown({
        name: "minValue",
        displayName: "最小值（留空自动计算）",
        value: 0
    });

    maxValue = new formattingSettings.NumUpDown({
        name: "maxValue",
        displayName: "最大值（留空自动计算）",
        value: 0
    });

    name: string = "mapColor";
    displayName: string = "地图配色";
    slices: Array<FormattingSettingsSlice> = [
        this.minColor,
        this.maxColor,
        this.bgColor,
        this.borderColor,
        this.minValue,
        this.maxValue
    ];
}

/**
 * 标签设置卡片
 */
class MapLabelsCardSettings extends FormattingSettingsCard {
    show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "显示标签",
        value: true
    });

    fontSize = new formattingSettings.NumUpDown({
        name: "fontSize",
        displayName: "字号",
        value: 12
    });

    fontColor = new formattingSettings.ColorPicker({
        name: "fontColor",
        displayName: "字体颜色",
        value: { value: "#333333" }
    });

    showValue = new formattingSettings.ToggleSwitch({
        name: "showValue",
        displayName: "显示数值",
        value: false
    });

    name: string = "mapLabels";
    displayName: string = "标签设置";
    slices: Array<FormattingSettingsSlice> = [
        this.show,
        this.fontSize,
        this.fontColor,
        this.showValue
    ];
}

/**
 * 提示框卡片
 */
class MapTooltipCardSettings extends FormattingSettingsCard {
    show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "显示提示框",
        value: true
    });

    name: string = "mapTooltip";
    displayName: string = "提示框";
    slices: Array<FormattingSettingsSlice> = [this.show];
}

/**
 * 地图配置卡片
 */
class MapConfigCardSettings extends FormattingSettingsCard {
    roam = new formattingSettings.ToggleSwitch({
        name: "roam",
        displayName: "允许缩放和平移",
        value: true
    });

    showLegend = new formattingSettings.ToggleSwitch({
        name: "showLegend",
        displayName: "显示图例条",
        value: true
    });

    showBreadcrumb = new formattingSettings.ToggleSwitch({
        name: "showBreadcrumb",
        displayName: "显示面包屑导航",
        value: true
    });

    southChinaSeaMode = new formattingSettings.ItemDropdown({
        name: "southChinaSeaMode",
        displayName: "南海诸岛显示方式",
        items: [
            { displayName: "完整显示", value: "full" },
            { displayName: "小图显示", value: "inset" }
        ],
        value: { displayName: "完整显示", value: "full" } as any
    });

    name: string = "mapConfig";
    displayName: string = "地图配置";
    slices: Array<FormattingSettingsSlice> = [
        this.roam,
        this.showLegend,
        this.showBreadcrumb,
        this.southChinaSeaMode
    ];
}

/**
 * 视觉设置模型
 */
export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    mapColorCard = new MapColorCardSettings();
    mapLabelsCard = new MapLabelsCardSettings();
    mapTooltipCard = new MapTooltipCardSettings();
    mapConfigCard = new MapConfigCardSettings();

    cards = [
        this.mapColorCard,
        this.mapLabelsCard,
        this.mapTooltipCard,
        this.mapConfigCard
    ];
}
