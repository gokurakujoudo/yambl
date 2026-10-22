# 内置值类型

值类型属于 YAMBL 的 builtins，名称使用 `snake_case`。当前已确认需要以下
七种基础值类型，以及依赖 Decodes 实例的 `code` 值类型原语：

| 类型 | 基本含义 |
| --- | --- |
| `bool` | 布尔值 |
| `string` | 字符串 |
| `integer` | 整数 |
| `float` | 浮点数 |
| `decimal` | 十进制数 |
| `date` | 日期 |
| `datetime` | 日期和时间 |
| `code<decodes_id>` | 指定 Decodes 实例中的一个条目的 code 值 |

这些类型可直接用于字段或时间参数的类型位置，无需在业务模型中声明。例如：

```text
attr is_active: bool
attr name: string
attr item_count: integer
attr estimate: float
attr quantity: decimal
attr inception_date: date
attr recorded_at: datetime
```

上述片段展示实体内部的属性声明形式，不是独立文件。

## 类型参数

类型参数写在类型名后的方括号中，支持位置参数简写和命名参数写法。
命名参数使用 `参数名: 参数值`，多个参数以逗号分隔。同一组参数必须全部
使用位置参数或全部使用命名参数，不允许混用。

| 类型 | 位置参数写法 | 等价的命名参数写法 |
| --- | --- | --- |
| `decimal` | `decimal[18, 4]` | `decimal[precision: 18, scale: 4]` |
| `string` | `string['[a-zA-Z0-9]{12}']` | `string[regex: '[a-zA-Z0-9]{12}']` |

`decimal[18, scale: 4]` 混用了两种参数形式，是不合法的类型参数写法。
参数的重复、命名参数的顺序和部分省略规则尚未确定，格式化器是否统一改写
参数形式也尚未确定。

`decimal` 和 `string` 使用方括号传入描述参数。集合类型使用尖括号传入类型，
例如 `collection<HoldingEntry>` 和 `values<decimal>`；具体规则见
[内置集合类型](collection-types.md)。`code<decodes_id>` 的尖括号内则是
Decodes 实例名称，不是类型参数。

## decimal

```text
decimal
decimal[18, 4]
decimal[precision: 18, scale: 4]
```

第一个位置参数为 `precision`，表示总十进制位数；第二个为 `scale`，表示
小数位数。两种参数写法含义相同，上例描述总共 18 位数字，其中小数部分 4 位。

不带参数的 `decimal` 仍然有效，表示模型未指定精度和小数位数；这里不为它
隐式补充默认值。

## string

```text
string
string['[a-zA-Z0-9]{12}']
string[regex: '[a-zA-Z0-9]{12}']
string['']
string[regex: '']
```

位置参数为正则表达式，对应命名参数 `regex`。上面的两种非空正则表达式
写法等价，`string['']` 和 `string[regex: '']` 也使用相同的空正则表达式参数。
不带参数的 `string` 表示未指定正则表达式的字符串。

这些参数用于描述类型，不引入业务数据质量校验。正则表达式的匹配范围、转义
和具体语法方言，以及数值参数的合法范围，仍待确定。

## code

```text
attr currency: code<Currencies>
```

`code<decodes_id>` 是内置值类型原语，表示指定 `Decodes` 实例中的一个条目的
`code`。在上述例子中，`Currencies` 指定字典实例，字段承载该字典的代码值。
对应的内容由该条目的 `decode` 描述。

按照最新案例，尖括号内使用不带引号的实例名称，名称采用复数，例如
`Currencies`。内置模型和 `decodes` 专用声明语法见 [Decodes](../models/decodes.md)。

`code<Currencies>` 属于值类型，可以用作 `values` 的元素类型或 `map` 的
值类型；不能作为 `collection` 的元素类型。它与 `string` 的兼容关系，以及
是否允许作为 `map` 的键类型，尚未确定。

## 暂缓定义

自定义值类型的声明方式暂不定义。此前讨论的 `type` 写法、名义类型与别名的
区分均未确认为语言规则。

## 待确定

- 值类型的相等规则。
- `code` 的字典名称解析、跨字典兼容规则及其与 `string` 的关系。
- 内置值类型的位宽、取值范围、时区、字面量和可空性，以及到数据库或 Python
  类型的映射。
- `decimal` 参数的合法范围、是否允许部分参数，以及参数重复和命名参数的
  顺序规则；其他内置类型是否支持参数。
- 正则表达式的匹配范围、转义和具体语法方言。
- 案例中的 `snowflake_id` 尚未纳入已确认的内置值类型清单。它是否属于内置
  值类型、具体值结构及定位仍待讨论；案例中的声明本身不规定 ID 生成行为。
