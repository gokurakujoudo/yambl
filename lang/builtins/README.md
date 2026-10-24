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
- 实体类型的集合表示实体引用的集合。例如，`collection<HoldingEntry>` 表示
  持仓条目实体引用的集合，不表示内嵌实体。
- 示例使用 `id 字段名: 类型` 声明实体标识字段，使用 `attr 字段名: 类型`
  声明普通属性，使用 `snapshot attr 字段名: 类型` 声明快照属性，使用 `scd attr`
  声明 SCD Type 2 属性，使用 `config attr` 声明可被配置覆盖的时间无关参数。
- `@temporal(as_of_date: date)` 描述对应快照属性的时间参数。不同属性的快照
  相互独立，即使它们使用相同的参数名称和类型。
- 当前模型描述不承担数据完整性等数据质量校验。示例中的类型和模式描述不意味着
  已有业务数据验证或 ID 生成行为。

## 内置值类型

类型清单、使用示例、参数写法和待定事项集中在
[内置值类型](value-types.md)中。结构化值类型使用 `value` 声明。
其中 `code<decodes_id>` 表示 [Decodes](../models/decodes.yambl) 实例的代码值。

## 内置集合类型

`collection<T>`、`values<T>` 和 `mapping<TKey, TValue>` 的泛型约束、集合语义
和使用示例见[内置集合类型](collection-types.md)。

## 待确定

- 实体身份的作用域、组合标识和标识继承规则。
- 尚未定义的其他值类型转换。
- 内置关键字与保留字清单。

[内置常量](constants.md)定义 `NOT_DEFINED`、`NOT_APPLICABLE`、`EMPTY`、`NO_ENTRY`、
`NO_DATA`、`ENTITY_NOT_FOUND`、`ERROR` 七种非正常结果；名称和说明在
[result-constants.json](result-constants.json) 中维护。
[语法说明](../syntex/syntax.md)记录了 `entity`、`extend`、`inherits`、`id`、
`snapshot`、`scd`、`config`、`attr`、元信息和维度注解，以及 `namespace` 写法。
通用注解声明、调用和重复规则见 [Decorator](../syntex/decorators.md)，
内置签名和显式 `@targets` 范围在 [decorators.yambl](decorators.yambl) 中定义。
[DecoratorTargets](decorator_targets.yambl) 是用于范围选择的 flags 字典。

实体类型值 `type<T>` 和 `field_mapping<类别, 目标>` 见
[实体类型与字段映射](field-mapping.md)。

[AttrCats](attr_cats.yambl) 与 [field_mapping](field_mapping.yambl) 在本目录自举定义。
基础原语还有 type、attrs、mapping、alias 和 exact，语义见
[类型表达式](../syntex/type-expressions.md)。Entity 是抽象最终实体基类。
