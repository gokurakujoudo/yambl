# 内置值类型

值类型属于 YAMBL 的 builtins，名称使用 `snake_case`。基础类型与值类型原语如下：

| 类型 | 基本含义 |
| --- | --- |
| `bool` | 布尔值 |
| `string` | 字符串 |
| `integer` | 整数 |
| `float` | 浮点数 |
| `decimal` | 十进制数 |
| `date` | 日期 |
| `datetime` | 日期和时间 |
| `snowflake_id` | Snowflake 标识值；位结构与生成策略待定 |
| `type<T>` | 实体类型值；T 是 Entity 或具体实体类型，见[实体类型与字段映射](field-mapping.md) |
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
id holdings_entry_id: snowflake_id
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
不允许参数重复、缺失或未知参数；命名参数可以换序。decimal 必须同时提供 precision
和 scale，string 必须提供 regex。格式化保留位置或命名写法及源码顺序。

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

## snowflake_id

`snowflake_id` 是内置值类型，可直接用于标识字段、普通值字段、
`values<snowflake_id>` 或 `mapping` 的值类型位置，无需声明或导入。
它不是实体引用，因此不能作为 `collection` 的元素类型；它可单向视作 string，
也可作为 mapping 的键。

该类型描述标识值，不规定自动生成行为。位宽、位结构、纪元、节点编号以及
ID 生成策略尚待确定。

## code

```text
attr currency: code<Currencies>
attr market: code<'TradingMarkets'>
```

`code<decodes_id>` 是内置值类型原语，表示指定 `Decodes` 实例中的一个条目的
`code`。在上述例子中，`Currencies` 指定字典实例，字段承载该字典的代码值。
对应的内容由该条目的 `decode` 描述。

代码值使用 `字典实例名.code` 表示，例如 `Currencies.CNY` 是
`code<Currencies>` 的合理取值。字典实例本身可作为 `Decodes` 引用类型的值：
`attr dictionary: Decodes` 可以取值 `Currencies`。

`Currencies` 是实例名称，不能直接用作字段类型。`Decodes` 禁止继承，
`attr currency: Currencies` 不合法。

尖括号内支持裸实例名称和单引号字符串，例如 `code<Currencies>` 与
`code<'Currencies'>` 查找同一字典。名称采用复数。已声明字典按当前文件的
namespace 和显式导入解析；带引号不会跳过导入规则或搜索所有命名空间。

裸名称必须解析到已声明、当前文件可见的 Decodes；未定义或未导入时产生
`undefined Decodes: 名称` error，并使 `check` 失败。带引号的名称若未解析到声明，
可作为外部动态字典，CLI 逐处输出包含文件、行、列的 warning；仅有 warning 时
`check` 仍成功。声明了实体却将它当作 code 字典仍是类型错误；不存在的显式
`from ... import ...` 也仍然报错。内置模型和专用声明语法见
[Decodes](../../lang/models/decodes.yambl)。

上述 warning 是编译器 CLI 的行为。LSP 对带引号的外部动态字典不显示 warning；
裸名称未定义时正常显示 error。
显式导入失败及其他类型错误仍正常显示。字典名称在编辑器中与值类型同色，
Ctrl+Click 字典声明可查看当前编译单元内的引用列表。

`code<Currencies>` 属于值类型，可以用作 `values` 的元素类型或 `mapping` 的
值类型；不能作为 `collection` 的元素类型。code 可单向视作 string，
可以作为 mapping 的键；不同字典的 code 可在 overload 中共同暴露为 string。

## 结构化值类型

`value` 声明有限的结构化值，规则见[语言语法](syntax.md#结构化值类型)。
内置 hierarchy_entry 和 decodes_entry 均由模型仓库中的 value 声明定义。
透明别名使用 type 声明，见[类型表达式](type-expressions.md)。其他自定义标量类型仍待定义。

## 执行边界

类型声明与物理后端的支持范围分别维护，见[存储能力清单](storage.md#能力清单)。
integer 的计算保持任意精度，decimal 的结果按声明 precision/scale 检查；精确数值在
当前后端中使用文本编码。空值通过[结果状态](constants.md)区分，不隐式等同于零或空字符串。

外部字典代码不查询外部数据。正则执行方言、Snowflake 位结构及生成策略未定义。
这些限制不影响现有类型声明和引用解析。
