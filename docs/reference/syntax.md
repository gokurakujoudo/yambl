# YAMBL 语法总览

YAMBL 描述类型、字段、元信息及计算依赖。本文按语言结构分类；每个主题的详细约束
链接到专门参考。IR、存储结构和 Python API 属于编译产物，不是源语言语法。

## 文件与词法

文件使用 UTF-8 无 BOM、LF、四空格缩进，末尾一个换行符。输入接受 CRLF 和缺少末尾
换行；格式化统一输出。声明、语句不用分号。标识符使用 ASCII 字母、数字和下划线。

| 形式 | 含义 |
| --- | --- |
| `# 注释` | 行注释；字符串内的 `#` 不开始注释 |
| `正文  # 注释` | 格式化后的行尾注释 |
| 独占行 `---` | 开闭不嵌套的 Markdown 文本块，可位于顶层或声明体 |
| `'text'` | 单行字符串；`\'` 为单引号，`\\` 为反斜杠 |
| `123`、`-123` | 整数字面量；计算表达式的负号是前缀运算符 |
| `12.50`、`1e-3` | decimal 数值字面量 |
| `true`、`false` | bool 字面量 |
| `0b00100` | flags 条目的二进制位值 |

字符串中的其他反斜杠转义保留原样。Markdown 不参与语义、不自动绑定声明；正文空白
保留，只统一换行，未闭合报错。文本块外连续空白行最多一个。格式化保留字符串拼写、
声明顺序、注释内容和计算表达式已有的换行。

## 名称与文件作用域

| 对象 | 命名 | 示例 |
| --- | --- | --- |
| entity | PascalCase | Security、HoldingEntry |
| value、透明别名 | snake_case | money、hierarchy_entry |
| 字段、局部变量、参数、dimension | snake_case | price、as_of_date |
| decorator | snake_case，带 `@` 调用 | @extra_input_params |
| decodes | 复数 PascalCase | Currencies |
| 仓库定义的字典 code | PascalCase | Static、WindIndustryLevel1 |
| 编译期常量 | UPPER_SNAKE_CASE | OTHER_INDUSTRY |

以下文件从同一仓库的 `decodes` 命名空间导入已声明的 `Currencies`：

```yambl
namespace core

from decodes import Currencies

entity Security {
    id security_id: string
    static attr currency: code<Currencies>
}
```

每个文件至多一个 namespace，位于 import 和声明之前。同 namespace 的声明跨文件
直接可见；跨 namespace 必须 import，导入只在当前文件生效。暂不接受导入别名或通配符。
名称解析支持前向引用，普通声明不能遮蔽内置名称。

`yambl-root.lclcfg` 标记模型仓库，包含一个静态 `prefix: 'example'`；完整名称由 prefix、
namespace 和声明名组成。目录不决定 namespace。见[名称解析](namespaces.md)。

## 顶层声明

| 形式 | 含义 |
| --- | --- |
| `entity Name { ... }` | 具有身份的实体类型 |
| `entity Child inherits Parent { ... }` | 单继承实体类型 |
| `final entity Name { ... }` | 禁止被继承或 extend |
| `extend Name { ... }` | 增补已有实体的字段或 dimension，不创建新实体 |
| `value name { ... }` | 无 ID 的结构化值类型，天然 final |
| `type name = Type` | 透明类型别名 |
| `type name<a: Constraint> = Type` | 带编译期参数的透明别名 |
| `decodes Names { ... }` | Decodes 实例及其代码条目 |
| `decorator @name(...)` | 有类型和显式 targets 的元信息声明 |
| `const NAME: Type = expression` | 有明确类型的编译期常量 |

Entity 是所有实体的抽象最终基类，不能实例化；未显式继承的实体各自建立业务继承树。
字段的实体类型表示实例引用，保存 ID，不需要额外的 ref。

## 结构化值类型

```yambl
value amount {
    static attr quantity: decimal
    static attr currency: code<'Currencies'>
}
```

value 只有非集合的 static 字段或实体引用，没有 ID、继承、extend 或默认值，禁止
直接或间接值嵌套循环。同类型按所有字段判等，引用字段按 ID 比较，不自动定义大小顺序。

## 字面量与上下文类型

数值默认推断为 integer 或 decimal；字符串和布尔值分别推断为 string 和 bool。
声明类型、带类型的 let、返回类型以及集合元素和结构字段为字面量提供目标类型。
无需给每个值重复写类型构造器。

```yambl
value amount {
    static attr quantity: decimal
    static attr label: string
}

const OTHER_INDUSTRY: string = 'Other'
const UNIT_AMOUNT: amount = {quantity: 1.25, label: OTHER_INDUSTRY}

entity Example {
    id key: string
    computed attr samples: values<decimal> {
        let a: decimal = 1.25
        return [a, 2, 2]
    }
    computed attr totals: mapping<string, decimal> {
        return {'Other': UNIT_AMOUNT.quantity}
    }
    computed attr empty: collection<Example> {
        return []
    }
}
```

`[...]` 根据上下文表示 values 或 collection，去除重复值；无上下文时根据元素推断。
`{key: value}` 根据上下文表示 mapping 或结构化 value。结构值必须完整提供每个字段，
不允许未知或重复字段；mapping 的键必须唯一。`[]` 和 `{}` 缺少足够的类型上下文时报错。
结构字段 key 使用字段名，也接受同名字符串；mapping 的字符串键使用单引号。
集合元素仍须符合 collection/values 的类型约束，字面量不开放嵌套集合存储。

日期、带时区 datetime、字典代码及实体引用可由目标类型解释字符串字面量。
实体引用按目标唯一 ID 类型检查，不查询实例存在性；整数 ID 使用整数字面量。
源码中的已定义字典代码只解析模型已知成员；外部字典不查询数据。类型信息不足时使用显式类型 let。
这些构造用于计算表达式和 const；config 默认值、decorator 实参仍沿用各自的值表达式规则。

## 编译期常量

const 必须显式声明类型，遵循 namespace/import、前向引用和名称冲突规则。
初始化表达式可使用字面量、其他 const、字典代码、纯运算、条件表达式和
[转换函数](functions.md)。依赖循环、类型错误或求值失败阻止编译。
所有分支都检查纯度和类型，仅对选中的分支求值。

const 不能访问 self、input、实例字段、非正常结果，也不能执行查询或任意代码。
它与 exact 类型约束及 EMPTY 等结果状态是不同概念。

## 字段类别

| 形式 | 语义 |
| --- | --- |
| `id name: Type` | 实体标识，不属于 attr，不参与 attrs 筛选 |
| `static attr name: Type` | 时间无关属性；普通 `attr` 为等价简写 |
| `config attr name: Type = literal` | 可配置属性，默认值可省略 |
| `snapshot attr name: Type` | 每个字段独立的日期快照 |
| `scd attr name: Type` | 左闭右开有效期间内的值 |
| `computed attr name: Type { ... }` | 由依赖计算，不生成物理列 |

entity 与 extend 可定义属性，value 只接受 static。不同快照字段使用相同日期参数不表示
同日必须共同存在。配置有效值依次来自匹配 ConfigGroup、实例值、实际子类型默认值；
EMPTY、NOT_APPLICABLE 不触发默认值。读取不适用于实际子类型的字段返回 NOT_DEFINED。

每个具体实体（包括内置实体）具有只读隐藏 static 属性 `entity_type` 和
`root_entity_type`。前者是实例实际类型的 qualified name，类型为 `type<self>`；
后者是所属继承根的 qualified name，类型为 `type<Entity>`。业务根实例的两个值相同，抽象 Entity 不作为
业务继承根。这两个字段可用于计算、static attrs 筛选和 ConfigGroup.when，
其逻辑身份在同一继承根内共享，各实体保留自己的类型约束。源码不得重声明或通过
extend 添加同名字段，也不得 override；Plan 不能写入。

## 类型表达式

| 写法 | 类型或约束 |
| --- | --- |
| `bool`、`string`、`integer`、`float`、`decimal` | 标量；无 int 别名 |
| `date`、`datetime`、`snowflake_id` | 日期、日期时间、标识值 |
| `decimal[18, 4]` | 总精度和小数位数；也可写命名参数 |
| `string['regex']` | 字符串正则约束，未指定执行方言 |
| `Security` | 实例引用 |
| `type<Security>` | Security 或其子类型的类型值 |
| `code<Currencies>` | 已声明字典的代码值 |
| `code<'PriceSources'>` | 当前作用域的字典；未定义时允许外部字典 |
| `collection<Security>` | 无序、引用去重的实体引用集合 |
| `values<string>` | 无序、值去重的值集合 |
| `mapping<string, decimal>` | 无序、键唯一，值不得为集合 |
| `attrs<AttrCats.Static, Security>` | 指定类别的非集合字段描述 |
| `alias<self.kind::value>` | 与依赖表达式同值 |
| `exact<Currencies.USD>` | 常量类型约束，仅用于 override/overload |

方括号参数须全部按位置或全部按名称提供，不允许混用、重复、缺失或未知参数。
`decimal[precision: 18, scale: 4]` 与 `decimal[18, 4]` 等价；`string[regex: 'x']`
与 `string['x']` 等价。命名参数可换序。无参数 decimal 不补隐式精度。

mapping 的键接受 string 兼容类型或实体引用。code、snowflake_id、类型名、字段名可以
单向兼容 string；普通 string 不自动反向转换。值类型没有继承关系。

透明别名实参按位置传入，不支持命名、默认或可变参数。别名体按声明作用域解析，实参
按调用作用域解析；self 依赖须显式传参。循环别名或类型依赖报错，普通实体相互引用合法。
见[类型表达式](type-expressions.md)、[值类型](value-types.md)、
[集合类型](collection-types.md)和[字段映射](field-mapping.md)。

## 字典与 flags

```yambl
decodes Currencies {
    - 100 CNY: 'CNY'
    - 200 USD: 'USD'
}

@flags
decodes Rights {
    - 0b01 Read: 'Read'
    - 0b10 Write: 'Write'
}
```

条目为 `- ordering Code: 'Decode'`。code 在字典内唯一；普通字典的 ordering 表示升序
优先级，不赋予集合顺序。`Currencies.USD` 是代码值，Currencies 是 Decodes 引用值，
不是字段类型。Decodes 是 final entity。

普通显式字典在运行时可以增加条目；模型原始条目的 code、decode 和 ordering 不能修改或
删除，字典本身不能删除。运行时新增条目可修改或删除，code 在字典内仍须唯一。
flags 字典及自动子类型字典完全只读。源码静态检查只解析模型已知成员；运行时新增 code
不会自动成为源码符号。外部动态字典仍遵循原有规则。事务与快照校验见
[事务参考](transactions.md#扩展字典)。

flags 的显式数值仅允许互不重复的正单比特，自动生成 None=0、All=全部位的并集。
同字典代码的 `+` 添加选择，`-` 移除选择，重复操作幂等，按从左到右计算。
AttrCats 位值为 Static=2、Config=4、Snapshot=8、Scd=16、Computed=32、All=62。

### 自动子类型字典

每个具体实体都有 `EntityName::subtypes`，它是一个 Decodes 字典引用，身份为实体完整
qualified name 加 `::subtypes`。抽象 Entity 不提供此字典。字典包含该实体的全部严格后代，
不包含实体自身；叶子实体的字典为空。`code<Security::subtypes>` 是该字典的 code 类型，
`Security::subtypes.Bond` 是其中的 code。code 和默认 decode 使用后代实体短名；同一字典
中出现相同短名时报错。实体类型与子类型 code 不隐式转换。

每个字典独立按同层实体名称升序、深度优先遍历其严格后代，默认从 1 开始编号，
ordering 为编号乘 100。`@decodes_rank(k, decode)` 可修饰有显式父类的实体，且不继承：
先计算所有默认编号，再将该实体在每个字典中的 ordering 改为其父节点在该字典中的最终
ordering 加 k；父节点不在字典中时基数为 0。覆盖不改变其他节点的默认编号。k 可为任意
整数，ordering 可重复，不规定次级排序。

```yambl
entity Security {}

@decodes_rank(-5, 'Bond')
entity Bond inherits Security {}

@decodes_rank(10, 'Convertible')
entity Convertible inherits Bond {}

entity Stock inherits Security {}
```

`Security::subtypes` 中 Bond、Convertible、Stock 的 ordering 分别为 -5、5、300；
`Bond::subtypes` 中 Convertible 的 ordering 为 10。派生字典及其条目只读。

## Decorator

```yambl
@targets(DecoratorTargets.EntityAttr, categories=AttrCats.Static)
decorator @note(text: string = 'Note', *label?: string)

entity Security {
    @note('Name', source: string, description='Display metadata')
    static attr name: string
}
```

普通参数接收非集合值或引用：先位置实参，后命名实参。`*name: Type` 接收一个调用处的
`key: Type` pair，所有 pair 在普通实参之后，按声明顺序匹配。`*name?: Type` 可省略，
可选 pair 必须在末尾。普通参数的默认值使用 `= value`。

每个 decorator 必须有 @targets，默认不可重复，@allow_multiple 开放重复调用。
每次调用隐含可选末尾 string description，可直接写剩余末尾字符串或 description=。
已有普通参数先绑定，description 不出现在形式参数声明中。

| 内置 decorator | 用途 |
| --- | --- |
| `@targets(...)` | decorator 适用对象和属性类别 |
| `@allow_multiple` | 允许重复修饰 |
| `@title(...)`、`@description(...)` | 标题、描述 |
| `@temporal(day: date)` | snapshot/scd 时间参数名 |
| `@dimension(name)` | 引用命名 dimension，可重复 |
| `@extra_input_params(name: Type = value, '说明')` | computed 可选输入，默认值可省略 |
| `@sparse('cat')`、`@dense('cat')` | 无维度、非集合 static 的长表/宽表分组 |
| `@flags` | flags 字典 |
| `@decodes_rank(k, decode)` | 子类型字典中的排序偏移与显示内容 |
| `@override`、`@overload` | 字段关系 |

sparse、dense、dimension 互斥。dimension_ref 和 input_type 是编译期约束，不是存储类型。
完整规则见[元信息](decorators.md)。

## 字段关系

同一实体和其 extend 不能重复定义字段。重声明继承字段必须标 override，保持类别和
元信息契约一致；exact 可收窄原类型，不能更换或放宽已确定的常量。config 默认值可变。

同一继承树不同分支新增同名属性须各自标 overload，保持共同兼容类型和一致元信息。
合法实现共享逻辑字段身份，保留原声明位置。不同业务根的同名字段不合并。两个标记
不能并用，不用于 ID。计算与存储字段不能相互重声明；计算实现可不同，返回类型与
推导输入契约必须一致。见[字段关系](field-relationships.md)。

## Dimension

dimension 定义于 entity 或 extend，由子类继承使用，同作用域重名报错，不接受 decorator。

```yambl
entity Security {
    config attr price_fallback_days: integer = 5
    dimension prices {
        value price_source: code<'PriceSources'>
        hierarchy price_hierarchy: Hierarchy = 'LocalHierarchy'
        fallback_days = self.price_fallback_days::value()
    }
    @temporal(as_of_date: date)
    @dimension(prices)
    snapshot attr price: decimal
}
```

value 必填；hierarchy、fallback_days 可省略。fallback_days 只用于 snapshot。
显式维度值优先于显式 hierarchy，后者优先于声明默认值。最多自动选择一个 Hierarchy，
其余维度须显式提供；无 Hierarchy 时必须提供维度值。snapshot 先按回退窗口内日期倒序，
再按来源 ordering 升序选择；SCD 不跨缺口回退。见[计算规则](computations.md)。

## 计算体

```yambl
entity Position {
    static attr quantity: decimal
    static attr price: decimal
    computed attr market_value: decimal {
        let amount = self.quantity::value() * self.price::value()
        return if amount > 0 then amount else 0
    }
}
```

计算体有零个或多个不可变 let，最后为唯一显式 return。let 可写 `let name: Type = expression`
提供目标类型，也可省略类型由初始化表达式推断。不支持循环、更新赋值和任意
代码执行。lambda 写为 `item -> expression`。if、布尔运算和 recover 惰性执行；所有
分支仍参与静态类型与参数推导。

实体字段在计算值上下文中必须显式调用 `::value(...)`，存储与计算字段使用同一入口。
存储字段按给定日期和全部维度精确读取；计算字段按推导参数求值。只有存储字段支持
`::best_available(...)` 的 Hierarchy 选择和日期回退。

`let x = self.quantity` 不合法，应写 `let x = self.quantity::value()`。
这也适用于 return、运算、lambda 和参数。`self.security.price::value()` 的中间引用
可透明导航；`input.name`、局部变量、结构化 value 的成员继续直接使用。
类型表达式中的无括号 `self.field::value` 仍表示实例依赖，不是计算字段调用。

## 运算符

| 从高到低 | 形式 |
| --- | --- |
| 成员、调用、括号 | `.`、`::`、`(...)` |
| 前缀 | `-x`、`not x` |
| 乘除 | `*`、`/`、`//` |
| 加减 | `+`、`-` |
| 比较 | `==`、`!=`、`<`、`<=`、`>`、`>=`，不支持链式比较 |
| 布尔与 | `and` |
| 布尔或 | `or` |
| 省略回退 | `??`，右结合 |
| 分支、lambda | `if ... then ... else ...`、`x -> ...` |

integer 保持整数精度，与 decimal 混算得到 decimal；decimal 加减乘与求和不按隐式
默认精度截断。`/` 总是返回 float，`//` 返回向下取整的 integer，例如 `-7 // 3 = -3`。
除零、非有限结果、溢出或结果类型精度超限返回 ERROR。
大小比较接受兼容的数字、字符串、日期或带时区 datetime；实体引用、结构值和集合
不自动获得大小顺序。布尔运算只接受 bool。普通类型转换必须显式调用函数。

## 转换与精度处理

| 函数 | 作用 |
| --- | --- |
| `to_string(value)` | 标量或实体引用 ID 转字符串 |
| `to_integer(value)` | 无损转换为整数，拒绝小数部分 |
| `to_decimal(value)` | 精确 decimal 转换，float 保留其二进制实际数值 |
| `to_float(value)` | 无损转为有限 float；近似除法使用 `/` |
| `parse_date(text)`、`format_date(value)` | ISO 日期解析与输出 |
| `parse_datetime(text)`、`format_datetime(value)` | 带显式时区的 ISO 日期时间，规范化 UTC |
| `truncate(value, scale)` | 向零截断，返回 decimal |
| `round(value, scale, mode)` | 按明确模式舍入，返回 decimal |

函数实参先位置后命名，命名参数可换序，禁止重复、未知或缺失实参。
转换错误在计算中返回 ERROR，在 const 中产生编译错误。
完整签名、严格转换边界及示例见[转换函数](functions.md)。

## 输入推导与绑定

未绑定的读取依赖按参数名合并为计算输入，要求类型、约束和默认关系兼容。
`input.name` 引入或重命名参数，普通未知标识符不会变成 input。

`input.price_date ?? input.as_of_date` 只处理参数未提供，不处理 EMPTY 等数据状态。
显式输入值优先于声明默认值，声明默认值优先于 `??`；0、false、空字符串不触发回退。
默认关系循环报错。常量、self 字段或内部表达式绑定依赖后，该依赖不再贡献对应输入；
只有所有同名依赖均绑定时，参数才完全消除。对子计算的绑定只影响其依赖子树。

@extra_input_params 声明可省略的输入和说明，可提供默认值并与依赖推导合并。
外层 best_effort 是整棵计算树的调用上下文，不能局部改写。见[计算规则](computations.md)。

## 点号与双冒号

| 上下文 | 形式 | 含义 |
| --- | --- | --- |
| 字典 | `Currencies.USD` | 字典代码 |
| 计算中的字段路径 | `self.price`、`h.security.issuer` | 选择字段描述；中间的单个引用可透明导航 |
| 计算输入 | `input.as_of_date` | 外部参数 |
| 计算序列 | `holdings.map(...)` | 序列方法 |
| 部分结果 | `p.value`、`p.issues` | PARTIAL 载荷与明细 |
| 类型表达式 | `self.field` | 字段描述，不是字段值 |
| 字段描述 | `Attr::type` | 声明类型 |
| 有实例的字段描述 | `self.field::value` | 实例字段值，可参与依赖类型 |
| 有所属实体的字段描述 | `Attr::entity` | 实际声明实体 |
| 存储字段 | `field::value(...)` | 按明确日期与维度定位 |
| 存储字段 | `field::best_available(...)` | 按 dimension 和回退规则选择 |
| 计算字段 | `field::value(...)` | 显式绑定子计算参数 |

集合不会隐式展开。类型描述与运行时值的成员集合不同；没有实例的 mapping 字段描述
不能读取 ::value。计算中的末端字段必须使用 `self.price::value()` 或
`h.security.issuer::value()` 取值。decorator 的 self 捕获被修饰声明，不能执行实例取数。

## 集合方法

Seq 和 Grouped 是计算过程类型，不是新的物理存储集合。

| 方法 | 输入 → 输出 | 行为 |
| --- | --- | --- |
| `map(f)` | Seq<T> → Seq<U> | 每行映射一次，保留重复贡献 |
| `filter(predicate)` | Seq<T> → Seq<T> | 保留真值行 |
| `flat_map(f)` | Seq<T> → Seq<U> | 展开一层 |
| `group_by(key)` | Seq<T> → Grouped<K,T> | 按类型化键相等分组 |
| `sum_by(value)` | 序列 → 数值；分组 → mapping | 汇总所有贡献 |
| `recover(cases)` | 保持正常值类型 | 只执行匹配的状态分支 |

空序列求和为相应类型的零，空分组为正常空 mapping。读取可共享，业务行的贡献和失败
位置不能因去重丢失。recover 使用 `case EMPTY -> replacement`；未匹配状态原样保留，
重复标签报错。`case PARTIAL as p -> p.value` 显式接受部分结果，其他算子保留 issues。

## 结果状态

| 状态 | 含义 |
| --- | --- |
| NOT_DEFINED | 字段不适用于实际类型 |
| EMPTY | 记录存在但值为空 |
| NO_ENTRY | 所需记录不存在 |
| NO_DATA | 没有满足选择要求的数据 |
| ENTITY_NOT_FOUND | 引用目标不存在 |
| NOT_APPLICABLE | 字段在业务上不适用 |
| ERROR | 读取或计算失败 |
| PARTIAL | 有有效载荷，同时有非错误遗漏明细 |

状态不是字典 code，也不是同名字符串。PARTIAL 必须携带载荷，不进入物理字段状态。
严格聚合不丢弃失败行；best_effort 可略过六种非错误状态，有贡献和遗漏时返回 PARTIAL，
全失败仍失败。ERROR 只能显式 recover。正常空集合和空区间是成功结果。
见[结果](constants.md)。

## 编译与工具边界

静态检查验证语法、名称、类型和依赖；显式数据校验另行检查实例。格式化仅要求语法
可解析。仓库检查扩大到所属根仓库，格式化只处理指定路径。源码检查、IR 独立校验、
生成与数据校验是不同操作。

[IR 契约](ir.md)定义单文件和 Schema；[存储能力清单](storage.md#能力清单)说明各类型
在 SQLite、JSONL 和 Python API 中的实现状态。尚不支持的业务字段在生成前报错。
