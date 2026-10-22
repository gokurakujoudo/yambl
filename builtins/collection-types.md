# 内置集合类型

YAMBL 的 builtins 提供 `collection<T>`、`values<T>` 和 `map<TKey, TValue>`。
尖括号内填写类型参数；`map` 的两个类型参数以逗号分隔。

| 类型 | 泛型约束 | 已确认的集合语义 |
| --- | --- | --- |
| `collection<T>` | `T` 必须是实体引用类型 | 无序，同一实体引用不得重复出现 |
| `values<T>` | `T` 必须是值类型 | 无序，相同的值不得重复出现 |
| `map<TKey, TValue>` | `TKey` 为 `string` 或实体引用类型；`TValue` 为任意非集合的值类型或实体引用类型 | 无序，键唯一，不同键可以对应相同的值或实体引用 |

实体类型名直接表示引用类型，无需额外的 `ref` 关键字。值类型清单及参数写法
见[内置值类型](value-types.md)。

## collection

```text
attr holdings: collection<HoldingEntry>
```

`HoldingEntry` 是实体类型，因此集合元素是持仓条目的引用。同一个实体引用
不能在集合中重复出现，按引用指向的实体身份区分元素。

`collection` 不包含顺序。数据使用方如需有序结果，应指定按照 `attr` 排序，
或自行应用排序规则。

## values

```text
attr labels: values<string>
attr reporting_dates: values<date>
```

`values` 的元素必须是值类型，不包含顺序，也不允许重复值。相同值的判断依赖
对应值类型的相等规则，具体相等规则仍待定义。排序由数据使用方决定。

## map

```text
attr metrics: map<string, decimal>
attr securities: map<string, Security>
attr quantities: map<Security, decimal>
attr holding_entries: map<Security, HoldingEntry>
```

`TKey` 只能是 `string` 或实体引用类型。`TValue` 可以是值类型或实体引用
类型，但不能是 `collection`、`values` 或 `map`。

`map` 无序，键唯一。不同键可以映射到相同的值或实体引用。排序由数据使用方
决定；引用键按所指向的实体身份区分，字符串键按字符串值区分。

## 不合法的类型组合

| 写法 | 原因 |
| --- | --- |
| `collection<string>` | `collection` 的元素必须是实体引用 |
| `values<Security>` | `values` 的元素必须是值类型 |
| `collection<Currencies>` | Currencies 是 Decodes 实例名称，不是实体类型；字典引用集合应使用 `collection<Decodes>` |
| `map<integer, decimal>` | 键必须是 `string` 或实体引用 |
| `map<string, collection<Security>>` | 值不能是集合类型 |
| `map<string, values<decimal>>` | 值不能是集合类型 |
| `map<string, map<string, decimal>>` | 值不能是集合类型 |

这些泛型约束属于模型的类型规则。无重复语义描述集合本身，不表示 YAMBL
执行了业务数据质量校验；解析器与类型检查器尚未实现。

集合及其元素的可空性、空集合的表示方式仍待讨论。
