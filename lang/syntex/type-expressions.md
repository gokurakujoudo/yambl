# 类型表达式与透明别名

`+` 添加、`-` 移除来自同一个 `@flags` 字典的 code，同优先级、从左到右计算，
优先级低于 `.` 和 `::`。
例如 `field_mapping<AttrCats.Static + AttrCats.Config, Security>` 选择两个类别的并集。
`AttrCats.None` 为自动生成的零值，`AttrCats.All` 为全选值。
重复添加或移除同一项只生效一次；普通字典不支持 `+`、`-`。

## 实体引用和类型值

`attr a: Security` 保存 Security 实例的引用 ID。`attr b: type<Security>` 保存
Security 或其子类型的 qualified name。`type<Entity>` 接受任意实体类型。
Entity 是所有实体的抽象最终基类，不能有实例；没有显式父类的声明各自建立业务继承树。
Entity 不汇集所有业务字段。值类型没有继承关系。

## 字段描述、类型和值

点号表示名称层次或字段选择，双冒号访问字段描述的 `::type`、`::value` 和 `::entity`。
`::entity` 要求描述具有所属实体；`::value` 要求实例来源。单冒号保留给声明。
计算中的 `::value(...)`、`::best_available(...)` 是字段操作，见
[计算规则](computations.md)。

```yambl
entity Security {}
entity Bond inherits Security {}
entity Selection {
    attr b: type<Security>
    attr c1: self.b::value
    attr c2: self.b::type
    attr c3: type<self.b::value>
    attr c4: alias<self.b::value>
}
```

当 b 的值为 Bond 时，c1 是 Bond 实例引用，c2 的类型为 type<Security>，
c3 的类型为 type<Bond>，c4 与 b 的值相同。`self.b` 本身是字段描述，不能直接
充当字段的类型。`Attr::type` 是对应字段声明的完整类型，`type<Attr::value>`
则要求该字段的实例值本身是一种实体类型。

字段值必须有实例来源。支持前向引用、继承、extend 以及多层路径，例如
`self.security::value.currency::value`。没有实例的 mapping key 描述不能访问
`Attr::value`。`alias<...>` 保持同值关系，可用于标量、类型值、实体引用和集合；
实现可不单独保存该字段。依赖循环报错，普通实体相互引用不属于类型依赖循环。

## 字典和常量

`Decodes` 是 final 实体。`attr d: Decodes` 保存字典引用；`code<Currencies>`
保存该字典的 code；`code<self.d::value>` 的字典由实例字段选择。
`code<'Currencies'>` 继续按文件作用域解析字典名称。

```yambl
decodes Currencies {
    - 100 USD: 'USD'
    - 200 CNY: 'CNY'
}
entity Security {
    attr currency: code<Currencies>
}
entity DollarSecurity inherits Security {
    @override
    attr currency: exact<Currencies.USD>
}
```

`exact<value>` 将字段限制为一个常量，仅允许用于 override 或 overload。
它必须与被约束的类型兼容；继承 USD 限制后不能改为 CNY 或放宽为 code<Currencies>。
常量可为标量、实体类型、字典引用或字典代码。字典实例名称不提供类型位置的简写：
`attr x: Currencies` 不合法。

code、实体引用 ID、类型 qualified name 和字段 qualified name 可以单向视作 string。
普通 string 不能反向自动转为其中任一种类型。这是兼容规则，不是值类型继承。

## type 定义

```yambl
type money = decimal[18, 4]
type selected<t: type<Entity>> = t
entity Security {}
entity Selection {
    attr kind: type<Security>
    attr security: selected<self.kind::value>
    attr amount: money
}
```

`type name<参数: 约束, ...> = 表达式` 定义透明类型别名；无参数时省略尖括号。
名称和参数用 snake_case，实参按位置传入，暂不支持命名实参、默认值或可变参数。
别名体按定义文件的作用域解析，实参按调用文件的作用域解析。别名体不能隐式访问
调用者的 self，实例依赖必须显式传参。支持前向引用和 import；循环别名报错。
别名展开后参与类型比较、默认值和维度参数校验，格式化保留调用时的别名拼写。

字段选择与 mapping 的定义见[字段映射](../builtins/field-mapping.md)。当前工具实现
类型表达式的静态解析、约束检查和编辑器功能；计算字段的实例执行见 [计算字段](computations.md)。
