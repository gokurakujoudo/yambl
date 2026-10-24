# Decorator 声明与调用

Decorator 为定义添加有类型的元信息。声明和调用使用同一套 namespace/import 规则，
与其他声明共享名称空间。名字和参数名使用 snake_case。内置签名见
[decorators.yambl](../builtins/decorators.yambl)。

```text
decorator @note(text: string = 'Model note', *variation: string, *selector?: Hierarchy)

@note(text='Price source', source: code<'PriceSources'>)
entity Security {}
```

普通参数接收非集合值或实体引用，可按位置赋值，也可写 `name=value`。
位置参数在前，命名参数在后，命名参数可换序。重复赋值、未知参数和缺少必填参数报错。
默认值在声明处解析；默认参数之后仍可声明必填普通参数，调用时可按名称赋值。
参数类型中的 `self` 在调用时绑定。参数实参在调用文件的作用域解析。

`*variation: string` 接收一个调用处定义的 `key: Type`，例如
`source: code<'PriceSources'>`。key 使用 snake_case 标识符，保存为字符串；
Type 按现有类型兼容规则检查。每个 `*` 参数只接收一个 pair，按声明顺序绑定。
所有 pair 在普通实参之后；`*selector?: Hierarchy` 可省略，可选 pair 只能在末尾。
同一次调用的 key 不可重复；temporal 和 dimension 的 key 还须在同一字段内互不重复。

声明总是包含括号。无实参调用可写 `@flags` 或 `@flags()`；格式化保留这种选择，
也保留位置/命名调用方式。调用中的等号写为 `text='Name'`，声明默认值写为
`text: string = 'Name'`。声明和调用均不接受尾随逗号。

## 捕获被修饰对象

```text
decorator @proxy(target: type<self::entity>)

entity Security {}

entity Holding {
    @proxy(Holding)
    attr security: Security
}
```

在这个调用中，`self` 是 security 属性描述，`self::type` 是 Security，
`self::entity` 是 Holding。`type<self::entity>` 接收 Holding 或其子类型。
extend 中的字段归属被扩展实体；继承但未重声明的字段保留原声明上下文。
值结构中的字段没有所属实体，使用 `::entity` 报错。
具体字段描述也支持 `Security.currency::entity`；没有具体字段来源的描述不提供所属实体。

修饰实体时，`self` 捕获实体类型，`type<self>` 接收该类型或子类型。
修饰字典时捕获字典实例，修饰值类型或类型别名时捕获相应类型。
捕获定义不会创建运行时实例；属性 decorator 中的 `self::value` 因缺少实例来源而报错。

普通引用参数可用 ID 字符串赋值：

```text
entity Security { id security_id: string }
decorator @related(target: Security)

@related(target='SEC001')
entity Holding {}
```

工具要求目标有一个可识别的 ID 字段，并按其已支持的类型规则检查。
支持 string（包括模式参数）和 snowflake_id 的字符串 ID，不检查实例是否存在，
不执行正则匹配，也不生成 ID。没有唯一 ID 或 ID 类型不兼容时报错。
已声明的 Decodes 实例可直接按名称作为引用实参。
普通标量字面量沿用 config 默认值的类型规则；声明约束可使用结构化值类型，
但本轮不新增结构化值构造、集合字面量或实例执行器。

## 重复使用和修饰位置

```text
@title(text='Model note')
@allow_multiple
decorator @note(text: string)

@note('Reviewed')
@note('Imported')
type label = string
```

自定义 decorator 可修饰 entity、value、decodes、id/attr、类型别名和 decorator 声明。
extend 块、字典条目和形式参数不能添加 decorator。
`@allow_multiple` 仅修饰 decorator 声明，自身不可重复。
未标记的 decorator 在一个对象上最多出现一次；标记后每次调用均保留，包括相同调用。

内置注解保留各自的适用位置和特殊行为。dimension 标记为 allow_multiple，
每次声明一个维度及可选 Hierarchy 参数。temporal 接收一个由调用者命名的 date 参数，
如 `@temporal(effective_date: date)`，仅用于 snapshot/scd attr。
flags 仅用于字典；override/overload 仅用于实体 attr。

自定义 decorator 参与 override/overload 的字段签名比较。比较使用解析后的 decorator
身份和绑定参数，补齐默认值；省略默认实参与显式提供同值等价。忽略 decorator 顺序和
普通命名实参顺序，保留 pair 的 key、类型及重复调用次数。关系标记本身不参与签名。
Decorator 只描述元信息和参数约束，不提供自定义可执行逻辑。
