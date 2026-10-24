# 字段描述与映射

`attrs<类别, 目标>` 是字段 qualified name 的值类型。类别是
[AttrCats](attr_cats.yambl) 的 code；目标是实体类型值，例如 Security 或
`self.selected_kind::value`。候选包括目标的继承、自有、extend 及后代字段，
按类别过滤，并排除 ID 和所有集合类型字段。普通 attr 属于 AttrCats.Static。
AttrCats 是 flags 字典：`AttrCats.Static + AttrCats.Config` 选择两个类别的并集；
`AttrCats.None` 不选择任何字段。重复组合同一类别不会增加候选。
`AttrCats.All` 选择全部类别；`AttrCats.All - AttrCats.Snapshot - AttrCats.Scd`
排除 snapshot 和 scd。`+`、`-` 从左到右计算，重复移除不产生额外影响。

固定目标 Entity 没有业务字段；动态 type<Entity> 字段在实例选择 Security 后，
按 Security 的业务树选择字段。字段 qualified name 使用完整 namespace、
业务根实体和字段名，例如 `core.Security.coupon`，即使实际声明位于 Bond。
不同业务根的同名字段互不合并。声明位置仍保留以支持导航和诊断。

```yambl
entity Security {
    static attr market: string
    config attr price_fallback_days: integer = 20
}
entity Selection {
    attr selected_kind: type<Security>
    attr rules: field_mapping<AttrCats.Config, self.selected_kind::value>
    attr conditions: mapping<attrs<AttrCats.Static, Security> as Attr, Attr::type>
    attr settings: field_mapping<AttrCats.Static + AttrCats.Config, Security>
}
```

mapping 的 key 绑定名由 `as Attr` 引入，仅在对应 value 类型表达式内可见。
`Attr::type` 使用字段完整类型；overload 字段采用可兼容的共同类型，各实现仍保留
自身约束。这里的 Attr 没有实例来源，不能使用 `Attr::value`。

`field_mapping` 是[语言内定义的透明别名](field_mapping.yambl)，不再是编译器原语：

```yambl
namespace builtins

type field_mapping<a: code<AttrCats>, b: type<Entity>> = mapping<attrs<a, b> as Attr, Attr::type>
```

mapping 无序、key 唯一、可部分填写。value 只能是非集合类型，field_mapping
遵循相同规则。集合属性在 attrs 选择时已排除，不能通过别名绕开限制。
field_mapping 自身是集合，不能作为另一个 mapping 的值。

类型表达式、双冒号和透明别名见[类型表达式](../syntex/type-expressions.md)，
分支字段合并见[字段关系](../syntex/field-relationships.md)。当前检查器不读取实例或执行映射。
