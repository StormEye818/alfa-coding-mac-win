# 特殊功能说明中译 — 术语取舍与待复核清单

对应文件：`i18n-desc.json`（146 条，key=英文原文精确匹配）。
覆盖核对：functions.json 中全部非空 desc 共 493 处引用、146 条不重复原文，命中率 **100%**。

以下是**拿不准或有意取舍**的译法，建议人工复核（约 22 条）。

## 一、术语取舍（可能与贵司内部口径不同）

1. **phonic wheel → 信号轮（齿圈）**
   原文 `phonic wheel`（[15][17]），即曲轴/凸轮轴信号盘。也常译「信号盘」「靶轮」，按上下文（与转速传感器、正时边沿相关）取「信号轮（齿圈）」。

2. **Distribution belt → 正时皮带**
   `RPM sensor or Distribution belt is replaced`（[17]）。此处 distribution 即配气正时，译「正时皮带」；若您指的是附件皮带请改。

3. **UniAir actuator dispersion correction → UniAir 执行器散差修正**
   [17] 中引用的后续程序名。dispersion 亦可译「离散度/一致性」，程序名实际界面若另有中文名请统一。

4. **Ionization control module → 离子电流控制模块**
   [46]，MED17 平台用火花塞离子电流做爆震/燃烧检测的模块。也见「离子检测模块」，取前者。

5. **swirl valve → 进气歧管涡流控制阀（swirl 阀）**
   [32] `inlet manifold flow shutter (swirl) valve`。柴油机常见，也译「涡流翼板阀」。

6. **Key on MAR → 钥匙置于 MAR（ON 挡）**
   [25][26][36][50] 等。MAR 是菲亚特/阿尔法钥匙档位名（=点火 ON）。首次出现加注「ON 挡」，其余保留 MAR 以与实车一致。

7. **CSWM → 保留缩写**
   [73] 座椅/舒适控制模块。未查证官方中文名，保留 CSWM。

8. **vehicle geometry sensors → 车身几何传感器**
   [135][136]，前照灯水平调节用的车身高度传感器（ride-height sensor）。也译「车身姿态传感器」，二选一请定夺。

9. **splitter → 扰流板（splitter）**
   [137][138]，所属分类「主动空气动力」、模块 AAMR1，指主动空气动力学扰流板/风刀。若贵司口径为「主动尾翼/风刀」请统一。

10. **FIS inertia switch → 惯性开关（燃油切断开关，FIS）**
    [55]，碰撞断油装置。也译「惯性断油开关」。

11. **glow plug / glow plugs module → 预热塞 / 预热塞控制模块**
    [33]，柴油预热系统。个别资料译「电热塞」。

12. **double-ended coil → 双头点火线圈**
    [2]，即废火点火（waste spark）双头线圈。也译「双头点火线圈（废火点火）」。

## 二、有意取舍（按字面直译可能有歧义）

13. **[74] 后视镜自动折叠**：原文 "auto-folding on these cars should be disabled when you set this option to 'Present'" 逻辑上很奇怪（设为 Present 一般是启用），译文按字面译为「将本选项设为 Present 后，自动折叠应被禁用」。**请对照实车确认**，也可能是原文笔误。

14. **[73] 便捷上下车禁用技巧**：原文建议"mis-calibrating the seat sliding motor"（故意让座椅滑轨电机标定失败后再中止）来禁用迎宾座椅，译为「故意让座椅滑轨电机标定失败」。属原厂文档描述的变通做法，措辞已尽量中性。

15. **[122][123] 尾门标定**：原文 `liftgate should be on top / on bottom`，按上铰链尾门理解为「上位（关闭位）/ 下位（开启位）」。若您车型尾门运动方向不同请复核。

16. **[140] 方向盘自学习验收**：原文 "when it is fully turned either right or left" 后回正，译为「向左/向右打到底后松手，应能自动回到中间位置」，补出了「松手」这一隐含动作。

17. **[132] 胎压传感器 ID**：`set the 1st digit to 0`（ID 为 7 位时首位补 0）译为「输入新值时请在第一位补 0」。

18. **[29] 中冷器废气再循环**：`prevents recirculation of exhaust gases in the intercooler`，按字面译「防止废气在中冷器内再循环」（即低温时切断 EGR 再循环以加快暖机），未展开解释。

## 三、格式与标记约定

19. **WARNING: / ATTENTION: → ⚠ 警告：**；**NOTE: / :NOTE: → 注意：**；**PLEASE NOTE → 请注意：**；**PLEASE READ ALL NOTES CAREFULLY! → 请仔细阅读全部注意事项！**
   其中原文 `ATTENTION:`（[40][41] DPF 再生）也按警告处理，用 ⚠ 警告： 前缀，便于界面高亮。若需与 WARNING 分级区分可改回「注意：」。

20. **段落**：原文以连续空格分段，译文统一改为换行分段；"  - 列表项" 改为 "- 列表项" 独立成行；步骤 "1. 2. 3." 保留编号并换行。便于界面阅读，未改动语义。

21. **保留原文的数值/单位/参数名**：`2E 28 00` 类命令字节、`850 rpm ± 50 rpm`、`2800mbar`、`~120 cm`、`>12V`、`±20 度`（度为中文）、参数名 `Active alignment adjustment screw`、`Static calibration error`、`ACP/AA offline activation status`、选项值 `Present`/`Not Present`/`OK`/`Error`/`Disabled` 等保持英文，与界面显示一致。

22. **原文笔误不改义**：`successfult`（[3][4][10] 等）、`roll-bench model`（[98]，应为 mode）、`eneterd`（[22]）、`shoud`（[133]）、`.7.`/`.8.` 编号错误（[128][130]）均按正确语义翻译，未在译文里标注。

## 四、特殊情况说明

23. **[142] 原文本身已是中文**（`通过调大保养周期并执行保养归零，重新启用仪表的保养提醒显示。`）：译文与原文相同，key 为该中文原文，精确匹配。

24. **无「纯命令/纯数值」条目**：146 条均有可译正文，未出现需要写 `—` 或保留原文的占位情况。functions.json 中另有 46 条 `desc` 为空，未纳入本表（符合「非空且非 No help available」的覆盖口径）。

## 五、高频统一译法（已全文统一，供审校速查）

| 英文 | 中文 |
| --- | --- |
| A/C compressor clutch relay | 空调压缩机电磁离合器继电器 |
| VIN-lock | VIN 锁定 |
| Body computer module | 车身控制模块（BCM） |
| self-adaptation / learn / calibration | 自适应 / 学习 / 标定 |
| bleeder | 排气螺栓 |
| drain valve | 泄压阀 |
| lambda sensor | 氧传感器（Lambda） |
| particle filter / DPF | 颗粒捕捉器（DPF） |
| glow plug | 预热塞 |
| throttle / rail pressure | 节气门 / 轨压 |
| seat belt / airbag squib（未出现 squib 原文） | 安全带 / 气囊点火器 |
| FOBIK / RFH | 遥控钥匙（FOBIK）/ 射频中心模块（RFH） |
| roll-bench / dyno mode | 转鼓 / 测功机模式 |
| service coupon / Service due | 保养次数（service coupon）/ 保养提醒 |
| PROXI Alignment | PROXI 对齐（PROXI Alignment） |
| Urea/AdBlue | 尿素（Urea/AdBlue） |
| e-motor | 驱动电机 |
| transfer case | 分动箱 |
| valve body solenoid | 阀体电磁阀 |
