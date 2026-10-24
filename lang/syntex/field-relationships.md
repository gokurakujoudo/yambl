# final、overload 与 override

## final 实体

`final entity Name` 禁止其他实体继承 Name，也禁止 `extend Name`。
final 实体自身仍可继承非 final 实体。内置 ConfigGroup 是 final；
Decodes 原有禁止继承的规则保持不变。

## 字段签名

字段签名由属性类别、完整类型以及元信息组成。元信息包括 title、description、
temporal、dimension（包含维度与可选 Hierarchy 参数的对应关系）以及自定义 decorator。
Decorator 按已解析身份和绑定参数比较，补齐默认值；忽略调用顺序，保留重复次数。按语义比较：类型名称先在声明文件中解析，字符串比较
解码后的值，忽略注解及命名参数顺序；`decimal[18, 4]` 与
`decimal[scale: 4, precision: 18]`、`code<Currencies>` 与
`code<'Currencies'>` 分别等价。注释、源码位置及 config 默认值不计入签名。
缺少元信息与显式提供元信息不同。

## @overload

同一继承树不同分支各自新增的同名 attr，必须全部标记无参数 `@overload`，
并保持属性类别及元信息一致，类型必须有已定义的共同兼容类型。检查覆盖整个编译单元，不以是否出现 field_mapping 为条件。
extend 中的字段归属被扩展实体；不同深度的分支也参与比较。

```text
entity Security {}

entity Bond inherits Security {
    @overload
    @title('Category')
    config attr category: integer = 1
}

entity Stock inherits Security {
    @title('Category')
    @overload
    config attr category: integer = 2
}
```

两个 category 共享逻辑字段身份，各自保留默认值和实现位置。
至少须有两个独立分支实现；孤立 overload 报错。继承已有字段不算新的实现，
不同业务根实体不组成 overload 组，即使其最终基类同为 Entity。
共同类型保留相同字典的 code 约束；不同 code 字典或其他 string 兼容类型可合并为 string。
实体引用和 type<T> 使用最近公共实体祖先。整数与 decimal 不自动提升，
不同结构化值或集合类型不自动转换。各分支仍保留本地类型和 exact 约束。

## @override

子类重声明继承属性必须使用无参数 `@override`，属性类别和元信息须与最近继承声明一致。普通类型须一致；
exact 常量允许在原类型范围内收窄，已有常量不能更换或放宽。
父类不需要添加标记；config 默认值及是否提供默认值允许变化。

```text
entity Security {
    config attr price_fallback_days: integer = 20
}

entity Bond inherits Security {
    @override
    config attr price_fallback_days: integer = 10
}

final entity GovernmentBond inherits Bond {
    @override
    config attr price_fallback_days: integer = 5
}
```

override 保持原字段身份，也可重声明继承的 overload 字段。
子类的 extend 可以声明 override，但同一实体内部或多处 extend 对同一字段
重复声明仍报错。无继承目标的 override、缺少 override 的父子重声明均报错。
两种标记只用于 attr，不能重复或同时使用，不适用于 id。
字段依赖使用 alias 和显式 ::value；当前不执行实例计算。

## 编辑器导航

Ctrl+Click / F12 点击 overload 标记时返回其他分支的实现位置，多个目标可在
VS Code 定义列表中选择；点击 override 标记时跳转最近的父类同名属性声明。
无合法目标或字段声明无效时不提供跳转。导航使用未保存内容及原始声明位置。

字段逻辑身份为完整 namespace + 业务根实体 + 字段名，例如 core.Security.coupon。
声明所在 Bond 及其源码位置单独保留，不改变字段身份。
