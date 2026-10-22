# 语言结构

本目录用于定义词法、语法、格式化规则，以及 YAMBL 文件和模型仓库的结构。
各项规则尚在讨论中。

## 讨论草案：基金快照

以下是用户提出的 `fund_sample.yambl` 写法，按原样保存。
它用于讨论语法和语义，尚不能作为可解析的语言示例。

```scss
entity Fund {
    id fund_id

    @temporal(as_of_date: Date)
    snapshot attr holdings: HoldingEntry[]

    @temporal(as_of_date: Date)
    snapshot attr net_asset: Decimal
}

entity Fund
```

待确定：

- `id fund_id` 是声明标识字段，还是指定已声明的字段为标识；标识的类型如何确定。
- `snapshot attr` 的含义，以及它与其他字段类别的区别。
- `@temporal(as_of_date: Date)` 的作用范围；多个字段使用相同时间参数时是否共享快照。
- `HoldingEntry` 是实体类还是值类型；实体引用如何表达。
- `[]` 的集合语义，包括顺序和重复值。
- 末尾独立的 `entity Fund` 是否是尚未写完的内容，或一种独立语法。

类型系统的已确认约定见 [builtins/](../builtins/README.md)。
