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

内置值类型原语 `code<decodes_id>` 通过不带引号的实例名称指定代码字典，
例如 `code<Currencies>`。具体语义见 [code](../builtins/value-types.md#code)。

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

普通属性与快照属性的完整语义、时间参数的其他形式以及通用注解机制仍待确定。

## 案例状态与待定规则

最新完整文件位于
[fmc-data-model](https://github.com/gokurakujoudo/fmc-data-model) 仓库的
`core/` 和 `decodes/` 目录。实体、字典和跨文件名称解析已可由首版编译器检查，
案例使用的 `snowflake_id` 已纳入内置值类型。

后续还需确定词法字符集、字符串转义、其他空白和换行规则、声明分隔规则，
以及文件和仓库的解析入口。当前示例的排版不构成完整格式化规范。
