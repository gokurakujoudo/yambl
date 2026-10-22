# YAMBL 语法说明

本文记录当前案例使用的语法及已确认的语义。对应的首版解析、静态检查与格式化
工具位于 `yambl-compiler`。
自定义值类型的定义方式暂不纳入本轮设计，尚未引入 `type` 声明或别名语法。

## 命名

| 名称类别 | 命名约定 | 示例 |
| --- | --- | --- |
| 实体类型 | `PascalCase` | `Fund`、`HoldingEntry`、`Security` |
| 值类型 | `snake_case` | `string`、`date`、`decimal` |
| 字段 | `snake_case` | `fund_id`、`net_asset`、`holdings_entry_id` |

## 类型说明

内置值类型清单、使用示例及类型参数规则见
[内置值类型](../builtins/value-types.md)。自定义值类型的声明仍暂缓定义。

`collection<T>`、`values<T>` 和 `map<TKey, TValue>` 的泛型约束及语义见
[内置集合类型](../builtins/collection-types.md)。

内置值类型原语 `code<decodes_id>` 通过实例名称指定代码字典，支持
`code<Currencies>` 和 `code<'Currencies'>`。未定义的字典逐处产生 warning，
不阻止检查通过。具体语义见 [code](../builtins/value-types.md#code)。

## 字符串与元信息

字符串使用单引号，内部使用 `\'` 表示单引号，例如 `'Security\'s currency'`。
当前解析器也保留反斜杠转义的原始拼写；读取字符串值时 `\\` 表示反斜杠，
其他转义（例如正则中的 `\d`）保持原样，不据此选定正则方言。

`@title('...')` 和 `@description('...')` 为其后的实体、Decodes 声明或字段
添加标题和描述。每个目标上的同名元信息只能出现一次。它们不改变字段类型。

```text
entity Security {
    @title('Currency')
    @description('Security\'s currency')
    attr currency: code<'Currencies'>
}
```

格式化器保留字符串拼写，包括 `\'`、空格和 `#`；字符串不能跨物理行。

## 注释

行尾注释的标准格式为：正文、两个空格、`#`、一个空格、注释文本。注释延续到
当前行末尾，例如：

```text
attr quantity: decimal  # 持仓数量
attr amount: decimal[18, 4]  # 总位数为 18，小数位数为 4
```

允许行首注释，即独占一行的注释，使用 `#`、一个空格和注释文本：

```text
# 基金模型
entity Fund {
    id fund_id: string['[a-zA-Z0-9]{12}']  # 基金标识
}
```

字符串内部的 `#` 属于字符串内容，不开始注释，例如：

```text
attr code: string[regex: '[A-Z#]+']  # 正则表达式包含井号
```

注释前后的空格数量不影响解析，不因数量不符而报语法错误。格式化器统一将
行尾注释修正为正文后两个空格、`#` 后一个空格；行首注释也统一为 `#` 后一个
空格。格式化器不改动字符串内部的空格或 `#`。

例如，以下输入允许解析：

```text
#基金模型
attr quantity: decimal #持仓数量
```

格式化后为：

```text
# 基金模型
attr quantity: decimal  # 持仓数量
```

## 命名空间与文件

当前业务案例在文件开头使用以下写法：

```text
namespace core
```

`core/` 中的三个实体文件使用 `namespace core`；字典已拆分到
`decodes/currencies.yambl`，使用 `namespace decodes`。
`core/security.yambl` 显式导入字典：

```text
from decodes import Currencies
```

完整案例和待定解析规则见[命名空间与跨文件引用](namespaces.md)。

命名空间由显式声明决定，一般建议与目录结构一致，但不强制对应。同一命名空间
的声明可跨文件直接引用；跨命名空间的导入仅在当前文件有效。

## 文件格式

格式化器使用四空格缩进，统一为 LF 换行。最后一条内容后有且仅有一个换行符
（`\n`），使编辑器显示一个空白末行；删除额外的末尾空白行。解析器允许缺少
末尾换行，由格式化器补齐。文件内部连续空白行缩减为一个，字符串内容和声明顺序
保持不变。

## Decodes 实例声明

`decodes` 是声明内置 `Decodes` 模型实例的专用关键字，实例使用复数名称：

```text
decodes Currencies {
    - 100 CNY: 'CNY'
    - 200 USD: 'USD'
}
```

条目形式为 `- ordering code: decode`。本例的 `ordering` 是整数，`code`
使用裸词元，`decode` 使用单引号字符串。`ordering` 是使用方的升序排序基准，
不会使 `entries` 集合具有顺序。模型定义及字段映射见 [Decodes](../models/decodes.md)。

`Decodes` 按 `decodes_id`、`DecodesEntry` 按 `(decodes_id, code)` 分别具有
单例身份，条目不需要额外的 `id` 字段。`Decodes` 禁止继承，声明中的字典
名称表示实例，不能作为实体类型使用。

```text
attr x: code<Currencies>  # 合理取值为 Currencies.CNY
attr y: Decodes  # 合理取值为 Currencies
```

`Currencies.CNY` 是字典限定的代码值写法。`attr x: Currencies` 不合法，
因为 `Currencies` 是字典实例名称。

## 实体与标识字段

使用 `entity` 和花括号声明实体类型，在实体内使用 `id 字段名: 类型` 声明
标识字段：

```text
entity Fund {
    id fund_id: string['[a-zA-Z0-9]{12}']
}
```

案例中字符串参数的含义与待定规则见[内置值类型](../builtins/value-types.md)。

证券案例使用同一形式描述证券标识：

```text
entity Security {
    id security_id: string['[a-zA-Z0-9]{12}']

    attr currency: code<Currencies>
}
```

持仓条目的标识声明为：

```text
id holdings_entry_id: snowflake_id
```

`snowflake_id` 是内置值类型；该声明本身不规定 ID 生成行为。位结构与生成策略
见[内置值类型](../builtins/value-types.md#snowflake_id)。实体身份的作用域以及
是否支持组合标识仍待确定。

## 属性与引用

使用 `attr 字段名: 类型` 声明普通属性：

```text
attr security: Security
attr quantity: decimal
```

实体类型字段默认表示实体引用，因此 `security` 引用一个 `Security` 实体。
值类型字段描述值，因此 `quantity` 的类型是 `decimal`。实体引用无需额外的
`ref` 关键字。

`collection<HoldingEntry>` 表示无序且不重复的持仓条目实体引用集合，不表示
内嵌实体。值的集合使用 `values<T>`，键值映射使用 `map<TKey, TValue>`；
类型参数限制统一在 [builtins](../builtins/collection-types.md) 中定义。

## 独立快照属性

使用 `snapshot attr 字段名: 类型` 声明快照属性。当前案例将时间注解放在
对应属性的前一行：

```text
@temporal(as_of_date: date)
snapshot attr holdings: collection<HoldingEntry>

@temporal(as_of_date: date)
snapshot attr net_asset: decimal
```

`@temporal(as_of_date: date)` 描述该属性的时间参数，参数名为 `as_of_date`，
类型为 `date`。两个属性的快照相互独立；相同的时间参数不会将它们合并成
必须同时存在的整体快照。

YAMBL 在此处仅描述模型，不校验业务数据的完整性或其他数据质量。
例如，模型不要求同一日期的持仓和净资产同时存在，也不检查两者的数据一致性。
语言的语法检查与业务数据质量校验是不同的职责。

时间参数的其他形式以及通用注解机制仍待确定。

## 扩展、继承与属性模式

`extend EntityName { ... }` 将属性直接补充到对应实体的定义中，不创建独立实体、
子类型或命名空间符号。属性元信息保留其原始定义位置（文件、行、列），用于诊断
和源码追踪。格式化仍保留源文件中的 `extend` 块。跨文件解析后，合并的字段参与
继承和重名检查；字段中的名称按照它实际声明所在文件的导入解析。

```text
entity Security {
    id security_id: string
}

extend Security {
    @temporal(as_of_date: date)
    @dimensions(source: code<'PriceSources'>)
    snapshot attr price: decimal

    config attr price_fallback_days: integer = 20
}

entity Bond inherits Security {
    attr coupon: decimal

    @temporal(as_of_date: date)
    scd attr notional_value: decimal
}
```

`inherits` 指定父实体；子类型获得父类型的字段，并可增加字段。`Bond` 因而拥有
`security_id`、`price`、`price_fallback_days`、`coupon` 和 `notional_value`。
当前支持单继承；循环继承、同一实体内部或扩展产生的重复字段均报错。
父子属性重声明须使用 `@override`，不同分支的同名属性须使用 `@overload`。
签名一致性、逻辑字段身份及 `final entity` 规则见[字段关系](field-relationships.md)。
扩展只能添加属性，不能补充 `id`；final 实体禁止扩展。父类型和扩展目标按当前文件可见名称查找。
`Decodes` 禁止继承，字典实例也不能作为父类型。当前编译器尚不支持扩展内置实体
或继承其他内置实体；ConfigGroup 明确声明为 final。

父类型或其他子类型的实例允许获取子类型特有字段；字段不适用于该实例的实际
类型时，结果为内置常量 [NOT_DEFINED](../builtins/constants.md)。例如普通
`Security` 或另一个 `Security` 子类型实例获取 `Bond.coupon` 对应的字段，
结果为 `NOT_DEFINED`；`Bond` 及其子类型可拥有该字段的实际值。
这是实例读取的语义约定，当前检查器不执行实例读取或生成运行时代码。

| 属性形式 | 含义 |
| --- | --- |
| `attr` | 普通属性，不自动用于条件筛选 |
| `static attr` | 时间无关、可用于索引筛选的属性 |
| `snapshot attr` | 按时间参数描述独立快照 |
| `scd attr` | SCD Type 2 时间相关属性，保留变化历史 |
| `config attr` | 与时间无关、可作为参数被配置覆盖的属性 |

`@temporal(as_of_date: date)` 可用于 `snapshot` 和 `scd`，不能用于 `config` 或 `static`。
`@dimensions(source: Type, ...)` 描述属性的附加维度；维度名为 `snake_case`，
同一属性中不能重复，类型遵循现有类型规则。示例用外部字典描述价格来源，
不要求模型内声明该字典，也不检查实际数据维度是否完整。

`config attr name: Type = literal` 可声明默认值，也可省略 `= literal`。
当前编译器支持 `integer`、`snowflake_id` 的整数字面量，`float`、`decimal`
的数字字面量，`string` 的单引号字面量，以及 `bool` 的 `true` / `false`。
其他类型的默认值语法与配置覆盖的来源、优先级仍待设计。当前只进行静态描述和
字面量类型检查，不实现配置求值、SCD 历史存储或有效期边界计算。

## 案例状态与待定规则

最新完整文件位于
[fmc-data-model](https://github.com/gokurakujoudo/fmc-data-model) 仓库的
`core/` 和 `decodes/` 目录。实体、字典和跨文件名称解析已可由首版编译器检查，
案例使用的 `snowflake_id` 已纳入内置值类型。

后续还需确定完整词法字符集、其他字符串转义、声明分隔规则及运行时映射。
当前编译器的实现边界见其 README；文件与仓库解析规则见命名空间文档。

## 条件配置组与依赖字段类型

[ConfigGroup](../models/config_group.md) 是内置 final 实体。
`type<Entity>`、`type<Security>` 和 `field_mapping<static, self.selected_kind>`
的约束与任意类型字段引用见[实体类型与字段映射](../builtins/field-mapping.md)。
这些声明已由编译器及 LSP 支持；配置组实例语法和配置执行尚未实现。
