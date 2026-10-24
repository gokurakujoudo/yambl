# 非正常值常量

语言定义以下七个结果常量，用于区分字段不适用、空值、记录缺失和取数失败。

| 常量 | 含义 |
| --- | --- |
| `NOT_DEFINED` | 字段不属于实例的实际类型。 |
| `NOT_APPLICABLE` | 字段属于实例的实际类型，但在当前业务情形下不适用。 |
| `EMPTY` | 对应记录存在，但值为空。 |
| `NO_ENTRY` | 存储中不存在对应记录。 |
| `NO_DATA` | 没有满足取数要求的数据，例如 Hierarchy 取数无满足要求的结果。 |
| `ENTITY_NOT_FOUND` | 解引用时找不到对应实例。 |
| `ERROR` | 取数或计算中遇到错误。 |

不定义 `UNKNOWN` 常量。“尚不知道”按字段和取数情境表现为 `EMPTY`、`NO_ENTRY`
或 `NO_DATA`。业务不适用不由类型检查器自行推断。

这些名称表示独立的结果常量，不等于同名字符串或普通字典 code，也不是字段类型。
七个名称均为保留的声明名称。

## 类型不适用与业务不适用

假设 `Bond inherits Security` 增加 `coupon`，而 `Stock inherits Security`
增加 `exchange`：

| 实例实际类型 | 获取 coupon | 获取 exchange |
| --- | --- | --- |
| `Security` | `NOT_DEFINED` | `NOT_DEFINED` |
| `Bond` | 该实例的 coupon 结果 | `NOT_DEFINED` |
| `Stock` | `NOT_DEFINED` | 该实例的 exchange 结果 |

Bond 定义了 coupon，但在某种业务情形下不适用该字段时，可用 `NOT_APPLICABLE`
表达。属于该类型但值为空用 `EMPTY` 表达；没有对应存储记录用 `NO_ENTRY` 表达。

`extend Security` 添加的字段属于 `Security` 自身，也由其所有子类型继承，
不能因为字段来自扩展块而返回 `NOT_DEFINED`。

引用字段有 ID，但解引用找不到实例时为 `ENTITY_NOT_FOUND`；读取或计算过程
发生错误时为 `ERROR`。这些情况与正常完成读取后发现记录不存在不同。

## 当前工具边界

名称和说明集中在 [result-constants.json](result-constants.json)，由 Python 和 LSP
共用并随安装包分发。当前语言没有常量声明语法，这份资源保存语言原语的定义，
不把结果常量定义成 Decodes code。VS Code 提供七个名称的高亮、补全和含义悬停。

当前工具检查模型声明，尚未提供实例数据执行器。显式赋值规则尚未定义，七个常量
均不能作为 config 默认值、decorator 实参或类型表达式使用；同名字符串仍是普通字符串。
格式化仅检查语法，不赋予常量运行时能力。

本轮不定义 Hierarchy 回退、比较、运算传播、多个非正常结果的优先级或存储编码。
