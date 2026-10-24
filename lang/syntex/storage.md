# SQLite 存储与 Python 读取

`yambl generate` 从已校验的 JSON IR 生成 SQLite DDL、`schema.md` 表结构参考、
`storage-manifest.json` 和带 `py.typed` 的 Python 包。生成只接受新目录或空目录；
`--dryrun` 完成校验和渲染，不创建目录。不执行数据库迁移，不提供生产写入 API。

```console
yambl compile -o path ../fmc-data-model -o output ./build/model.yambl-ir.json
yambl generate -o path ./build/model.yambl-ir.json -o output ./build/generated -o package fmc_model
```

## 表结构

每个业务根实体有一张身份表，保存 ID 和实际实体类型；同一继承树共享 ID 空间。
static 字段按根实体和维度结构分组，config 单独分组。普通 `attr` 是 `static attr`
的简写；源码格式化保留写法，签名、筛选和 IR 都使用 static。
`AttrCats.Static`、Config、Snapshot、Scd 的位值分别为 2、4、8、16，All 为 30。
`AttrCats.Attr` 已移除。`@dimension` 允许 static、snapshot、scd，禁止 config。

每个逻辑 snapshot/SCD 字段有独立时间表；关系声明共享逻辑字段存储，但读取使用
实际实体上的实现约束。维度列非空，参与键；维度名称或类型不同就分表。
Hierarchy selector 是元信息，不是维度列，本阶段必须显式提供全部维度。

每个字段独立保存 VALUE、NO_ENTRY、EMPTY、NOT_APPLICABLE 状态。缺行或字段状态
NO_ENTRY 表示无记录；EMPTY 的载荷为 NULL。集合有记录表和成员表，成员引用去重；
VALUE 记录存在但无成员表示正常空集合。实体引用不建立强制目标存在的外键；集合
成员对其记录表建立外键。外部写入程序必须为连接启用 `PRAGMA foreign_keys = ON`。

Decimal、整数和相应 ID 使用 TEXT，避免 SQLite 数值精度限制。bool 使用 0/1，
date 使用 ISO 日期。本地字典代码校验成员身份，外部字典只保存带字典类型的字符串。
不执行任意正则，不生成 Snowflake ID。数据库保存布局修订号和模型摘要，读取器要求匹配。

`schema.md` 包含全部表、列、主键、CHECK、外键、索引、逻辑字段映射和各表 DDL。
文档区分模型默认值与 SQL 默认值，区分逻辑引用与实际外键；它与 SQL 和 manifest
由同一份存储模型生成。

## 时间和结果

snapshot 点查询匹配指定日期，区间查询返回 `[start, end)` 内已有记录。SCD 两个
边界均非空，范围为 1900-01-01 至 2999-12-31，开始严格早于结束；最大日期仍是
排他的结束边界。SCD 点查询返回当日状态，区间查询返回起点及后续期间边界的状态，
缺口为 NO_ENTRY，重叠为 ERROR。相邻期间同一天只产生一个点，结果按日期升序。
空区间成功返回空列表，反向区间报 ERROR。

生成的实体是携带只读会话的 handle，通过 `read_*` 方法显式取数。引用返回
`EntityRef[T]`，通过 `reader.resolve(ref)` 显式解析。批量身份读取保持输入顺序和重复项。
会话使用 SQLite 只读连接和固定读取事务，关闭后 handle 不再可用。

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
EMPTY 和 NOT_APPLICABLE 不回退。不执行 ConfigGroup、Hierarchy、价格回退或运算传播。

## 能力清单

下表的“静态”包括 Python 检查器和 LSP；IR 保留完整语言能力，后端只接受已实现的业务类型。
不支持的业务字段会报告身份、源码位置和原因；未使用的内置声明不阻止生成。

| 能力 | 规范 | Python / LSP | IR | SQLite | Python 类型 / 读取 |
| --- | --- | --- | --- | --- | --- |
| namespace、import、仓库根、qualified name | 已定义 | 已实现 | 已解析 | 使用身份映射 | 使用身份映射 |
| entity、继承、final、extend | 已定义 | 已实现 | 已实现 | 根身份与有效字段 | 实际子类型 handle |
| override、overload、exact | 已定义 | 已实现 | 保留实现与共同契约 | 共享逻辑存储 | 按实际实现校验 |
| attr/static 统一、类别筛选 | 已定义 | 已实现 | static | 分组表 | 显式方法 |
| config 默认值 | 已定义 | 已实现 | 已实现 | 独立状态 | NO_ENTRY 使用默认值 |
| string、bool、integer、decimal、date、snowflake_id | 已定义 | 已实现 | 已实现 | 已实现 | 已实现；不生成 ID |
| decimal 参数 | 已定义 | 已实现 | 已实现 | 精确 TEXT | 精度和小数位校验 |
| string regex | 方言待定 | 保留约束 | 已实现 | 保存字符串 | 不执行正则 |
| float、datetime | 运行时细节待定 | 已实现 | 已实现 | 待实现 | 待实现 |
| 静态可展开泛型别名 | 已定义 | 已实现 | 保留并展开 | 使用展开类型 | 使用展开类型 |
| `type<T>` 类型值和字段描述值 | 已定义 | 已实现 | 已实现 | 待实现 | 待实现 |
| Decodes 实例引用 | 已定义 | 已实现 | 已实现 | 待实现 | 待实现 |
| 实体引用 | 已定义 | 已实现 | 已实现 | 保存 ID | 强类型引用、显式解析 |
| 本地/外部 code | 已定义 | 已实现 | 已实现 | TEXT | 枚举 / 字典专属字符串 |
| collection | 已定义 | 已实现 | 已实现 | 记录和成员表 | 不可变引用集合 |
| value、values、mapping | 已定义 | 已实现 | 已实现 | 待实现 | 待实现 |
| self 依赖、alias、attrs、field_mapping | 已定义 | 已实现 | 结构化表达式 | 待实现 | 待实现 |
| flags | 已定义 | 已实现 | 已规范化 | 业务值待实现 | 业务值待实现 |
| decorator、targets、重复元信息 | 已定义 | 已实现 | 已绑定 | 使用时间与维度元信息 | 不执行自定义代码 |
| snapshot / temporal | 已定义 | 已实现 | 已实现 | 独立时间表 | 精确点与稀疏区间 |
| scd | 已定义 | 已实现 | 已实现 | 显式期间 | 起点、变化与缺口 |
| dimension | 已定义 | 已实现 | 已绑定 | 非空键列 | 必填显式参数 |
| Hierarchy、ConfigGroup | 部分运行时规则待定 | 静态已实现 | 保留 | 待实现 | 待实现 |
| 七个非正常结果 | 已定义 | 已实现 | 保留 | 三种字段状态 | 统一结果对象 |
| 回退、比较、运算传播 | 未定义 | 无执行器 | 不附加规则 | 不执行 | 不执行 |

对应验收集中于编译器 `tests/storage/`、`tests/ir/test_schema.py` 和 LSP/高亮对照测试。
