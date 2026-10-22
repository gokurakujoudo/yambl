# 内置常量

## NOT_DEFINED

`NOT_DEFINED` 表示所请求字段不适用于实例的实际实体类型。继承允许子类型增加
字段，父类型或其他子类型实例也可获取这些字段；不属于对应类型时返回此常量。

假设 `Bond inherits Security` 增加 `coupon`，而 `Stock inherits Security`
增加 `exchange`：

| 实例实际类型 | 获取 coupon | 获取 exchange |
| --- | --- | --- |
| `Security` | `NOT_DEFINED` | `NOT_DEFINED` |
| `Bond` | 该实例的 coupon | `NOT_DEFINED` |
| `Stock` | `NOT_DEFINED` | 该实例的 exchange |

这不等于字段属于该类型但尚未提供数据；后一种情况的缺失值语义尚未定义。
`NOT_DEFINED` 不是 `null`、空字符串、零或普通字典代码值。

`extend Security` 添加的字段属于 `Security` 自身，也由其所有子类型继承，
不能因为字段来自扩展块而返回 `NOT_DEFINED`。

当前编译器检查模型声明、合并扩展字段和检查继承关系，尚未提供实例数据执行器。
此常量规定后续读取和目标代码生成的行为；它目前不能作为 `config` 默认值字面量。
