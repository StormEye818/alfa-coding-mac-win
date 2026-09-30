# 诊断软件 术语中译 —— 取舍说明（请人工复核）

译文在 `i18n.json`，界面显示中文、英文保留在 `en` 字段便于和 诊断软件 对照。
下面这些是**我有意做了取舍**或**拿不准**的，麻烦扫一眼，不合适的告诉我改。

## 一、术语取舍（同一概念多种叫法，我选了哪个）

| 原文 | 我用的译法 | 其它常见叫法 | 理由 |
|---|---|---|---|
| `Cornering lights` | **转向辅助灯（弯道辅助灯）** | 角灯、弯道照明灯 | 国内车友圈最通用；括注备用名 |
| `Puddle lights` | **照地灯（迎宾灯）** | 地面照明灯、礼貌灯 | "照地灯"是维修手册常用，"迎宾灯"是车友常用 |
| `Dynamic control selector` | **动态驾驶模式选择器（DNA/Race）** | DNA 旋钮、驾驶模式选择 | 阿罗语境里就是 DNA/Race 那个旋钮，加括注便于识别 |
| `Comfort windows open/close` | **遥控车窗（舒适开启/关闭）** | 舒适车窗、一键升窗 | 与你笔记里的「遥控车窗」对齐 |
| `Daylights dropout` | **日间行车灯熄灭（跟随大灯）** | DRL 熄灭逻辑 | 说明它的真实含义（开大灯时 DRL 变暗/熄灭） |
| `Side lights` | **示宽灯 / 侧标志灯** | 小灯、位置灯 | 欧规叫示宽灯，美规叫侧标志灯；选项里正有 Europe/US 之分，所以并列 |
| `Third (center) brake light` | **高位（中央）刹车灯** | 第三刹车灯 | "高位刹车灯"最通俗 |
| `Menu: Easy entry` | **菜单：舒适进出（座椅迎宾）** | 便捷进入、迎宾功能 | 指座椅/方向盘自动让位方便上下车 |
| `Volumetric sensors sensitivity` | **车内超声波传感器灵敏度** | 容积传感器 | 指防盗用的车内超声波侦测，说清楚避免误解 |
| `Rearm inertia switch (FIS)` | **复位碰撞断油开关（FIS）** | 惯性开关、断油开关 | 碰撞后断油，需手动复位 |
| `Roll-bench/dyno mode` | **转鼓/测功机模式** | 滚筒模式、马力机模式 | 保留两种说法 |
| `Phonic wheel learn reset` | **信号盘学习复位** | 齿圈学习、曲轴信号盘 | 指曲轴信号盘/齿圈 |
| `Splash Screen` | **开机动画（Splash 画面）** | 启动画面、开机 LOGO | — |
| `Enable FOBIKs` | **启用遥控钥匙（FOBIK）** | 遥控器、智能钥匙 | FOBIK 是 FCA 对折叠/智能钥匙的专有叫法，保留缩写 |
| `Key programming` | **钥匙编程（匹配钥匙）** | 配钥匙、钥匙匹配 | 你说的「配钥匙」，加注便于检索 |
| `Hydraulic circuit bleed` | **液压回路排气（排空）** | 刹车油排气、排空 | **换刹车油**就是走这套；"排气"是维修手册标准说法 |
| `load valve / drain valve` | **增压阀 / 泄压阀** | 进油阀/出油阀、常开阀/常闭阀 | ABS 泵的两种阀 |
| `Traction solenoid valve (primary/pilot)` | **牵引力控制电磁阀（主/先导）** | — | ABS 泵内部阀 |
| `Actuator base adjustment` | **执行器零位调整** | 基准调整 | — |
| `Production/Service final calibration` | **生产/售后最终标定** | — | 直译会很怪 |
| `Self-adaptation` | **自适应** | 自学习 | 行业标准用"自适应" |
| `UniAir actuation electrovalve` | **UniAir 电磁阀** | 液压挺柱电磁阀 | UniAir 是马瑞利专有技术名，保留 |
| `Phase variator control` | **相位调节器控制（VVT）** | 可变正时 | 加 VVT 便于理解 |
| `NOx storage catalyst (NSC)` | **NOx 储存催化器（NSC）** | — | 柴油后处理 |
| `Glow plugs` | **预热塞** | 电热塞、热塞 | 柴油车通用 |
| `MIL control light` | **故障灯（MIL）** | 发动机故障灯 | MIL=Malfunction Indicator Lamp |
| `Hill holder failure indicator` | **上坡辅助故障指示灯** | 坡道辅助 | — |
| `Puddle` / `lamp` 等词 | 见上 | | |

## 二、我拿不准的（建议你重点看）

1. **`Cabin Equalization Version`** → 「座舱音效均衡版本」 —— 指音响系统的均衡调校版本号，不确定是不是 Beats/Ask 功放专有项。
2. **`Supplier Configuration Data`** → 「供应商配置数据」 —— 原文就很泛，我直译了。它在功放模块上。
3. **`Classification number/version`** → 「分类号 / 版本」 —— 不确定是零件分类还是软件版本。
4. **`Calibration board distance`** → 「标定板距离」 —— 应该是摄像头标定时标定板到车的距离，不确定量纲。
5. **`Target frame calibration`** → 「目标框标定」 —— 可能是摄像头的目标框/识别框。
6. **`VIN unlock + 1040` / `+ 2705` / `unlock2` / `unlock3 +vinlock` / `unlock4`** —— 这些是 诊断软件 内部的**脚本编号**，不是功能名。我没意译，保留编号便于和 诊断软件 对照。这些都属"需服务器密钥"，本工具本来就不支持。
7. **`test 2705`** → 「测试 2705」 —— 同上，内部脚本名。
8. **`PROXI 2024`** → 「PROXI 2024」 —— 保留，可能是 2024 款专用 PROXI 版本。
9. **`Country XX`（约 180 个）** → 「国家代码 XX」 —— 诊断软件 只给了代码没给国名，无法对应。已知的约 90 个国家名我译了（China→中国 等）。
10. **`Base/Premium, Logic N`** → 「基础型/高级型 逻辑N」 —— TPMS 传感器的类型分档，N 是逻辑档位。不确定"基础型/高级型"是否是行业通用分档说法。
11. **`Flow shutter valve`** → 「节流阀（翻板阀）」 —— 进气翻板，柴油机上常见。
12. **`Low temp. WCAC coolant pump`** → 「低温中冷器冷却水泵」 —— WCAC = Water-Cooled Charge Air Cooler（水冷中冷器）。

## 三、有意保留英文/缩写的

`ABS / EBD / ESP / EPB / ACC / TPMS / SGW / DRL / MIL / EGR / DPF / NOx / NSC / VIN / FOBIK / UniAir / DAB / GPS / FM2 / USB / AUX / SD / PWM / LHD / RHD / ACP / AA / SDARS / TomTom / Beats / Ask / CF6 / EOBD / E6D`

处理原则：**中文（缩写）**，如「ABS 防抱死」「EPB 电子手刹」。缩写在车友圈已通用，硬译反而看不懂。

## 四、模块代号

界面里显示为「中文名 + 代号」，例如 **车身电脑 Marelli（952）· BODY33**。代号必须保留 —— 它是 诊断软件 和所有技术资料里的索引名。
