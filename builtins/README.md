# 内置关键字与类型系统

本目录用于定义内置关键字、类型，以及字段和引用的语义。

## 已确认

- 区分实体类与值类型。
- 值类型属于 YAMBL 的 builtins，名称使用 `snake_case`，例如 `string`、
  `date` 和 `decimal`。
- 实体类型名称使用 `PascalCase`，例如 `Fund`、`HoldingEntry` 和 `Security`。
- 字段名称使用 `snake_case`，例如 `fund_id`、`net_asset` 和
  `holdings_entry_id`。
- 实体类型字段默认表示实体引用，无需额外的 `ref` 关键字。例如，
  `attr security: Security` 表示对证券实体的引用。
- 实体类型的集合表示实体引用的集合。例如，`HoldingEntry[]` 表示持仓条目
  实体引用的集合，不表示内嵌实体。
- 示例使用 `id 字段名: 类型` 声明实体标识字段，使用 `attr 字段名: 类型`
  声明普通属性，使用 `snapshot attr 字段名: 类型` 声明快照属性。
- `@temporal(as_of_date: date)` 描述对应快照属性的时间参数。不同属性的快照
  相互独立，即使它们使用相同的参数名称和类型。
- 当前模型描述不承担数据完整性等数据质量校验。示例中的类型和模式描述不意味着
  已有业务数据验证或 ID 生成行为。

## 内置值类型

类型清单、使用示例、参数写法和待定事项集中在
[内置值类型](value-types.md)中。自定义值类型声明继续暂缓定义。

## 待确定

- 实体身份的作用域、组合标识和标识继承规则。
- 字段的类型兼容规则，以及引用集合的顺序和重复值语义。
- 内置关键字与保留字清单。

[语法说明](../language/syntax.md)记录了 `entity`、`id`、`snapshot`、`attr`、
`@temporal`，以及案例使用的 `namespace` 写法。完整的关键字清单、注解机制
仍需确认。
