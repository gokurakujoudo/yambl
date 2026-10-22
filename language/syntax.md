# YAMBL 语法说明

本文记录当前案例使用的语法及已确认的语义。完整文法和解析器尚未实现。
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

`core/fund.yambl`、`core/holdings_entry.yambl` 和 `core/security.yambl`
分别声明 `Fund`、`HoldingEntry` 和 `Security`，三个文件均使用 `namespace core`。

这里记录案例采用的形式。目录与命名空间的对应关系、同命名空间下的名称查找、
跨文件引用、导入及可见性规则尚未确定；也尚未要求每个文件只能声明一个实体。

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
}
```

持仓条目的标识声明为：

```text
id holdings_entry_id: snowflake_id
```

`snowflake_id` 的定义及其是否属于内置类型尚待确定；该声明本身不规定 ID
生成行为。实体身份的作用域以及是否支持组合标识也尚待确定。

## 属性与引用

使用 `attr 字段名: 类型` 声明普通属性：

```text
attr security: Security
attr quantity: decimal
```

实体类型字段默认表示实体引用，因此 `security` 引用一个 `Security` 实体。
值类型字段描述值，因此 `quantity` 的类型是 `decimal`。实体引用无需额外的
`ref` 关键字。

`HoldingEntry[]` 表示持仓条目实体引用的集合，不表示内嵌实体。
集合的顺序、重复值和可空性规则尚未确定。

## 独立快照属性

使用 `snapshot attr 字段名: 类型` 声明快照属性。当前案例将时间注解放在
对应属性的前一行：

```text
@temporal(as_of_date: date)
snapshot attr holdings: HoldingEntry[]

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
`core/` 目录。三个实体均已有定义；`snowflake_id` 的含义和跨文件名称解析规则
尚未确定，目前不能视为通过解析或名称解析验证的模型。

后续还需确定词法字符集、字符串转义、其他空白和换行规则、声明分隔规则，
以及文件和仓库的解析入口。当前示例的排版不构成完整格式化规范。
