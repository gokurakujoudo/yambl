<a id="transaction-documents"></a>
# 事务文档

`.yaplan` 描述按组组织的模型数据修改；`.yatran` 记录执行的 Plan 及修改前后的业务数据。
两种格式均使用无 BOM 的 UTF-8、LF 换行、四空格缩进和一个末尾换行符。

<a id="plans"></a>
## Plan

Plan 包含名称、格式版本和具名 group。可选的模型语义摘要将 Plan 绑定到特定的编译模型。
名称使用 ASCII 标识符，实体和属性使用模型中的完整名称。

```text
plan settings {
    version 1
    model 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    group fallback {
        update core.Security (security_id, price_fallback_days) {
            'SEC000000001', 10
            'SEC000000002', 15
        }
    }
}
```

上面的摘要只用于说明格式。提供摘要时必须与实际模型一致；省略时，Plan 按执行时选择
的模型检查。生成的 Python 包通过 `MODEL_DIGEST` 提供模型摘要。group 名称在一个 Plan
内唯一。每个操作声明一次列，每行数据的值数量必须与列数一致，且占用一个物理行。
嵌套的集合和对象字面量与其记录写在同一行。

操作通过 ID 定位实体，包括同一 Plan 先前插入的实体。同一实体的同一逻辑属性在一个
Plan 中只能修改一次，即使操作选择的日期或维度互不相交也是如此；insert 提供的属性值
也算一次修改。不同实体或不同属性可分别修改。不能通过非 ID 条件查找并修改此前在同一
Plan 中插入或修改的实体；当前操作语法只支持按 ID 选择。

| 操作 | 形式 |
| --- | --- |
| 插入实体 | `insert Entity (id_column, field, ...) { ... }` |
| 更新实体属性 | `update Entity (id_column, field, ...) { ... }` |
| 删除实体 | `delete Entity (id_column) { ... }` |
| 删除实体及其自有数据 | `delete Entity owned_data delete_all (id_column) { ... }` |
| 替换属性范围 | `replace Entity.field scope (...) columns (...) { ... }` |
| 删除属性范围 | `delete Entity.field scope (...)` |

scope 条件使用 `coordinate=value` 或 `coordinate in [start, end)`；区间包含起点，
不包含终点。每个 scope 都必须包含所属实体 ID 的等值条件。维度和时间条件可省略，
省略时包括该实体该属性在相应坐标上的全部数据。维度和时间坐标名由模型决定；同一
scope 内坐标名不能重复。替换行描述目标范围内的完整数据。

`replace` 和 `delete` 可在目标之后、`scope` 或 `owned_data` 之前使用 `expect one`
或 `expect any`。`expect one` 要求恰好匹配一条已有记录，`expect any` 要求至少一条；
不满足时整个 Plan 在提交前失败。省略 `expect` 接受任意匹配数，包括零。删除实体时，
不存在的 ID 会被跳过，计数只包含请求中实际存在的实体；类型和自有数据检查仍然执行。

属性操作按替换或删除之前匹配的记录计数，包括拆分前与范围相交的 SCD 记录。集合算作
一条属性记录，其成员不增加计数。替换行是新的内容，不决定预期匹配数。

`insert Entity` 块可包含多个实例，每行一个。ID 和需要提供的无时间、无维度属性，
包括 static 集合，写在同一行。未提供的字段保持 `NO_ENTRY`。时间和维度记录使用单独的
属性操作。例如，以下片段假设模型中存在对应的 `core.Security`：

```text
insert core.Security (security_id, currency) {
    'S1', 'CNY'
    'S2', 'USD'
}
replace core.Security.price scope (security_id='S1') columns (as_of_date, value) {
    '2026-01-01', 100
}
```

<a id="data-literals"></a>
## 数据字面量

字符串、布尔值、数字、集合和对象使用 YAMBL 写法：

```text
'quoted text'
true
-12345678901234567890.125
['first', 'second']
{code: 'CNY', decode: 'Chinese yuan', ordering: 100}
decodes.Currencies.CNY
```

数字保留精确的整数或十进制值。字符串中的 `\'` 和 `\\` 分别解码为单引号和反斜杠；
其他反斜杠序列保留原有写法。字符串外的 `#` 开始注释。符号引用按模型解析；表达式和
函数调用不是数据字面量。

<a id="transaction-records"></a>
## 事务记录

事务外层包含 ID、版本、UTC `time`、完整性 `digest`、已执行的 `plan` 块以及结果
`group` 块。生成的 ID 是以字符串保存的十进制 Snowflake ID；规范的 UUID ID 也可读取。
回滚记录在 `source` 中以字符串保存源事务 ID。内嵌 Plan 始终保存实际模型摘要，即使
提交的 Plan 省略了摘要也是如此。

生成器使用 worker ID 0，不跨进程持久化状态，也不协调不同仓库。以相同 worker ID
重启前，调用方须确保墙钟时间已经超过上一次生成 ID 的时间。

`time` 使用 `YYYY-MM-DDTHH:MM:SS[.fraction]Z`，日期必须有效；年份为 0001–9999，
小时为 00–23，分钟和秒为 00–59。小数秒可省略。写入器记录 UTC，不接受时区偏移或
其他日期分隔符。数值在运行时 integer 和 Decimal 的范围内保持精确；为计算完整性摘要
展开数字时若超出运行时资源，文档会被拒绝并给出诊断。

每个结果 group 包含 `change` 块和可能出现的 `warning` 字符串。change 指定目标和已解析
的 `scope`，之后是 `before` 与 `after` 映像。每个映像使用完整业务目标名称、列清单，
并且每行保存一条记录。多个映像可保留实体及其自有字段等相关数据；空映像表示不存在。
结果 group 对应内嵌 Plan 中的 group。

SHA-256 摘要覆盖规范化后的文档内容，但不包括摘要本身。注释、缩进以及等价的十进制
写法不影响完整性。格式化验证摘要并保留字面量写法、注释和行顺序。业务载荷保留在
事务文件中；警告说明冲突，不重复保存这些载荷。

<a id="python-document-tools"></a>
## Python 文档工具

`yambl_compiler.languages.yaplan.syntax.parse(text)` 返回带类型的 `Plan`；
`yambl_compiler.languages.yatran.syntax.parse(text)` 返回已验证的 `Transaction`。
两者都使用 Lark，语法和共享词法规则位于 `grammars/`。
`languages.shared.documents.parse(text)` 根据文档头选择语言。无效文档抛出
`languages.shared.syntax.DocumentError`，其中行号和列号从 1 开始。

`languages.shared.formatting.format_document(text)` 验证并格式化任一种文档。
`transactions.writing.dumps(document)` 在返回前验证序列化内容；
`languages.yatran.writing.seal(transaction)` 为新构造的记录填写完整性摘要。
这些模块路径相对于 `yambl_compiler`；使用生成数据包中的副本时，相对于该包。
生成包声明 lclang 和 Lark 依赖，版本来自编译器，并包含数据语言的语法文件。

<a id="plan-validation"></a>
## Plan 校验

`ExampleData.validate_plan_syntax(plan_path)` 检查文档语法和结构、可选模型摘要、
相互独立的写入目标、实体名、可写字段名、坐标及模型约束下的字面量类型。它使用生成包
内置的契约，不打开业务数据仓库。ID 和引用只检查类型兼容性，不检查实例是否存在。

`data.validate_plan_expectations(plan_path)` 先执行上述检查，再针对一个一致的仓库快照
检查显式 `expect one` 和 `expect any`。它追踪 Plan 中先前按 ID 插入的身份和写入建立的
行坐标，但不构造完整候选。新插入实体的 static 身份行可以满足期望；其时态属性在写入
数据之前没有记录。这两个方法都不写入数据、不恢复导出、不创建 Transaction；成功时
返回解析后的 Plan，内容无效或检查失败时抛出 `ValueError`，文件 I/O 错误向上传播。

这些检查不预留数据，也不保证之后一定能提交。`apply` 检查候选中修改过的行、归属、
SCD 区间、配置及受影响的引用环，并假设未修改的存储数据原本有效；完整扫描仓库可使用
`check-data`。按 ID 操作可以指向同一 Plan 中先前插入的实体。

<a id="extending-model-dictionaries"></a>
## 扩展模型字典

Plan 可以完整替换普通显式 Decodes 字典的 entries，但必须保留模型提供的每个条目的
code、decode 和 ordering。可增加运行时条目，以后也可修改或删除这些新增条目。code 在
字典内保持唯一，字典本身不能删除。flags 和派生子类型字典及其条目只读；外部动态字典
仍使用其现有规则。

Plan 操作按顺序检查，因此可以先扩充字典，再在后续操作中使用新增 code。
`validate_plan_syntax` 使用模型和 Plan 中此前的完整替换结果，无法知道仓库已有的其他
成员。`validate_plan_expectations` 使用仓库快照并追踪此前的字典更改；`apply` 在提交前
检查最终候选。

如果最终候选仍使用某个新增 code，包括在时态字段、维度或配置映射中使用，删除或改名
该 code 会失败。回滚使用相同保护。完整数据校验会报告损坏的模型条目和非法 code。

<a id="configured-data-operations"></a>
## 按配置操作数据

生成包提供与模型对应的数据接口，例如 `ExampleData`。
`await ExampleData.create(config_path)` 初始化新仓库；
`await ExampleData.open(config_path)` 打开已有仓库并恢复待导出的事务。
配置或模型不匹配时两者都拒绝执行。

创建操作拒绝已存在的目标。它在目标目录中的临时位置准备并检查初始数据，关闭相关
资源后再重命名到配置路径。重命名前中断时目标仍不存在；重命名后中断时仓库完整且可
打开。进程突然退出可能留下尚未发布的临时准备目录。

`.lclcfg` 入口要求 `backend: 'sqlite'` 或 `backend: 'files'`，以及非空的 `path`
字符串。lclang 加载并求值配置；相对仓库路径以入口配置文件所在目录为基准。

`data.read()` 创建一致的带类型读取会话。`data.apply(plan_path)` 提交整个 Plan。
`data.rollback(transaction_path, groups=None)` 回滚全部 group 或指定名称的 group。
后两者均返回事务 ID、受管理的文件路径、变更数和冲突警告。`data.export(id)` 重新导出
已提交的事务文件。使用完成后关闭读取会话和数据接口；数据接口也支持 `with`。

回滚比较类型化值时使用无序集合与 mapping 语义，包括 ConfigGroup 映射内嵌套的集合；
调整顺序不会产生冲突。冲突的属性或范围被跳过并产生警告，其他符合条件的更改一起
提交；新事务同时记录已执行的更改和跳过的冲突。

生成包通过 lclang workflow 提供相同操作：

```sh
python -m example_model create -o config sqlite.lclcfg
python -m example_model apply -o config sqlite.lclcfg -o source demo.yaplan
python -m example_model check-data -o config sqlite.lclcfg
python -m example_model rollback -o config sqlite.lclcfg -o source transaction.yatran -o groups "LCL[['prices']]"
```

后端由仓库配置选择。CLI 覆盖参数遵循 lclang 语法；`LCL[...]` 标记表达式，可用于
group 名称列表。`--dryrun` 检查配置和输入语法，不提交、不恢复导出，也不清理文件；
它不针对存储数据验证候选写入。`check-data --dryrun` 执行只读数据校验。

apply 和 rollback 使用固定快照。同一时间只允许一个进程写入或恢复一个仓库；生成接口
不协调跨进程写入。SQLite 在一个原生事务中更新受影响的行和事务记录。文件后端将更改
的表流式写入新的不可变代际，以硬链接复用未更改的文件。本地文件系统和进程必须支持
硬链接；无法创建时在代际切换前发布失败。外部写入可能修改多个代际共享的硬链接文件。
首次使用索引访问时会验证整张文件表，发布已更改的表时会流式处理整表。恢复测试覆盖
进程中断，不覆盖断电。

`TransactionStatus.EXPORT_PENDING`（`export_pending`）表示数据已提交，但 `.yatran`
导出需要恢复。打开仓库或启动下一次写入会恢复导出；不要重新应用 Plan 来恢复已提交的
事务。跳过的回滚冲突以 `TransactionStatus.CONFLICTS`（`conflicts`）报告，回滚中的其他
更改已经提交。`TransactionStatus.COMMITTED`（`committed`）表示提交时没有冲突。
