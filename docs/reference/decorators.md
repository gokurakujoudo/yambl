# Decorator 声明与调用

Decorator 为定义添加有类型的元信息。声明和调用使用同一套 namespace/import 规则，
与其他声明共享名称空间。名字和参数名使用 snake_case。内置签名见
[decorators.yambl](../../lang/builtins/decorators.yambl)。

```text
@targets(DecoratorTargets.All)
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
同一次调用的 key 不可重复；temporal 与引用的命名 dimension 参数还须在同一字段内互不重复。

每个 decorator 隐含一个可选 string `description` 元信息，不写入声明的形式参数列表。
它位于全部显式实参之后，既可写成末尾字符串，也可写成 `description='说明'`。
已有普通参数先正常绑定，只有剩余的末尾 string 才作为说明。例如
`@title('标题', '说明')`、`@title(text='标题', '说明')` 与
`@title('标题', description='说明')` 等价。description 为保留形式参数名，重复说明、
非 string 说明以及说明后继续传参均报错。

`input_type` 仅用于 decorator pair 的类型约束，接受非集合值类型和实体引用，拒绝
集合、字段描述、dimension_ref 和 input_type 本身。内置声明为：

```yambl
@targets(DecoratorTargets.EntityAttr + DecoratorTargets.Lookup, categories=AttrCats.Computed)
@allow_multiple
decorator @extra_input_param(*parameter: input_type)
```

只有 `@extra_input_param` 的调用 pair 可写默认值，如
`@extra_input_param(day: date = '2026-01-01', '查询日期')`。
输入合并与省略回退规则见 [计算字段](computations.md)和[具名批量匹配](lookup.md)。

声明总是包含括号。无实参调用可写 `@flags` 或 `@flags()`；格式化保留这种选择，
也保留位置/命名调用方式。调用中的等号写为 `text='Name'`，声明默认值写为
`text: string = 'Name'`。声明和调用均不接受尾随逗号。

## 声明适用范围

[DecoratorTargets](../../lang/builtins/decorator_targets.yambl) 是自举的 flags decodes。
它包含以下对象类别：

| Code | 对象 |
| --- | --- |
| Entity | 实体声明 |
| Value | 结构化值声明 |
| Decodes | 字典声明 |
| Type | 类型别名声明 |
| Decorator | decorator 声明 |
| Id | 实体 ID 字段 |
| EntityAttr | 实体自身或 extend 中的属性 |
| ValueAttr | 结构化值中的属性 |
| Lookup | 具名 lookup 声明 |

`None` 与 `All` 自动生成；`+` 合并范围，`-` 移除范围，重复操作幂等。
`None` 声明不允许任何应用对象；`All` 不开放 extend 块、字典条目或形式参数。

```text
@targets(DecoratorTargets.EntityAttr, categories=AttrCats.Snapshot + AttrCats.Scd)
decorator @observation(text: string)

entity Security {
    @observation('Independent price snapshot')
    snapshot attr price: decimal
}
```

`@targets` 的签名为 `targets: code<DecoratorTargets>` 与
`categories: code<AttrCats> = AttrCats.All`。普通调用参数绑定规则同样适用，
例如 `@targets(categories=AttrCats.Static, targets=DecoratorTargets.EntityAttr)`。
`categories` 只筛选属性类别，对实体声明、ID 等其他对象类别不生效。
value 中的 `attr` 和 `static attr` 都属于 `AttrCats.Static`；
实体中的普通 `attr` 属于 `AttrCats.Static`。集合属性也按所属对象和类别匹配。

`@targets` 自身声明 `@targets(DecoratorTargets.Decorator)`。
检查器先收集全部声明，再解析范围和调用，因此支持前向引用、自身修饰以及
`@flags`、DecoratorTargets、`@targets` 之间的相互引用，无需执行 decorator。
范围表达式在被修饰的 decorator 声明文件作用域内解析，跨文件调用保留该范围。

## 子类型字典排序

`@decodes_rank(k: integer, decode: string)` 只能修饰声明了显式父类的实体，不继承给
子类；抽象实体不接受该标记。它为该实体在每个祖先的 `::subtypes` 字典中指定 decode，并以提升后父节点的最终
ordering 加 k 作为自身 ordering；父节点不在该字典中时基数为 0。默认编号在覆盖前独立
计算，覆盖不会改变其他节点的默认编号。k 可为任意整数，重复 ordering 合法。
完整的遍历顺序、示例和实现状态见[自动子类型字典](syntax.md#自动子类型字典)。

## 捕获被修饰对象

`@sparse(cat: string)` 和 `@dense(cat: string)` 的声明范围为 EntityAttr / Static，
另须满足非集合、无维度约束。cat 为非空 snake_case；两者与 `@dimension` 互斥。
它们只指定物理存储，不计入逻辑字段签名。继承树中的分组与实现冲突规则见
[命名 static 分组](storage.md#命名-static-分组)。补全根据类型及已有互斥标记过滤这两个选项。

```text
@targets(DecoratorTargets.EntityAttr)
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
@targets(DecoratorTargets.Entity)
decorator @related(target: Security)

@related(target='SEC001')
entity Holding {}
```

工具要求目标有一个可识别的 ID 字段，并按其已支持的类型规则检查。
支持 string（包括模式参数）和 snowflake_id 的字符串 ID，不检查实例是否存在，
不执行正则匹配，也不生成 ID。没有唯一 ID 或 ID 类型不兼容时报错。
已声明的 Decodes 实例可直接按名称作为引用实参。
普通标量字面量沿用 config 默认值的类型规则；声明约束可使用结构化值类型，
但 decorator 实参仍不接受结构值或集合构造；计算体和 const 的字面量规则见
[语法总览](syntax.md#字面量与上下文类型)。

## 重复使用和修饰位置

```text
@title(text='Model note')
@allow_multiple
@targets(DecoratorTargets.All)
decorator @note(text: string)

@note('Reviewed')
@note('Imported')
type label = string
```

每个 decorator 必须通过 `@targets(...)` 显式声明适用范围；缺少声明时报错，
即使该 decorator 尚未使用。允许所有对象也必须写 `@targets(DecoratorTargets.All)`。
extend 块、字典条目和形式参数不能添加 decorator。
`@allow_multiple` 仅修饰 decorator 声明，自身不可重复。
未标记的 decorator 在一个对象上最多出现一次；标记后每次调用均保留，包括相同调用。

内置注解的适用范围也在语言定义中声明，检查器统一读取 `@targets` 验证。
内置特殊行为继续由检查器实现。dimension 标记为 allow_multiple，
每次引用一个实体内命名 dimension，签名为 `decorator @dimension(definition: dimension_ref)`；
temporal 接收一个由调用者命名的 date 参数，
如 `@temporal(effective_date: date)`，仅用于 snapshot/scd attr。
flags 仅用于字典；override/overload 仅用于实体 attr。

自定义 decorator 参与 override/overload 的字段签名比较。比较使用解析后的 decorator
身份和绑定参数，补齐默认值；省略默认实参与显式提供同值等价。忽略 decorator 顺序和
普通命名实参顺序，保留 pair 的 key、类型及重复调用次数。关系标记本身不参与签名。
Decorator 只描述元信息和参数约束，不提供自定义可执行逻辑。

## 编辑器补全

`@` 后的候选按可见声明的 `@targets` 和当前位置过滤。已写出后续声明时，
补全使用该对象种类和属性类别；例如 snapshot/scd 属性提供 temporal，static 属性不提供。
尚未写出对象或类别时，只保留当前层级仍可能适用的候选：顶层为声明，
实体体内为 ID、属性或 lookup，extend 体内为属性或 lookup，value 体内为 static 属性。
没有有效范围声明的 decorator 不进入候选。注释、字符串、字典条目和形式参数内
不提供 decorator 名称。补全保留 namespace/import 可见性，并响应未保存的范围修改。

同一对象上已使用的 decorator，未声明 `@allow_multiple` 时不再提供补全；
允许重复的继续保留。检查光标前后的整组注解，正在编辑名称的当前调用不计入重复。
相邻字段、外围实体和其他声明上的调用不占用当前对象的候选；
跨文件且未保存的 `@allow_multiple` 修改也会更新补全结果。
