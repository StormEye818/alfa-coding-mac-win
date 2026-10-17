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


if __name__ == '__main__':
    main()
