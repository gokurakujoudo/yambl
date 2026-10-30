# 实体关系与反向引用

关系注解描述实体引用的基数，并允许从目标实体读取关联的来源实体。

```yambl
entity Issuer {
    id issuer_id: string

    @reverse_relationship(Security.issuer)
    static attr securities: collection<Security>
}

entity Security {
    id security_id: string

    @relationship(many, one)
    static attr issuer: Issuer
}
```

`@relationship(x, y)` 修饰正向存储属性。`x` 是 `one` 或 `many`，限制同一坐标下每个目标关联的来源数量；`y` 描述来源一侧的值：`maybe` 允许无值，单体引用的 `one` 要求正常引用，引用集合的 `many` 要求非空集合。单体引用只接受 `maybe` 或 `one`，集合只接受 `maybe` 或 `many`。这些词只用于关系注解参数。

`@reverse_relationship(Security.issuer)` 指向带正向关系注解的存储属性。反向属性所属实体必须是正向引用的目标类型；正向 `x` 为 `one` 时，反向类型为来源实体的单体引用，否则为来源实体的引用集合。继承的正向属性沿用声明关系，读取时按来源实例实际类型筛选。

反向引用也可沿多跳正向一对一关系查找起点：

```yambl
entity A {
    id id: string
    @relationship(one, maybe) static attr b: B
}

entity B {
    id id: string
    @relationship(one, maybe) static attr c: C
}

entity C {
    id id: string
    @reverse_relationship(A.b.c) static attr a: A
}
```

路径从声明的起点类型开始，每一跳都必须是带 `@relationship(one, maybe)` 或
`@relationship(one, one)` 的正向单体引用；不能经过集合、计算字段或反向属性。
路径最后的目标须与反向属性所属实体一致，反向属性的类型为起点实体。任一跳没有来源时
返回 NO_ENTRY，任一跳有多个来源时返回 ERROR，即使后续跳最终只找到一个起点也不忽略该错误。
每一跳及反向属性的类别、时间参数与维度声明身份必须一致。snapshot 使用同一天和维度，
scd 在请求日逐跳读取有效区间，不跨缺口回退。

两种注解只适用于实体 static、snapshot 和 scd 属性。两侧的属性类别、时间参数名称和类型必须一致；维度必须引用相同的声明集合，注解顺序不限。关系维度不能配置 hierarchy 或 fallback。反向属性不能再标正向关系或存储分组。

反向属性只读，不建立物理反向表，Plan 不能写入。单体没有匹配时返回 NO_ENTRY，多个来源返回 ERROR；集合没有匹配时返回正常空集。结果按来源身份去重，集合无序。计算字段可读取反向属性；lookup 仍遵守原有属性类别和单体路径限制。

显式数据校验和 Plan 应用后的最终候选校验检查基数。无维度 static 的必填规则覆盖全部适用实例；时态或有维度的关系只检查已有记录，不枚举日期和维度空间。snapshot 按同一天、同一维度坐标检查；scd 按有效区间重叠检查 `x=one`。同一来源在重叠记录中重复出现只计一次。一个 Plan 的中间步骤可以暂时不满足关系约束。

SQLite 与 JSONL 后端均支持反向读取、显式数据校验和最终候选的基数校验。
