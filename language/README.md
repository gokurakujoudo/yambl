# 语言结构

本目录用于定义词法、语法、格式化规则，以及 YAMBL 文件和模型仓库的结构。
以下区分已确认的约定和仍待讨论的规则。

## 已确认

- 值类型名称使用 `snake_case`，实体类型名称使用 `PascalCase`，字段名称使用
  `snake_case`。
- 实体类型字段默认表示引用；实体类型集合表示引用集合，无需额外的 `ref`
  关键字。
- 快照按字段独立描述。多个字段使用相同的时间参数，不表示它们组成一份
  必须同时存在的整体快照。
- YAMBL 在此处仅描述模型，不校验数据完整性等数据质量。语言本身的语法检查
  与业务数据质量校验是不同的职责。

## 讨论草案：基金快照

以下是当前讨论的 `fund_sample.yambl` 写法。解析器尚未实现，示例尚不可执行；
其中未确认的语义列在下方。

```text
entity Fund {
    id fund_id: string['[a-zA-Z0-9]{6}']

    @temporal(as_of_date: date)
    snapshot attr holdings: HoldingEntry[]

    @temporal(as_of_date: date)
    snapshot attr net_asset: decimal
}

entity HoldingEntry{
    id holdings_entry_id: snowflake_id

    attr security: Security
    attr quantity: decimal
}
```

`holdings` 和 `net_asset` 各自具有 `as_of_date` 时间参数，两者是独立快照。
这里不要求同一日期的持仓和净资产同时存在，也不检查两者的数据一致性。

`HoldingEntry` 在示例中明确声明为实体类型，`holdings` 表示持仓条目实体引用的
集合。`security` 表示证券实体引用；`Security` 的定义尚未提供。

待确定：

- `snapshot attr` 与普通 `attr` 的完整语义，以及时间参数是否可推广为其他维度。
- `[]` 的集合语义，包括顺序和重复值。
- 字符串模式的解释规则，以及 `snowflake_id` 的具体定义。

类型系统的已确认约定见 [builtins/](../builtins/README.md)。
