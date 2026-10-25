# YAMBL 语言参考

[语法总览](syntax.md) 按语言结构介绍文件、声明、类型、字段、表达式与结果处理。
代码块中的声明体片段须放入相应 entity、value 或 computed attr 中。

| 主题 | 参考 |
| --- | --- |
| 文件、命名、声明、字段类别、表达式与成员访问 | [语法总览](syntax.md) |
| 仓库、namespace、import 与名称作用域 | [名称解析](namespaces.md) |
| 类型值、依赖类型、字段描述、别名与泛型参数 | [类型表达式](type-expressions.md) |
| 原始值类型及参数 | [值类型](../builtins/value-types.md) |
| 字面量、类型推断、常量和运算符 | [语法总览](syntax.md#字面量与上下文类型) |
| 严格转换、日期格式、截断和舍入 | [转换函数](../builtins/functions.md) |
| 引用集合、值集合与映射 | [集合类型](../builtins/collection-types.md) |
| 属性筛选与异构字段映射 | [字段映射](../builtins/field-mapping.md) |
| decorator 声明、实参、适用范围与重复限制 | [元信息](decorators.md) |
| 字段身份、override、overload 与 final | [字段关系](field-relationships.md) |
| 计算、参数、dimension、Hierarchy、ConfigGroup 与聚合 | [计算规则](computations.md) |
| 非正常状态与 PARTIAL | [结果](../builtins/constants.md) |

产物契约单独维护：

- [JSON IR](ir.md)：独立模型、源码位置、Schema 和修订号。
- [存储与 Python API](storage.md)：SQLite、JSONL、自包含生成包及逐项能力清单。
- [内置声明](../builtins/decorators.yambl)：decorator 的签名和 targets。
- [内置模型](../models/)：Decodes、Hierarchy、ConfigGroup。

语言可表达的类型和后端可执行的类型分别列明。生成器拒绝尚不支持的业务字段，
不会静默遗漏字段或把类型降为 Any。
