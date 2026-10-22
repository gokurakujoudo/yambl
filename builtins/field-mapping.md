# 实体类型与字段映射

`type<T>` 是实体类型值原语，`field_mapping<类别, 目标>` 是按属性定义约束 key-value
的集合原语。两者无需导入。

## type

`type<Entity>` 的值可为任意实体类型；`Entity` 仅表示这一约束，不是公共根实体，
不能直接作为属性引用类型、继承目标或字段映射的具体目标。
`type<Security>` 允许 `Security` 及其所有子类。约束类型按声明文件作用域解析，
不能填入字典实例、值类型或字符串名称。

`type<T>` 属于值类型，可用于 `values<type<Entity>>` 或 map 的值。
它不是实体引用，不能作为 collection 元素或 map 的 key。
尚无类型值默认值或赋值字面量语法。

## field_mapping

```text
entity Security {
    static attr market: string
    config attr price_fallback_days: integer = 20
}

entity Selection {
    attr rules: field_mapping<config, self.selected_kind>
    attr selected_kind: type<Security>
    attr conditions: field_mapping<static, Security>
}
```

第一个参数选择一个属性类别：`attr`、`static`、`config`、`snapshot` 或 `scd`。
普通 attr 只属于 attr 类别，id 不属于任何 attr 类别。

第二个参数可以直接指定实体类型，也可以引用 `self.<字段>`。self 表示当前实体实例，
字段名不限于 `entity_type`，只要该字段已定义且具有合法的 `type<...>` 类型即可。
允许前向引用、继承和 extend 引入的字段，不要求字段标记为 static。
当前支持单层字段访问，不支持表达式或多层路径。引用继承、extend 字段时，
其类型名称仍在原始声明文件的作用域解析。

候选字段包含目标实体的继承属性、自有属性、extend 属性及所有后代新增属性，
再按所选类别过滤。mapping 无序、key 唯一，可以为空或只指定部分候选字段。
每个值遵循相应属性的完整类型；它可以是值、实体引用或集合，
不套用普通 map 对 value 禁止集合的限制。

field_mapping 本身属于集合类型，因此不能作为 values 元素、collection 元素、
map 的 key 或 value。它不定义排序规则。

字段 key 具有逻辑身份。继承和合法 override 保持字段身份；同一继承树不同分支
新增的同名属性，须使用 [@overload](../language/field-relationships.md) 并通过
签名一致性检查，才能视为同一个字段。实现位置和各分支 config 默认值分别保留。

当目标来自 self 字段时，实际候选范围随当前实例选择的实体类型确定。
静态检查只验证声明与约束，不读取实例、不检查 mapping 数据，也不生成运行时代码。
