'use strict';
/**
 * 从 诊断数据源生成：
 *   src/data/named-settings.json — PROXI 命名设置（诊断软件自带的一键写项，44 条）
 *   src/data/functions.json     — 特殊功能（保养复位/配钥匙/执行器/编程）
 *
 * 选项编码：`HHHH<label>`，HHHH = 掩码(2hex) + 取值(2hex)。
 *   例 "0404Enabled|0400Disabled" → mask=0x04，取值 0x04=Enabled / 0x00=Disabled
 */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', '..', 'diag-data', 'data');
const OUT = path.join(__dirname, '..', 'src', 'data');

function readTsv(name) {
    const txt = fs.readFileSync(path.join(DATA, name), 'utf8');
    const lines = txt.split('\n').filter((l) => l.length > 0);
    const hdr = lines[0].split('\t');
    return lines.slice(1).map((l) => {
        const c = l.split('\t');
        const o = {};
        hdr.forEach((h, i) => { o[h] = c[i] !== undefined ? c[i] : ''; });
        return o;
    });
}

/** "0404Enabled|0400Disabled" → [{value:4,label:'Enabled'},...]，并算出掩码 */
function parseOptions(str) {
    if (!str) return { mask: 0, options: [] };
    const opts = [];
    let mask = 0;
    for (const part of str.split('|')) {
        const m = /^([0-9A-Fa-f]{4})(.*)$/.exec(part.trim());
        if (!m) continue;
        const maskByte = parseInt(m[1].slice(0, 2), 16);
        const valueByte = parseInt(m[1].slice(2, 4), 16);
        mask |= maskByte;
        opts.push({ value: valueByte, label: m[2].trim() });
    }
    return { mask, options: opts };
}

/** 拆 诊断数据的标记串：READNOTES,SECURITY29,RWUSERENTRYNUM29|5|num,... */
function parseFlags(rf) {
    const flags = {
        readNotes: false, execManual: false, security: null,
        userEntry: null, odometer: false, disconnect: false, proxi: false, func: false,
    };
    const s = String(rf || '');
    if (/READNOTES/i.test(s)) flags.readNotes = true;
    if (/EXECMANUAL/i.test(s)) flags.execManual = true;
    if (/ODOWARNING|ODOMETER/i.test(s)) flags.odometer = true;
    if (/DISCONN/i.test(s)) flags.disconnect = true;
    if (/PROXYPROC/i.test(s)) flags.proxi = true;
    if (/\bFUNC\b|FUNCEX/i.test(s)) flags.func = true;
    const sec = /SECURITY(0529V2EX|0529V2|0529|29)/i.exec(s);
    if (sec) flags.security = 'SECURITY' + sec[1].toUpperCase();
    const ue = /RWUSERENTRY(NUM29|NUM|29W|29H|29|2|)/i.exec(s);
    if (ue) flags.userEntry = ue[0].replace(/RWUSERENTRY/i, '') || 'TEXT';
    return flags;
}

function securityNote(f) {
    if (f.security === 'SECURITY29') return { level: 'pin', text: '需要 5 位 PIN（离线可用）' };
    if (f.security && f.security.startsWith('SECURITY0529')) {
        return { level: 'server', text: '需要服务器按 VIN 算密钥 → 本工具不支持' };
    }
    return { level: 'none', text: '无需安全访问' };
}

function build() {
    fs.mkdirSync(OUT, { recursive: true });
    const params = readTsv('params_all.tsv');
    const ecus = readTsv('ecu_list.tsv');
    const okCodes = new Set();
    for (const r of ecus) {
        const n = parseInt(r.carId, 10);
        if ((n >= 680 && n <= 682) || (n >= 693 && n <= 695)) okCodes.add(r.code);
    }

    // ---- 1. PROXI 命名设置 ----
    const named = [];
    for (const r of params) {
        if (r.ModuleID !== 'PROXIX1' || r.CmdType !== '4') continue;
        if (/ALIGNMENT PROCEDURE/i.test(r.ParamName)) continue;
        const { mask, options } = parseOptions(r.BitResults);
        if (!options.length) continue;
        named.push({
            name: r.ParamName,
            startByte: parseInt(r.StartByte, 10),
            numBytes: parseInt(r.NumOfBytes, 10) || 1,
            mask,
            options,
            request: r.Commands,
            messageId: r.MessageID,
        });
    }
    // 按字节排
    named.sort((a, b) => a.startByte - b.startByte || a.name.localeCompare(b.name));

    fs.writeFileSync(path.join(OUT, 'named-settings.json'), JSON.stringify({
        note: '诊断软件自带的 PROXI 命名设置（一键写）。每个 = 在 DATA1 的 startByte 上按 mask 改成某个 value，然后 2E 20 23 写回 + 重算 CRC。',
        source: 'diag-data/data/params_all.tsv (ModuleID=PROXIX1, CmdType=4)',
        count: named.length,
        settings: named,
    }, null, 2) + '\n');

    // ---- 2. 特殊功能 ----
    // 模块 → 中文分类
    const CAT = {
        SVCRST29: '保养与里程复位',
        RFH30: '钥匙 / 胎压 / VIN',
        BODY33: '车身执行器与编程', BODY30: '车身执行器与编程',
        ABSMMKC1: '刹车 / ABS / EPB',
        JTDM23GP: '发动机', 'MED17.3.5': '发动机', 'MED17.3.5S': '发动机', IAW10JAX: '发动机',
        ZF8HP50: '变速箱 / 传动', ESM1X: '变速箱 / 传动', DTCM4: '变速箱 / 传动',
        EPSZFX1: '转向', SLCK2: '转向锁',
        DASM1: '驾驶辅助 / 底盘', HALF1: '驾驶辅助 / 底盘', TVM1: '驾驶辅助 / 底盘',
        CLIMA33: '空调 / 舒适', CSWM2: '空调 / 舒适', CSWM5: '空调 / 舒适',
        CNAV13: '多媒体', AMP2: '多媒体', ANC1: '多媒体', EMCM1X: '多媒体',
        HDLGHT6: '灯光', PARKSEN8: '泊车', PARKSEN14: '泊车',
        PLGM1: '尾门', ABG28: '安全气囊', LRBSS1: '盲点监测',
        AAML1: '主动空气动力', AAMR1: '主动空气动力', ADBLU1: '排放 / 尿素',
        DASH29: '仪表', PROXIX1: 'PROXI 对齐',
    };
    const perCat = new Map();
    for (const r of params) {
        if (!['3', '4', '8', '6'].includes(r.CmdType)) continue;
        if (!okCodes.has(r.ModuleID)) continue;          // 只要 952/949 的模块
        const flags = parseFlags(r.ResultFormat);
        if (flags.odometer) continue;                    // 里程表相关一律不提供
        const cat = CAT[r.ModuleID] || `其它（${r.ModuleID}）`;
        const sec = securityNote(flags);
        const item = {
            name: r.ParamName,
            module: r.ModuleID,
            kind: ({ '3': '执行器', '4': '编程/调整', '8': '编程/调整', '6': '执行器' })[r.CmdType],
            cmdType: r.CmdType,
            commands: r.Commands,
            resultFormat: r.ResultFormat,
            desc: r.Description && r.Description !== 'No help available' ? r.Description : '',
            security: sec,
            needsUserInput: flags.userEntry !== null,
            execManual: flags.execManual,
        };
        if (!perCat.has(cat)) perCat.set(cat, []);
        perCat.get(cat).push(item);
    }
    const funcs = [];
    for (const [cat, list] of perCat) {
        list.sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
        funcs.push({ category: cat, count: list.length, items: list });
    }
    funcs.sort((a, b) => b.count - a.count);

    fs.writeFileSync(path.join(OUT, 'functions.json'), JSON.stringify({
        note: '特殊功能（执行器测试 / 编程 / 调整）。已剔除里程表写入类条目。security.level=server 的本工具不支持。',
        source: 'diag-data/data/params_all.tsv (CmdType=3/4/8/6, 952/949 模块)',
        total: funcs.reduce((n, f) => n + f.count, 0),
        categories: funcs,
    }, null, 2) + '\n');

    console.log(`命名设置: ${named.length}`);
    console.log(`特殊功能: ${funcs.reduce((n, f) => n + f.count, 0)} 条，分 ${funcs.length} 类`);
    for (const f of funcs) console.log(`   ${f.category}: ${f.count}`);
    const server = funcs.flatMap((f) => f.items).filter((i) => i.security.level === 'server').length;
    const pin = funcs.flatMap((f) => f.items).filter((i) => i.security.level === 'pin').length;
    console.log(`   其中需服务器密钥: ${server}（不支持） / 需 PIN: ${pin}`);
}

build();
