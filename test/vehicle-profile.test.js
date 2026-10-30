/** 车辆识别（按 PROXI 位图过滤模块清单）自测：node test/vehicle-profile.test.js */
import fs from 'fs';
import { buildVehicleProfile, ENGINE_OF_MODULE, MARKER_NODES } from '../src/vehicle-profile.js';

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const mods = JSON.parse(fs.readFileSync(new URL('../src/data/modules.json', import.meta.url), 'utf8'));
const nodes = mods.alignmentNodes;
const modsList = mods.modules;

const nodeOf = (re) => nodes.find((n) => re.test(String(n.name).trim()));
const ecm = nodeOf(MARKER_NODES.ecm);
const ecm2 = nodeOf(MARKER_NODES.ecm2);
const scr = nodeOf(MARKER_NODES.scr);

const maskOf = (n) => parseInt(n.bitMask, 16);
const putCfg = (d1, n) => { d1[41 - n.startByte] |= maskOf(n); };
const putAct = (d3, n) => { d3[48 - n.startByte] |= maskOf(n); };
const mk = () => ({ d1: new Uint8Array(289), d3: new Uint8Array(80) });

/** 按节点名列表铺设位图（模拟一台车） */
function carWith(names, { platform = '952', actual = true, configured = true } = {}) {
    const b = mk();
    for (const name of names) {
        const n = nodes.find((x) => x.name === name);
        if (!n) throw new Error('节点不存在：' + name);
        if (configured) putCfg(b.d1, n);
        if (actual) putAct(b.d3, n);
    }
    return buildVehicleProfile({ platform, data1: b.d1, data3: b.d3, modules: modsList, nodes });
}

const profile = (names, opts) => carWith(names, opts);

const BCM = 'Body Computer Node (BCM/NBC)';
const IPC = 'Dashboard Node (IPC/NQS)';
const ABS = 'Brake System Node (ABS/BSM/NFR)';
const EPS = 'Electric Steering Node (EPS/NGE)';
const SGW = 'Security Gateway Module (SGW)';

console.log('数据自检：判据节点与地址映射');
{
    check('ECM 节点存在', !!ecm, JSON.stringify(ecm));
    check('ECM2 节点存在', !!ecm2, JSON.stringify(ecm2));
    check('SCRM 节点存在', !!scr, JSON.stringify(scr));
    check('ECM 地址 = 0x10（与 2.0/2.2/V6 主 ECU 同址）', String(ecm.addr).toUpperCase() === '10', String(ecm.addr));
    check('ECM2 地址 = 0x17（V6 副 ECU）', String(ecm2.addr).toUpperCase() === '17', String(ecm2.addr));
    check('SCRM 地址 = 0x01（AdBlue）', String(scr.addr).toUpperCase() === '01', String(scr.addr));

    // 每个模块都能按地址找到节点（否则说明模块表里有本工具不认识的新模块 → 该模块会一直显示）
    const un = buildVehicleProfile({
        platform: '952', data1: new Uint8Array(289), data3: new Uint8Array(80),
        modules: modsList, nodes,
    }).rows.filter((r) => r.reason === 'unmapped');
    check('所有模块都能按诊断地址映射到节点', un.length === 0, un.map((r) => `${r.code}(tx=${r.tx})`).join(', '));

    // 发动机家族只覆盖 4 个模块，且与模块表一致
    const engCodes = Object.keys(ENGINE_OF_MODULE).sort().join(',');
    check('发动机家族模块 = 4 个', engCodes === 'IAW10JAX,JTDM23GP,MED17.3.5,MED17.3.5S', engCodes);
}

console.log('\n2.0 汽油车（单 ECM、无 SCR、无 ECM2）');
{
    const p = profile([BCM, IPC, ABS, EPS, SGW, ecm.name]);
    check('识别为 2.0', p.engine === '2.0', p.engine);
    check('判据来源 single-ecm', p.engineSource === 'single-ecm', p.engineSource);
    check('置信度 medium（可手动改）', p.confidence === 'medium', p.confidence);
    const vis = new Set(p.visible.map((r) => r.code));
    check('显示 2.0 发动机', vis.has('IAW10JAX'), [...vis].join(','));
    check('隐藏 2.2 柴油', !vis.has('JTDM23GP'));
    check('隐藏 2.9 V6 主 ECU', !vis.has('MED17.3.5'));
    check('隐藏 2.9 V6 副 ECU', !vis.has('MED17.3.5S'));
    check('显示 ABS / EPS / 仪表 / 车身', vis.has('ABSMMKC1') && vis.has('EPSZFX1') && vis.has('DASH29') && vis.has('BODY33'), [...vis].join(','));
    check('SGW 在位 → 显示（它只是普通节点）', vis.has('PROXIX1'), [...vis].join(','));
    check('隐藏项数 = 未配置节点数（>0）', p.counts.hidden > 0, JSON.stringify(p.counts));
}

console.log('\n2.2 柴油车（有 SCR、无 ECM2）');
{
    const p = profile([BCM, IPC, ABS, ecm.name, scr.name], { platform: '952' });
    check('识别为 2.2', p.engine === '2.2', p.engine);
    check('判据来源 scr', p.engineSource === 'scr', p.engineSource);
    check('置信度 high', p.confidence === 'high', p.confidence);
    const vis = new Set(p.visible.map((r) => r.code));
    check('显示 2.2 柴油 ECU', vis.has('JTDM23GP'));
    check('显示 AdBlue 模块', vis.has('ADBLU1'));
    check('隐藏 2.0 汽油', !vis.has('IAW10JAX'));
    check('隐藏 2.9', !vis.has('MED17.3.5') && !vis.has('MED17.3.5S'));
}

console.log('\n2.9 V6（有 ECM2）');
{
    const p = profile([BCM, IPC, ABS, ecm.name, ecm2.name, scr.name], { platform: '952' });
    check('识别为 2.9（ECM2 优先于 SCR）', p.engine === '2.9' && p.engineSource === 'ecm2', `${p.engine}/${p.engineSource}`);
    const vis = new Set(p.visible.map((r) => r.code));
    check('显示主副两个 V6 ECU', vis.has('MED17.3.5') && vis.has('MED17.3.5S'), [...vis].join(','));
    check('隐藏 2.0 / 2.2', !vis.has('IAW10JAX') && !vis.has('JTDM23GP'));
    check('SCR 误置位也不会被当成柴油', p.engine === '2.9');
}

console.log('\n平台过滤：949 只留 Stelvio 专属');
{
    const p = profile([BCM, IPC, 'Power Lift Gate Node (PLGM)'], { platform: '949' });
    const vis = new Set(p.visible.map((r) => r.code));
    check('949 显示 BODY30', vis.has('BODY30'), [...vis].join(','));
    check('949 隐藏 BODY33', !vis.has('BODY33'));
    check('949 显示电动尾门 PLGM1', vis.has('PLGM1'), [...vis].join(','));
    check('952 隐藏 BODY30 / PLGM1', (() => {
        const q = profile([BCM, IPC], { platform: '952' });
        const v = new Set(q.visible.map((r) => r.code));
        return !v.has('BODY30') && !v.has('PLGM1');
    })());
}

console.log('\n在位判定：配置 ∪ 实际，未知模块不误伤');
{
    // 只在配置里（待移除）→ 仍可见，便于连上去查
    const b = mk(); putCfg(b.d1, nodes.find((n) => n.name === ABS));
    const p = buildVehicleProfile({ platform: '952', data1: b.d1, data3: b.d3, modules: modsList, nodes });
    const row = p.rowByCode.get('ABSMMKC1');
    check('待移除（只有配置位）→ 仍可见', row.visible === true && row.configured === true && row.actual === false, JSON.stringify(row));

    // 只在实际里（待添加）→ 可见
    const b2 = mk(); putAct(b2.d3, nodes.find((n) => n.name === EPS));
    const p2 = buildVehicleProfile({ platform: '952', data1: b2.d1, data3: b2.d3, modules: modsList, nodes });
    check('待添加（只有实际位）→ 可见', p2.rowByCode.get('EPSZFX1').visible === true);

    // DATA3 缺失 → 退化成只看配置位图，仍然过滤
    const b3 = mk(); putCfg(b3.d1, nodes.find((n) => n.name === ABS)); putCfg(b3.d1, ecm);
    const p3 = buildVehicleProfile({ platform: '952', data1: b3.d1, data3: null, modules: modsList, nodes });
    check('DATA3 缺失仍能识别', !!p3 && p3.engine === '2.0', p3 && p3.engine);
    check('DATA3 缺失时 ABS 可见', p3.rowByCode.get('ABSMMKC1').visible === true);

    // 没有任何数据 → null（界面显示全部）
    check('无 DATA1 → null', buildVehicleProfile({ platform: '952', data1: null, modules: modsList, nodes }) === null);
    check('空 DATA1 → null', buildVehicleProfile({ platform: '952', data1: new Uint8Array(0), modules: modsList, nodes }) === null);
}

console.log('\n手动指定发动机（按 VIN 记住的那条路径）');
{
    const b = mk(); putCfg(b.d1, ecm); putAct(b.d3, ecm);
    const auto = buildVehicleProfile({ platform: '952', data1: b.d1, data3: b.d3, modules: modsList, nodes });
    check('自动 = 2.0', auto.engine === '2.0', auto.engine);
    const over = buildVehicleProfile({
        platform: '952', data1: b.d1, data3: b.d3, modules: modsList, nodes, engineOverride: '2.2',
    });
    check('手动 2.2 生效', over.engine === '2.2' && over.engineSource === 'user', `${over.engine}/${over.engineSource}`);
    check('手动后显示柴油 ECU', over.visible.some((r) => r.code === 'JTDM23GP'));
    check('手动后隐藏 2.0 ECU', !over.visible.some((r) => r.code === 'IAW10JAX'));
    check('记录自动推断值（供界面提示）', over.engineAuto === '2.0', over.engineAuto);
    check('无效的 override 被忽略', buildVehicleProfile({
        platform: '952', data1: b.d1, data3: b.d3, modules: modsList, nodes, engineOverride: '3.0',
    }).engine === '2.0');

    // 没有发动机节点 → 三个发动机都不隐藏（无从判断，宁可多显示）
    const b2 = mk(); putCfg(b2.d1, nodes.find((n) => n.name === BCM));
    const p = buildVehicleProfile({ platform: '952', data1: b2.d1, data3: b2.d3, modules: modsList, nodes });
    check('无发动机节点 → engine=null', p.engine === null, String(p.engine));
    check('无发动机节点 → 三个发动机都不隐藏（位图不可信时不误伤）', p.visible.some((r) => r.code === 'IAW10JAX')
        && p.visible.some((r) => r.code === 'JTDM23GP') && p.visible.some((r) => r.code === 'MED17.3.5'),
        p.visible.map((r) => r.code).join(','));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
