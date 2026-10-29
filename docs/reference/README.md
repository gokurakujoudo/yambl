# YAMBL 中文参考

先阅读[从零开始](../tutorial/getting-started.md)，再按需要查阅下列规则。
参考中的片段若没有 `entity`、`value` 等外层声明，需要放入对应声明体中使用。

| 主题 | 内容 |
| --- | --- |
| [语法总览](syntax.md) | 文件、声明、字段、字典、字面量和表达式 |
| [命名空间与导入](namespaces.md) | 模型仓库、跨文件引用和名称解析 |
| [值类型](value-types.md)、[集合](collection-types.md) | 基础类型、参数、引用及容器约束 |
| [类型表达式](type-expressions.md)、[字段映射](field-mapping.md) | 字段描述、别名、依赖类型与字段筛选 |
| [字段关系](field-relationships.md) | 继承、扩展、覆盖和重载 |
| [元信息](decorators.md) | 内置和自定义 decorator、参数及适用范围 |
| [计算](computations.md)、[转换函数](functions.md) | 字段读取、输入、维度、聚合和转换 |
| [具名批量匹配](lookup.md) | 匹配键、准备参数、Python 接口和结果 |
| [结果状态](constants.md) | 正常值、非正常状态和部分结果 |
| [事务和数据](transactions.md)、[事务格式参考](transactions-format.md) | Plan、事务、读取、数据校验与回滚 |
| [中间模型](ir.md)、[存储](storage.md) | IR、生成物、后端及支持范围 |

语言接受的类型不一定都能生成物理存储；生成能力和限制见[存储能力清单](storage.md#能力清单)。
计算表达式与运行时数据校验也有各自的边界，使用时分别查看对应章节。
