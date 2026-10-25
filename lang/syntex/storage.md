# 双存储后端与惰性 Python 读取

`yambl generate` 从已校验的 JSON IR 生成 SQLite DDL、`schema.md` 表结构参考、
`storage-manifest.json`、JSONL 仓库模板和带 `py.typed` 的自包含 Python 包。
关系图与 Python API 参考一并生成。生成只接受新目录或空目录；
`--dryrun` 完成校验和渲染，不创建目录。不执行数据库迁移，不提供生产写入 API。

```console
yambl compile -o path ../fmc-data-model -o output ./build/model.yambl-ir.json
yambl generate -o path ./build/model.yambl-ir.json -o output ./build/generated -o package fmc_model
```

## 表结构

每个业务根实体有一张身份宽表，保存 ID、实际实体类型及未指定分组的无维度 static 字段；
同一继承树共享 ID 空间，子类型字段也并入根实体宽表，读取仍检查实际类型上的适用性。
无维度的 static 集合将状态放入宽表、成员放入独立表。有维度的 static 字段按根实体和
维度结构分组，config 按根实体独立存入长表。普通 `attr` 是 `static attr`
的简写；源码格式化保留写法，签名、筛选和 IR 都使用 static。
`AttrCats.Static`、Config、Snapshot、Scd 的位值分别为 2、4、8、16，Computed 为 32，All 为 62。
`AttrCats.Attr` 已移除。`@dimension` 允许 static、snapshot、scd，禁止 config。

每个逻辑 snapshot/SCD 字段有独立时间表；关系声明共享逻辑字段存储，但读取使用
实际实体上的实现约束。维度列非空，参与键；维度名称或类型不同就分表。
Hierarchy selector 是元信息，不是维度列，直接读取必须显式提供全部维度；计算中的 best_available 可自动选择一个 Hierarchy。

表名使用 `tb_` 前缀，namespace 各段与实体的 snake_case 名称用单下划线连接；
内置表省略 `builtins` namespace。数据库名保留仓库 prefix，字段表使用逻辑身份所属的
根实体，因此 Fund 的 holdings 属于 Portfolio 的表组。FMC 示例为：

| 表名 | 用途 |
| --- | --- |
| `tb_core_portfolio` | Portfolio 身份及无维度 static 宽表 |
| `tb_core_portfolio_holdings` | holdings 的 portfolio、date、成员引用 |
| `tb_core_portfolio_holdings_status` | holdings 的 portfolio、date、状态 |
| `tb_core_holding_entry` | HoldingEntry 身份及无维度 static 宽表 |
| `tb_core_security` | Security 身份及无维度 static 宽表 |
| `tb_core_security_price` | price snapshot，含 source 维度 |

snapshot/SCD 标量表使用根表名加字段名；集合成员表也使用此命名，独立状态表增加
`_status`。config 长表使用 `_config`，有维度的 static 分组使用 `_static_维度名称`；
同名维度但类型不同的后续分组增加 `_2`、`_3` 等稳定序号。分组按 IR 的逻辑字段顺序分配。
其他名称冲突在生成前报错，不覆盖已有结构。业务表的物理 ID 列仍为 `id`，
集合成员列为 `member_id`，对应的 YAMBL ID 字段和引用目标记录在 manifest 和表结构文档中。

config 与 sparse 共用长表类型列规则：主键 `(id, field)`，state 加上实际需要的
`string`、`bool`、`int`、`decimal`、`date` 列。引用使用目标 ID 的列。
正常标量仅对应载荷列非空，NO_ENTRY、EMPTY、NOT_APPLICABLE 的全部载荷列为 NULL。
config 集合的记录行全部标量载荷列为 NULL，成员表通过 `(id, field)` 外键关联。
field 保存逻辑字段 qualified name，manifest 的 `key_values` 保存选择条件。
读取仍按实际实现检查类型，只有缺行或 NO_ENTRY 使用模型默认值。

每个字段独立保存 VALUE、NO_ENTRY、EMPTY、NOT_APPLICABLE 状态。缺行或字段状态
NO_ENTRY 表示无记录；EMPTY 的载荷为 NULL。集合有记录表和成员表，成员引用去重；
VALUE 记录存在但无成员表示正常空集合。实体引用不建立强制目标存在的外键；集合
成员对其记录表建立外键。外部写入程序必须为连接启用 `PRAGMA foreign_keys = ON`。

Decimal、整数和相应 ID 使用 TEXT，避免 SQLite 数值精度限制。bool 使用 0/1，
date 使用 ISO 日期。本地字典代码校验成员身份，外部字典只保存带字典类型的字符串。
不执行任意正则，不生成 Snowflake ID。数据库保存布局修订号和模型摘要，读取器要求匹配。
当前布局修订号为 5；IR 为修订号 3，运行时契约为 2。旧布局数据库须重新生成，本轮不提供迁移。
内部元数据表为 `tb_yambl_metadata`，也使用统一前缀。

`schema.md` 包含全部表、列、主键、CHECK、外键、索引、逻辑字段映射和各表 DDL。
文档区分模型默认值与 SQL 默认值，区分逻辑引用与实际外键；它与 SQL 和 manifest
由同一份存储模型生成。

### 命名 static 分组

`@sparse(cat: string)` 与 `@dense(cat: string)` 仅修饰实体或 extend 中的非集合、
无维度 static 属性，普通 `attr` 同样适用。两者与 `@dimension` 互斥。
cat 必须是非空 snake_case，不接受路径、空白或任意 SQL 名称。

```text
entity Security { id security_id: string }
entity Bond inherits Security {
    @sparse('bond_info')
    attr coupon: decimal
    @sparse(cat='bond_info')
    attr callable: bool
    @dense('terms')
    attr issuer_name: string
}
```

分组按继承根实体与 cat 合并。以上字段分别进入 `tb_security_bond_info` 和
`tb_security_terms`；在 core namespace 下使用 `tb_core_security_...`。
同一继承树内同 cat 混用 sparse/dense 报错；不同继承树可使用不同布局。
与身份表、时间表、config 表等物理名称冲突时，生成器在写出前报错。

sparse 为长表，主键 `(id, field)`；field 保存逻辑字段 qualified name，state 保存状态。
按组内实际需要建立 `string`、`bool`、`int`、`decimal`、`date` 载荷列。
string 和 code 共用 string；integer 与 snowflake_id 共用 int；实体引用使用目标 ID 的列。
除 bool 为 INTEGER 0/1 外，载荷列均为 TEXT，保留整数和 Decimal 的精度。
SQL CHECK 约束正常行必须且只能填入该字段对应的一列，其他列为 NULL；
NO_ENTRY、EMPTY、NOT_APPLICABLE 行的所有载荷列均为 NULL。组内未用到的列不生成。
dense 为主键 id 的宽表，每个字段有独立载荷和状态列，行为与身份宽表上的 static 字段相同。

两种标记只决定存储布局，不参与逻辑字段签名、类型兼容、筛选及读 API。
继承和 override/overload 实现共享一个逻辑字段的分组：任一实现声明的分组适用于整个逻辑字段，
其他实现可以省略或重复相同标记，显式指定不同分组或布局时报错。
不支持的业务类型仍在生成前报告；分组不会让未支持的运行时类型自动变为可用。

### 内置表

始终生成 `tb_decodes`、`tb_decodes_entries`、`tb_hierarchy`、`tb_hierarchy_entries`、
`tb_config_group`、`tb_config_group_when` 和 `tb_config_group_then_set`。
三个 final 内置实体以各自声明的 ID 字段为主键，无需实际子类型列。集合和映射状态保存在
所属身份宽表，子表有指向所属身份表的实际外键。

Decodes 条目主键为 `(decodes_id, code)`；Hierarchy 条目主键为 `(hierarchy_id, ordering)`。
条目字段来自 IR 内携带的 value 定义，整数 ordering 使用精确 TEXT。DDL 初始化所有已声明
字典及其条目，包括内置 flags 自动生成的 None/All。带引号的外部字典不创建伪造实例。

ConfigGroup 的 entity_type 是可空类型 qualified name，配有独立状态列。when 和 then_set
子表每项保存 `config_group_id`、`field`（逻辑字段 qualified name）和 `value`。value 是
紧凑 JSON 对象：`type` 为 IR 中展开后的 Type 对象，`value` 为对应 JSON 载荷。
整数及 Decimal 载荷使用精确字符串，引用保存 ID；集合可用 JSON 数组表达。
SQL 校验 JSON 对象及 type/value 包装结构，主键保证同组同字段不重复；内部类型结构、
字段候选范围和载荷兼容性尚无写入校验器。这里不定义七个非正常结果的 JSON 编码。

内置表由批量运行时用于 Hierarchy 选择和 ConfigGroup 条件覆盖。ConfigGroup 包含必填 priority；
通用内置模型 handle API 尚未开放，manifest 的 `readable: false` 表示不生成这种公开方法。

## 时间和结果

snapshot 点查询匹配指定日期，区间查询返回 `[start, end)` 内已有记录。SCD 两个
边界均非空，范围为 1900-01-01 至 2999-12-31，开始严格早于结束；最大日期仍是
排他的结束边界。SCD 点查询返回当日状态，区间查询返回起点及后续期间边界的状态，
缺口为 NO_ENTRY，重叠为 ERROR。相邻期间同一天只产生一个点，结果按日期升序。
空区间成功返回空列表，反向区间报 ERROR。

生成的实体是 frozen dataclass，保留身份判等，不按字段值判等。property 首次访问
读取该实例该字段的全部记录；`read_*` 和 `read_*_range` 方法继续可用。
无时间、无维度属性返回 `ReadResult[T]`；有维度 static、snapshot 和 SCD 返回
`ReadResult[tuple[字段专属记录类, ...]]`。记录类也是 frozen dataclass，包含维度、
日期或完整 `valid_from` / `valid_to`，以及 `value: ReadResult[T]`。坐标排序确定，
无记录返回成功空元组，不补造坐标。引用与集合保存 `EntityRef`，显式 resolve。

方法按规范化参数缓存，完整 property 缓存可用于计算点值和区间结果。ERROR 不缓存，
包括记录内 ERROR；其他确定结果可缓存。关闭后已有缓存仍可访问，需要新增读取时返回 ERROR。
区间方法仍返回列表，每次复制，调用者修改不会污染缓存。实体缓存由会话私有维护。
SQLite 使用只读连接和固定读取事务。

生成的 Python 类与读取方法使用结构化 rST docstring。实体类携带自身声明的 title、
description（如有），不推断元信息继承。attr 的点查询和区间查询方法携带 title、description、
解析后的 YAMBL 类型、维度说明以及实际声明该逻辑字段的实体列表。列表使用完整名称，去重后
按字母序排列：override/overload 保留所有声明实体，extend 归属被扩展实体，仅继承而未重声明的
子类不加入列表。Hierarchy selector 标明为元信息，只有实际维度成为 Python 必填参数。

所有生成方法包含 `:param name:`、`:returns:` 和 `:rtype:`，说明日期边界、返回结果、
批量顺序和重复项、config 默认值及错误行为。title/description 等模型文本作为 rST 字面块
保留，并转义 Python 字符串；文档中的引号、反斜杠和 rST 指令不会改变生成代码或文档结构。

`ReadResult[T] = Success[T] | NonNormalResult`。所有正常 API 失败通过结果返回：

| 情况 | 结果 |
| --- | --- |
| 实际子类型没有该字段 | NOT_DEFINED |
| 存在记录且值为空 | EMPTY |
| 没有字段记录或顶层实体 | NO_ENTRY |
| 显式解析的引用目标不存在 | ENTITY_NOT_FOUND |
| 明确不适用的存储状态 | NOT_APPLICABLE |
| 参数、读取或单条解码失败 | ERROR |
| 无满足条件的数据 | NO_DATA 保留；本阶段直接读取不自动产生 |

区间结果为 `ReadResult[list[tuple[date, ReadResult[T]]]]`。整体查询失败返回外层 ERROR，
不返回部分结果；可定位到单条记录的解码问题返回内层 ERROR。
config 仅在 NO_ENTRY 时使用模型默认值，`Success.origin` 为 `model_default`；
EMPTY 和 NOT_APPLICABLE 不触发模型默认值。有效 ConfigGroup、Hierarchy 与计算传播规则见 [计算字段](computations.md)。

## 能力清单

下表的“静态”包括 Python 检查器和 LSP；IR 保留完整语言能力，后端只接受已实现的业务类型。
不支持的业务字段会报告身份、源码位置和原因；未使用的内置声明不阻止生成。

| 能力 | 规范 | Python / LSP | IR | SQLite / JSONL | Python 类型 / 读取 |
| --- | --- | --- | --- | --- | --- |
| namespace、import、仓库根、qualified name | 已定义 | 已实现 | 已解析 | 使用身份映射 | 使用身份映射 |
| entity、继承、final、extend | 已定义 | 已实现 | 已实现 | 根身份与有效字段 | 实际子类型 handle |
| override、overload、exact | 已定义 | 已实现 | 保留实现与共同契约 | 共享逻辑存储 | 按实际实现校验 |
| attr/static 统一、类别筛选 | 已定义 | 已实现 | static | 无维度身份宽表，有维度分组 | 惰性属性与显式方法 |
| config 默认值 | 已定义 | 已实现 | 已实现 | 根实体长表，独立字段行与状态 | NO_ENTRY 使用默认值 |
| string、bool、integer、decimal、date、snowflake_id | 已定义 | 已实现 | 已实现 | 已实现 | 已实现；不生成 ID |
| decimal 参数 | 已定义 | 已实现 | 已实现 | 精确 TEXT | 精度和小数位校验 |
| string regex | 方言待定 | 保留约束 | 已实现 | 保存字符串 | 不执行正则 |
| float、datetime | 运行时细节待定 | 已实现 | 已实现 | 待实现 | 待实现 |
| 静态可展开泛型别名 | 已定义 | 已实现 | 保留并展开 | 使用展开类型 | 使用展开类型 |
| `type<T>` 类型值和字段描述值 | 已定义 | 已实现 | 已实现 | ConfigGroup 类型值 TEXT；一般业务字段待实现 | 待实现 |
| Decodes 实例引用 | 已定义 | 已实现 | 已实现 | 待实现 | 待实现 |
| 实体引用 | 已定义 | 已实现 | 已实现 | 保存 ID | 强类型引用、显式解析 |
| 本地/外部 code | 已定义 | 已实现 | 已实现 | TEXT | 枚举 / 字典专属字符串 |
| collection | 已定义 | 已实现 | 已实现 | 记录和成员表 | 不可变引用集合 |
| value、values、mapping | 已定义 | 已实现 | 已实现 | 内置条目和 ConfigGroup 映射子表；一般业务字段待实现 | 待实现 |
| self 依赖、alias、attrs、field_mapping | 已定义 | 已实现 | 结构化表达式 | 待实现 | 待实现 |
| flags | 已定义 | 已实现 | 已规范化 | 业务值待实现 | 业务值待实现 |
| decorator、targets、重复元信息 | 已定义 | 已实现 | 已绑定 | 使用时间与维度元信息 | 不执行自定义代码 |
| snapshot / temporal | 已定义 | 已实现 | 已实现 | 独立时间表 | 精确点与稀疏区间 |
| scd | 已定义 | 已实现 | 已实现 | 显式期间 | 起点、变化与缺口 |
| dimension | 已定义 | 已实现 | 已绑定 | 非空键列 | 必填显式参数 |
| sparse / dense | 已定义 | 类型、互斥、分组冲突和补全已实现 | 已绑定 | 按继承根与 cat 的长表 / 宽表 | 复用同一读取语义 |
| Decodes、Hierarchy、ConfigGroup 存储 | 已定义 | 静态已实现 | 保留 | 身份宽表和条目/映射子表 | 选择和覆盖已执行；通用内置 handle 待实现 |
| 七个非正常结果 | 已定义 | 已实现 | 保留 | 三种字段状态 | 统一结果对象 |
| computed、参数推导、recover、PARTIAL | 已定义 | 已实现 | 独立 AST 和依赖/参数图 | 不生成物理字段 | 类型化单次/批量计算 |
| Hierarchy 回退与有效 ConfigGroup | 已定义 | 已实现 | 命名维度及配置契约 | 批量候选与配置读取 | 共享精确运算与结果处理 |

对应验收集中于编译器 `tests/storage/`、`tests/ir/test_schema.py` 和 LSP/高亮对照测试。

## 自包含包与 JSONL 仓库

生成包只依赖 Python 3.14+ 标准库，携带公共运行时的同源副本、IR 和专用
`runtime-contract.json`。运行时核对生成代码固定的契约 SHA-256，严格解码版本与结构；
契约包含生成阶段已校验的类型、映射、实现、默认值和字典，不在读取时重编译 IR。
`open_sqlite(path)`、`open_files(path)` 均返回 `ReadResult[Reader]`；`open(path)` 保留为 SQLite 别名。

生成目录的 `repository/` 是 JSONL 空仓库模板，已初始化内置字典。元数据为
`repository.json`，包括文件格式修订号 1、布局修订号 5、模型摘要和所有表文件的 SHA-256。
每张表对应 `tables/<表名>.jsonl`，包括空表；每行必须提供完整物理列。
整数、Decimal、日期及引用 ID 使用精确文本，bool 使用整数 0/1。

打开只检查元数据和文件状态。表首次访问才读取、核对摘要、检查行并建立会话内索引。
每次新增后端读取前检查全部文件状态，首次读取前后均检查；发现变化后禁止继续补充数据，
已有字段缓存仍可使用。仓库更新后须重新打开。不支持会话中原地改写。
重复 JSON key、非标准数值、未知列、重复主键、错误状态及载荷组合均拒绝，诊断带文件和行号。

`schema-relations.puml` 使用 PlantUML 展示全部表及字段，包含 SQL 类型、可空性和主键列顺序。
连线连接具体字段：实线为实际外键，虚线为逻辑归属或实体引用；复合外键的各列使用同一分组标签。
引用标签保留逻辑字段身份，以及共享载荷列使用的字段判别条件。相同 PlantUML 源码嵌入
`schema.md`，图形显示需要 PlantUML 渲染器。图、DDL 和文档均来自同一份结构化存储模型。
`python-schema.md` 列出实体、属性、记录类、方法、后端入口和缓存约定，使用相同元信息。
SQL、JSONL、manifest、文档及关系图共用存储模型。

## 显式实例校验

`reader.validate()` 返回 `ReadResult[ValidationReport]`，报告及问题列表不可变。
普通打开和取数不会扫描整个仓库。包内命令为：

```console
python -m fmc_model check-data --backend sqlite --path example.db
python -m fmc_model check-data --backend files --path example-repository
```

有效数据退出 0，数据违规或读取失败退出 1，用法错误退出 2。读取失败为外层 ERROR。
引用环按继承根与逻辑 attr 分别检查，单引用和引用集合均参与，override/overload 共用身份。
不同 attr 不合并，跨根引用不参与；维度按相同组合、snapshot 按同日、SCD 按共同有效期间检查。
非正常状态和悬空引用不产生有效环边；不存在目标仍由 resolve 返回 ENTITY_NOT_FOUND。
每个成环分量给出确定性的一个闭合 ID 路径，并报告字段、维度及日期或期间，不枚举全部环。

FMC 示例初始化器从同一份数据创建 SQLite 或 JSONL，并在结束前显式校验；只接受新目标。
本阶段仍无生产写入、迁移、SQLite 导出命令或通用查询语言，计算执行范围见 [计算字段](computations.md)，不提供汇率换算或多 Hierarchy 自动组合。
