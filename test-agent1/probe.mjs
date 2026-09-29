/**
 * 测试探针：重建模拟车 snapshot().odoFlash 真值。
 *
 * 说明：harness 进程内 car.snapshot() 不对外暴露，但其 odoFlash 逻辑是：
 *   任一「已安装」节点 与 车身电脑 在 (写入计数 0x292E 或 配置块 0x2023) 上不一致 → true
 * 本探针通过 UDS 读同样的数据重建该判定（与 snapshot() 逐条对应）。
 * 「已安装」集合按模拟车文档的固定规则（init 时冻结）：
 *   excluded 节点、ABSENT_NODES 清单 → 未安装；其余已安装。
 */
import fs from 'fs';

const readJson = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));

/** 模拟车文档声明的未安装节点（giulia-car.mjs ABSENT_NODES） */
export const ABSENT_NODES = new Set([
    'Compact Disk Node (CDM)',
    'Satellite Receiver Node (SRM)',
    'Rear Left Climate Control Node (RLCM)',
    'Additional Heater Node (CTM)',
    'Driver monitoring system module (DMSM)',
    'Passenger Occupant Classification Node (OCM)',
    'Left Blind Spot Sensor Node (LBSS)',
    'Vehicle Tracking Module (VTM)',
    'Collision Mitigation Module (CMM)',
    'Drive Train Control Node (DTCM)',
    'Passenger Door Latch Module (PDML)',
    'Engine control Module 2 (ECM2)',
    'Torque vectoring module (TVM)',
    'Active aerodynamic module Left (AAML)',
    'Active aerodynamic module Right (AAMR)',
    'Haptical Lane Feedback Node (HALF)',
    'Coupling Control Node (CCM)',
    'Traffic message module (TMM)',
]);

const dataDir = new URL('../src/data/', import.meta.url);

export async function probeSnapshot(t, { verbose = false } = {}) {
    const mods = JSON.parse(fs.readFileSync(new URL('modules.json', dataDir), 'utf8'));
    await t.session.ensureModule(t.session.bodyModule);
    const bodyBytes = await t.uds.readProxi();
    const bodyCounter = await t.uds.readProxiWriteCounter();

    const nodes = {};
    let odoFlash = false;
    let installedCount = 0;
    for (const n of mods.alignmentNodes) {
        const excluded = !!n.excluded;
        const installed = !excluded && !ABSENT_NODES.has(n.name);
        if (installed) installedCount++;
        let counter = null, configMatches = false, err = null;
        try {
            await t.session.connectNode(n);
            counter = await t.uds.readProxiWriteCounter();
            const nb = await t.uds.readProxi();
            configMatches = nb.length === bodyBytes.length && nb.every((b, i) => b === bodyBytes[i]);
        } catch (e) {
            err = e.message;
        }
        const aligned = installed && err === null && counter === bodyCounter && configMatches;
        if (installed && !aligned) odoFlash = true;
        nodes[n.name] = { addr: n.addr, excluded, installed, counter, bodyCounter, configMatches, aligned, err };
        if (verbose && installed && !aligned) {
            console.log(`  [probe] 未对齐: ${n.name} addr=${n.addr} counter=${counter}/${bodyCounter} cfgMatch=${configMatches} err=${err || '-'}`);
        }
    }
    await t.session.ensureModule(t.session.bodyModule);
    return { odoFlash, bodyCounter, bodyBytesLen: bodyBytes.length, installedCount, nodes };
}
