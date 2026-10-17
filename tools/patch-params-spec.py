#!/usr/bin/env python3
"""按诊断数据源 ResultFormat 全量重建 params.json 的 spec 字段。

格式串语义（实证）：`family[,decimals[,scale[,offset]]]`
  - family: num=无符号数、nums=有符号数（按字节宽两位补码）、bits/bitw/bitchars/str/hex/hex2/date*/nm*/equ* 等
  - 换算：value = (raw × scale + offset) / 10^decimals
  - Units 列 = 单位；StartByte（1-based）= 该参数在应答里的起始字节
来源：~/diag-data/data/params_all.tsv（CmdType=2 行）。用法：
  python3 tools/patch-params-spec.py
"""
import json
import pathlib
import csv

TSV = pathlib.Path.home() / 'diag-data/data/params_all.tsv'
OUT = pathlib.Path(__file__).resolve().parent.parent / 'src/data/params.json'

NUM_FAMILIES = ('num', 'nums')  # nums = signed


def parse_format(fmt: str, nbytes: int):
    """返回 spec 字段增量：decimals/scale/offset/signed；非数值族只标记 family。"""
    parts = (fmt or '').strip().split(',')
    family = parts[0] if parts else ''
    out = {'format': (fmt or '').strip()}
    if family == 'nm':
        # nm,decimals,scale,offset,maskHex —— 先按掩码截位再线性换算
        def num(i, default):
            try:
                return float(parts[i]) if i < len(parts) else default
            except ValueError:
                return default
        out.update({'decimals': int(num(1, 0)), 'scale': num(2, 1), 'offset': num(3, 0)})
        if len(parts) > 4:
            out['mask'] = parts[4].strip()
    if family in NUM_FAMILIES:
        def num(i, default):
            try:
                return float(parts[i]) if i < len(parts) else default
            except ValueError:
                return default
        dec = int(num(1, 0))
        scale = num(2, 1)
        offset = num(3, 0)
        out.update({'decimals': dec, 'scale': scale, 'offset': offset})
        if family == 'nums':
            out['signed'] = True
    return out


def main():
    # 源行索引：(ModuleID, DID, ParamName) → 行
    rows = {}
    with open(TSV, newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f, delimiter='\t'):
            if r['CmdType'] not in ('1', '2'):
                continue
            cmd = (r['Commands'] or '').replace(' ', '').upper()
            did = cmd[-4:] if len(cmd) >= 4 else ''
            key = (r['ModuleID'], did, r['ParamName'])
            rows.setdefault(key, r)

    params = json.load(open(OUT))
    hit = miss = 0
    for code, items in params['modules'].items():
        for it in items:
            did = str(it.get('did', '')).upper()
            r = rows.get((code, did, it.get('name', '')))
            if not r:
                miss += 1
                continue
            hit += 1
            nbytes = int(r['NumOfBytes'] or 1)
            start = int(r['StartByte'] or 1)
            spec = {
                'bytes': nbytes,
                'start': start - 1,                      # 转 0-based 偏移
                **parse_format(r['ResultFormat'], nbytes),
            }
            unit = (r['Units'] or '').strip()
            if unit:
                spec['unit'] = unit
            # bit 族选项表（BitResults 列：`MMVV标签` / bitw `MMVVMMVV标签` / bitchars 逐字节，'|' 分隔）
            bits = (r.get('BitResults') or '').strip()
            if bits:
                spec['options'] = [e for e in bits.split('|') if e]
            it['spec'] = spec
    json.dump(params, open(OUT, 'w'), ensure_ascii=False, indent=1)
    print(f'重建 spec：命中 {hit}，源缺失 {miss}（保留原样）')

    # ===== 冻结帧（CmdType=9，19 04 服务）→ dtc-snapshots.json =====
    snap = {}
    with open(TSV, newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f, delimiter='\t'):
            if r['CmdType'] != '9':
                continue
            code = r['ModuleID']
            if code not in params['modules']:      # 只取本工具覆盖的模块
                continue
            nbytes = int(r['NumOfBytes'] or 1)
            sb = int(r['StartByte'] or 1)
            spec = {
                'name': r['ParamName'],
                # 值 = 完整 59 应答[StartByte+2]（与实时参数同一 +3/长度前缀口径）
                'start': sb + 2,
                'bytes': nbytes,
                **parse_format(r['ResultFormat'], nbytes),
            }
            if (r['Units'] or '').strip():
                spec['unit'] = r['Units'].strip()
            bits = (r.get('BitResults') or '').strip()
            if bits:
                spec['options'] = [e for e in bits.split('|') if e]
            snap.setdefault(code, []).append(spec)
    snap_out = OUT.parent / 'dtc-snapshots.json'
    json.dump({'generatedFrom': 'params_all.tsv CmdType=9（19 04 冻结帧）', 'modules': snap},
              open(snap_out, 'w'), ensure_ascii=False, indent=1)
    print(f'冻结帧：{sum(len(v) for v in snap.values())} 项 / {len(snap)} 模块')

    # ===== 特殊功能选项表（BitResults：结果标签 + FE 步进文本）→ functions.json =====
    fpath = OUT.parent / 'functions.json'
    funcs = json.load(open(fpath))
    frows = {}
    with open(TSV, newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f, delimiter='\t'):
            bits = (r.get('BitResults') or '').strip()
            if bits:
                frows[(r['ModuleID'], r['ParamName'], r['Commands'])] = [e for e in bits.split('|') if e]

    def patch_fn(o):
        if isinstance(o, dict):
            if o.get('commands') and 'options' not in o:
                key = (o.get('module', ''), o.get('name', ''), o['commands'])
                opts = frows.get(key)
                if opts:
                    o['options'] = opts
            for v in o.values():
                patch_fn(v)
        elif isinstance(o, list):
            for v in o:
                patch_fn(v)
    patch_fn(funcs)
    json.dump(funcs, open(fpath, 'w'), ensure_ascii=False, indent=1)
    n_fn = [0]

    def count_fn(o):
        if isinstance(o, dict):
            if o.get('options'):
                n_fn[0] += 1
            for v in o.values():
                count_fn(v)
        elif isinstance(o, list):
            for v in o:
                count_fn(v)
    count_fn(funcs)
    print(f'功能选项表：{n_fn[0]} 条带表')


if __name__ == '__main__':
    main()
