const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Load the production TypeScript with only the Power BI/DOM boundaries mocked.
const cache = new Map();
const charts = new Map();
const sdk = { VisualUpdateType: { Data: 2, Resize: 4, ResizeEnd: 32 }, FilterAction: { merge: 0, remove: 1 } };
function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file);
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const module = { exports: {} };
    const resolve = (id) => {
        if (id.endsWith('.less')) return {};
        if (id === 'powerbi-visuals-api') return { default: sdk };
        if (id === 'echarts') return { getMap: (name) => charts.get(name), registerMap: (name, geoJSON) => charts.set(name, { geoJSON }) };
        if (id === 'powerbi-visuals-utils-formattingutils') return { valueFormatter: { format: String, getFormatString: (column) => column.format } };
        if (id === 'powerbi-visuals-utils-formattingmodel') return { FormattingSettingsService: class {} };
        if (id === './settings') return { VisualFormattingSettingsModel: class {} };
        if (id.endsWith('.json')) return JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), id), 'utf8'));
        if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id + '.ts'));
        throw new Error(`Unexpected import: ${id}`);
    };
    vm.runInNewContext(output, { module, exports: module.exports, require: resolve, console, setTimeout, clearTimeout }, { filename: file });
    cache.set(file, module.exports);
    return module.exports;
}
const { Visual } = load('src/visual.ts');
const { numericValue, addValues } = load('src/numeric.ts');
function visual() {
    const v = Object.create(Visual.prototype);
    Object.assign(v, {
        host: { locale: 'zh-CN', hostCapabilities: {}, createSelectionIdBuilder() {
            const builder = { withTable: () => builder, withCategory: () => builder, createSelectionId: () => ({ key: 'row' }) };
            return builder;
        } },
        rawCatNames: [], rawMeasureValues: [], tooltipColumns: [], rawCatColumns: [],
        currentMapName: 'china', currentAdcode: '100000', registeredMaps: new Set(),
        renderRevision: 0, lastRenderedLevel: 1,
    });
    return v;
}
function table(rows) {
    return { columns: ['province', 'city', 'measure', 'tooltips'].map(role => ({ roles: { [role]: true }, displayName: role, queryName: `Data.${role}` })), rows };
}
test('BLANK, invalid and infinite values remain missing; zero is real', () => {
    for (const value of [null, undefined, '', '12', true, Infinity, -Infinity, NaN]) assert.ok(Number.isNaN(numericValue(value)));
    assert.equal(numericValue(0), 0);
    assert.equal(addValues(NaN, 0), 0);
    assert.ok(Number.isNaN(addValues(NaN, NaN)));
    assert.equal(addValues(10, -3), 7);
});
test('province aggregate sums all tooltip rows and retains all-BLANK regions', () => {
    const v = visual();
    const state = v.parseTableData(table([
        ['广东省', '广州市', 10, 2], ['广东省', '深圳市', 20, 3],
        ['浙江省', '杭州市', null, null], ['北京市', '北京市', 0, 0],
    ]));
    assert.equal(state.dataPoints[0].value, 30);
    assert.equal(state.dataPoints[0].tooltips[0].value, '5');
    assert.ok(Number.isNaN(state.dataPoints[1].value));
    assert.equal(state.dataPoints[2].value, 0);
    assert.equal(state.minValue, 0);
    assert.equal(state.maxValue, 30);
});
test('all-BLANK groups have finite legend range', () => {
    const state = visual().parseTableData(table([['广东省', '广州市', null, null], ['浙江省', '杭州市', null, null]]));
    assert.equal(state.minValue, 0);
    assert.equal(state.maxValue, 1);
});
test('missing-region ECharts dataIndex never selects an unrelated row', () => {
    const v = visual();
    v.currentDataPoints = [{ name: '广东', value: 1 }];
    assert.equal(v.getDataPointFromEvent({ dataIndex: 0 }), undefined);
    assert.equal(v.getDataPointFromEvent({ data: { _index: 0 } }), v.currentDataPoints[0]);
});
test('hiding legend preserves the color mapping', () => {
    const v = visual();
    v.formattingSettings = { mapConfigCard: { showLegend: { value: false } } };
    const option = v.buildEChartsOption({ level: 1, dataPoints: [], minValue: 0, maxValue: 10 });
    assert.equal(option.visualMap.show, false);
    assert.equal(option.visualMap.max, 10);
    assert.equal(option.animation, false);
});
test('format-only update redraws at current drill level', async () => {
    const v = visual();
    let refreshed = 0;
    v.formattingSettingsService = { populateFormattingSettingsModel: () => ({}) };
    v.parseDataView = () => ({ level: 1, dataPoints: [{ value: 1 }] });
    v.buildDataFingerprint = () => 'same';
    v.dataFingerprint = 'same'; v.lastRenderedLevel = 3;
    v.selectionManager = { getSelectionIds: () => [] };
    v.refreshCurrentMap = () => refreshed++;
    await v.updateView({ type: 16, dataViews: [{ metadata: { objects: { labels: true } } }] });
    assert.equal(refreshed, 1);
    assert.equal(v.lastRenderedLevel, 3);
});
test('render events finish only after asynchronous rendering; failure emits only failed', async () => {
    const v = visual();
    const events = [];
    v.host.eventService = { renderingStarted: () => events.push('start'), renderingFinished: () => events.push('finish'), renderingFailed: () => events.push('fail') };
    let resolve;
    v.updateView = () => new Promise(done => { resolve = done; });
    v.update({});
    assert.deepEqual(events, ['start']);
    resolve(); await new Promise(done => setImmediate(done));
    assert.deepEqual(events, ['start', 'finish']);
    v.showOverlay = () => {};
    v.updateView = async () => { throw new Error('offline'); };
    v.update({}); await new Promise(done => setImmediate(done));
    assert.deepEqual(events, ['start', 'finish', 'start', 'fail']);
});
test('context menu receives mapped data identity and viewport coordinates', () => {
    const v = visual(); const handlers = new Map(); const calls = [];
    v.chart = { off: () => {}, on: (name, selector, handler) => handlers.set(name, handler || selector) };
    const identity = { key: 'guangdong' };
    v.currentDataPoints = [{ selectionId: identity }];
    v.selectionManager = { showContextMenu: (...args) => calls.push(args) };
    v.bindChartEvents();
    handlers.get('contextmenu')({ data: { _index: 0 }, event: { event: { clientX: 12, clientY: 34, preventDefault() {} } } });
    assert.equal(calls[0][0], identity);
    assert.equal(calls[0][1].x, 12);
});
test('aggregate context menu never targets just the first child', () => {
    const v = visual(); const handlers = new Map(); let received;
    v.chart = { off: () => {}, on: (name, selector, handler) => handlers.set(name, handler || selector) };
    v.currentDataPoints = [{ selectionId: { key: 'first' }, rowIndices: [0, 1] }];
    v.selectionManager = { showContextMenu: (identity) => { received = identity; } };
    v.bindChartEvents();
    handlers.get('contextmenu')({ data: { _index: 0 }, event: { event: { clientX: 0, clientY: 0, preventDefault() {} } } });
    assert.equal(Object.keys(received).length, 0);
});
test('removing fields clears stale map and pending loading state', async () => {
    const v = visual(); let cleared = 0;
    v.chart = { clear: () => cleared++ };
    v.breadcrumbElement = { style: {} };
    v.hideHostTooltip = () => {};
    v.showOverlay = () => {};
    await v.updateView({ dataViews: [] });
    assert.equal(cleared, 1);
    assert.equal(v.currentState, null);
    assert.equal(v.currentDataPoints.length, 0);
    assert.equal(v.renderRevision, 1);
});
test('truncated data is not presented as a complete aggregate', async () => {
    const v = visual(); let message;
    v.chart = { clear: () => {} };
    v.breadcrumbElement = { style: {} };
    v.hideHostTooltip = () => {};
    v.showOverlay = text => { message = text; };
    v.formattingSettingsService = { populateFormattingSettingsModel: () => ({}) };
    await v.updateView({ type: 2, dataViews: [{ metadata: { segment: {} } }] });
    assert.match(message, /数据未完整加载/);
    assert.equal(v.currentDataPoints.length, 0);
});

function interactiveVisual(roles, rows) {
    const v = visual();
    const handlers = new Map();
    const filters = [];
    const selections = [];
    v.chart = { off() {}, on(name, selector, handler) { handlers.set(name, handler || selector); } };
    v.host.applyJsonFilter = (filter, object, property, action) => filters.push({ filter, object, property, action });
    v.selectionManager = {
        getSelectionIds: () => selections,
        clear: async () => { selections.length = 0; return []; },
        select: async id => { selections.splice(0, selections.length, ...(Array.isArray(id) ? id : [id])); return selections; },
    };
    v.currentDataPoints = v.parseTableData({
        columns: roles.map(role => ({ roles: { [role]: true }, displayName: role, queryName: `Data.${role}` })), rows,
    }).dataPoints;
    v.resolveAdcode = async () => '230000';
    v.loadAndRenderDrillMap = async (_code, parent, level, points) => {
        v.currentDataPoints = points; v.lastRenderedLevel = level;
        v.currentDrillParentName = parent;
        if (level === 2) { v.level2ParentName = parent; v.level2DataPoints = points; }
    };
    v.bindChartEvents();
    const click = async name => {
        const index = v.currentDataPoints.findIndex(point => point.name === name);
        handlers.get('click')({ name, data: { _index: index } });
        await new Promise(done => setImmediate(done));
    };
    return { v, filters, selections, click };
}

test('province-only click filters province; repeat clears; switching selects new province', async () => {
    const { v, filters, click } = interactiveVisual(['province', 'measure'], [['黑龙江省', 30], ['吉林省', 20]]);
    await click('黑龙江省');
    assert.equal(filters.at(-1)?.filter?.[0].target.column, 'province');
    assert.equal(filters.at(-1).filter[0].values[0], '黑龙江省');
    await click('黑龙江省');
    assert.equal(filters.at(-1).action, sdk.FilterAction.remove);
    assert.equal(filters.at(-1).filter, null);
    await click('黑龙江省'); await click('吉林省');
    assert.equal(filters.at(-1).filter[0].values[0], '吉林省');
    assert.equal(v.lastRenderedLevel, 1);
});

test('province+city: Heilongjiang drill then city filters; repeat restores province', async () => {
    const { v, filters, click } = interactiveVisual(['province', 'city', 'measure'], [
        ['黑龙江省', '哈尔滨市', 10], ['黑龙江省', '大庆市', 20], ['吉林省', '长春市', 30],
    ]);
    await click('黑龙江省');
    assert.equal(v.lastRenderedLevel, 2);
    assert.equal(filters.at(-1).filter[0].values[0], '黑龙江省');
    await click('哈尔滨市');
    assert.equal(filters.at(-1).filter.length, 2);
    assert.equal(filters.at(-1).filter[1].target.column, 'city');
    assert.equal(filters.at(-1).filter[1].values[0], '哈尔滨市');
    await click('大庆市');
    assert.equal(filters.at(-1).filter[1].values[0], '大庆市');
    await click('大庆市');
    assert.equal(filters.at(-1).filter.length, 1);
    assert.equal(filters.at(-1).filter[0].values[0], '黑龙江省');
    assert.equal(v.lastRenderedLevel, 2);
});

test('tooltip contains only region and measures, without aggregation explanation', () => {
    const v = visual(); v.rawCatNames = [['黑龙江省'], ['哈尔滨市']];
    v.measureDisplayName = '销售额';
    const items = v.buildHostTooltipData({ name: '黑龙江省', value: 10, tooltips: [{ displayName: '订单数', value: '2' }] });
    assert.deepEqual(Array.from(items, item => item.displayName), ['省份数据', '销售额', '订单数']);
});

test('district single-row leaf uses saved scalar identity; deselection restores city filter', async () => {
    const { v, filters } = interactiveVisual(['province', 'city', 'district', 'measure'], [
        ['黑龙江省', '哈尔滨市', '道里区', 10], ['黑龙江省', '哈尔滨市', '南岗区', 20],
        ['吉林省', '长春市', '南关区', 30],
    ]);
    v.lastRenderedLevel = 3;
    v.districtFilterTarget = null; // Legacy metadata fallback only.
    v.currentDrillParentName = '哈尔滨市';
    v.currentDrillProvinceName = '黑龙江省';
    const identity = { key: 'daoli' };
    const calls = [];
    v.selectionManager.select = async (id, multi) => {
        calls.push({ id, multi });
        return calls.length === 1 ? [id] : [];
    };
    const point = { name: '道里区', selectionId: identity, rowIndices: [0] };
    await v.handleLeafClick(point);
    assert.equal(calls[0].id, identity);
    assert.equal(calls[0].multi, false);
    await v.handleLeafClick(point);
    assert.equal(filters.at(-1).filter[0].values[0], '黑龙江省');
    assert.equal(filters.at(-1).filter[1].values[0], '哈尔滨市');
    assert.equal(v.lastRenderedLevel, 3);
});

test('three-level click route filters district, switches district and restores city', async () => {
    const { v, filters, click } = interactiveVisual(['province', 'city', 'district', 'measure'], [
        ['黑龙江省', '哈尔滨市', '道里区', 10], ['黑龙江省', '哈尔滨市', '南岗区', 20],
        ['黑龙江省', '大庆市', '萨尔图区', 30], ['吉林省', '长春市', '南关区', 40],
    ]);
    v.findRegionAdcodeFromMap = () => '230100';
    await click('黑龙江省');
    await click('哈尔滨市');
    assert.equal(v.lastRenderedLevel, 3);
    await click('道里区');
    assert.deepEqual(Array.from(filters.at(-1).filter, f => [f.target.column, f.values[0]]),
        [['province', '黑龙江省'], ['city', '哈尔滨市'], ['district', '道里区']]);
    await click('南岗区');
    assert.equal(filters.at(-1).filter[2].values[0], '南岗区');
    await click('南岗区');
    assert.equal(filters.at(-2).action, sdk.FilterAction.remove);
    assert.deepEqual(Array.from(filters.at(-1).filter, f => f.values[0]), ['黑龙江省', '哈尔滨市']);
    assert.equal(v.lastRenderedLevel, 3);
    await click('道里区');
    await v.applyHierarchyFilter('黑龙江省');
    assert.equal(filters.at(-2).action, sdk.FilterAction.remove);
    assert.equal(filters.at(-1).filter.length, 1);
});

test('municipality district click filters all three columns; cancel restores municipality', async () => {
    const { v, filters, click } = interactiveVisual(['province', 'city', 'district', 'measure'], [
        ['北京市', '北京市', '海淀区', 10], ['北京市', '北京市', '朝阳区', 20],
        ['黑龙江省', '哈尔滨市', '道里区', 30],
    ]);
    await click('北京市');
    assert.equal(v.lastRenderedLevel, 3);
    await click('海淀区');
    assert.deepEqual(Array.from(filters.at(-1).filter, f => f.values[0]), ['北京市', '北京市', '海淀区']);
    await click('海淀区');
    assert.equal(filters.at(-1).filter.length, 1);
    assert.equal(filters.at(-1).filter[0].values[0], '北京市');
});

test('province selection falls back to original scalar path if query metadata is missing', async () => {
    const { v, selections, click } = interactiveVisual(['province', 'measure'], [['黑龙江省', 10], ['吉林省', 20]]);
    v.provinceFilterTarget = null;
    const savedIdentity = v.currentDataPoints[0].selectionId;
    await click('黑龙江省');
    assert.equal(selections[0], savedIdentity);
});

test('city filter keeps the original value and its province, not another matching city', async () => {
    const { v, filters } = interactiveVisual(['province', 'city', 'measure'], [
        ['省甲', '同名市', 10], ['省乙', '同名市', 20],
    ]);
    v.lastRenderedLevel = 2;
    await v.handleLeafClick({ name: '同名市', rowIndices: [1], selectionId: { key: 'b' } });
    assert.equal(filters.at(-1).filter[0].values[0], '省乙');
    assert.equal(filters.at(-1).filter[1].values[0], '同名市');
});
