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

## 语法说明与案例

[语法说明](syntax.md)整理当前使用的声明形式、已确认的含义和待定规则。
自定义值类型的声明方式暂不定义。

最新业务案例保存在
[fmc-data-model](https://github.com/gokurakujoudo/fmc-data-model) 仓库的
`core/fund.yambl`、`core/holdings_entry.yambl` 和 `core/security.yambl` 中。

类型系统的已确认约定见 [builtins/](../builtins/README.md)。词法细节、完整文件
结构和仓库解析规则仍待讨论。
