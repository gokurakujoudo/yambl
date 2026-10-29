# 计算字段与批量执行

计算字段是独立的 `computed` 属性类别，使用不可变 `let` 和最后一个显式 `return`。
它可以声明在 entity 或 extend 中，也支持继承及契约一致的 override/overload。
计算实现可不同，但返回类型、推导参数及默认关系必须相同；不能与存储字段互相重声明。
计算字段不生成表列，不参与 ConfigGroup.when。`AttrCats.Computed` 的位值为 32。

```yambl
entity Security {
    static attr price: decimal
}

entity Holding {
    static attr quantity: decimal
    static attr security: Security
    computed attr market_value: decimal {
        return self.quantity::value() * self.security.price::best_available()
    }
}
```

表达式支持比较、布尔运算、加减乘除、`if ... then ... else ...`，不支持循环、
修改赋值或任意代码执行。分支、布尔短路与 recover 只执行实际选中的表达式。
中间引用路径透明导航，例如 `self.security.price::value()`；无法解析引用时保留原生结果。
末端字段必须显式取值，集合不会隐式展开。

## 命名 dimension 与字段操作

```yambl
entity Security {
    config attr price_fallback_days: integer = 20
    dimension price_source_dimension {
        value price_source: code<'PriceSources'>
        hierarchy price_hierarchy: Hierarchy = 'LocalHierarchy'
        fallback_days = self.price_fallback_days::value()
    }
    @temporal(as_of_date: date)
    @dimension(price_source_dimension)
    snapshot attr price: decimal
}
```

dimension 属于实体，可在 extend 中定义并由子类继承使用；同作用域重名报错。
value 必填，类型为 string 或 code；hierarchy 与 fallback_days 可选。声明本身不接受
decorator。`dimension_ref` 只用于编译期元信息，不能作为存储字段类型。

| 写法 | 作用 |
| --- | --- |
| `field::value(...)` | 存储字段按日期和全部维度精确取值；计算字段绑定参数并求值 |
| `field::best_available(...)` | 仅存储字段按声明的 Hierarchy 和回退规则选择 |

`::value` 对 snapshot 只读取指定日期，对 SCD 读取当天有效期间；static 无日期，
config 读取有效配置。它不自动使用 Hierarchy 或日期回退。计算字段的参数和省略默认关系
继续从依赖推导；两类字段未显式绑定的参数均按名称传递。`::best_available` 的选择契约
保持不变，不能直接用于计算字段。

字段描述不能直接作为计算值。`let x = self.quantity`、`return self.quantity`、
`self.quantity * 2` 均报错，须在末端加 `::value(...)` 或 `::best_available(...)`。
同样要求适用于 lambda、参数、recover 接收者及 dimension 的 fallback_days 表达式。
中间引用允许 `h.security.price::value()`；单独保存引用须写
`let security = h.security::value()`。`input.name`、局部变量及已取得的结构化 value 成员
不是实体字段描述，仍直接使用。类型表达式中的 `self.field::value` 保持原含义与写法。

显式 value 优先于 hierarchy，显式 hierarchy 优先于声明默认值。没有可用 Hierarchy
时必须提供 value；最多自动选择一个 Hierarchy，其余维度必须明确提供。
Hierarchy ordering 是任意精度整数，必须唯一，按真实整数升序排列。

snapshot 选择包含两端的 `[as_of_date - fallback_days, as_of_date]`，先按日期倒序，
再按来源优先级。fallback_days 只用于 snapshot，由实际证券实例的有效 config 决定；
省略则为零，负数报 ERROR，极大整数不会造成日期溢出。SCD 不跨缺口回退，static 不使用日期。
NO_ENTRY 视为不存在，EMPTY 与 NOT_APPLICABLE 跳过；无候选返回 NO_ENTRY，候选全部被
跳过返回 NO_DATA。选中值之前的 ERROR 阻止选择；选中正常值后不解码更低优先级载荷。
结构、摘要或整体查询错误仍返回 ERROR。

## 参数推导与绑定

未绑定依赖按参数名合并，类型、约束及默认关系须兼容。不同名称保持独立。
用 `input.name` 引入或重命名外部参数；未知普通名字不是隐式参数。
`input.price_date ?? input.as_of_date` 只处理调用时省略参数，不处理 EMPTY 等数据结果。
`??` 低于布尔 `or`，按右结合解析；左侧必须是
已有推导类型或显式声明类型的 `input.name`。右侧按左侧类型检查，仅在输入未提供时求值。
`0`、`false`、空字符串和显式提供的值都不触发省略回退。数据结果使用 `recover`。
省略使用独立内部标记，不使用 None。默认依赖图、计算依赖图出现循环时报错。
所有分支参与静态推导，但运行时只执行实际使用的分支。

常量或内部字段表达式绑定某个依赖后，该依赖不再贡献外部参数。只有全部依赖均已绑定，
同名参数才从对外签名消失。对子计算的显式绑定只影响该子树。

各字段独立遵循自己的取数逻辑。合并的日期参数表示共同的请求日期，不要求各字段
最终选中的记录日期相同。某个字段回退到历史记录，不改变其他字段或子计算的请求日期，
也不改写 `input`。例如请求 10 月 25 日的债券全价，净价回退到 10 月 23 日时，
应计利息仍按 10 月 25 日取数，再遵循自身的取数规则。需要日期联动时必须显式绑定；
不能从其他字段的回退结果隐式推导新的请求日期。

`@extra_input_params` 在计算字段上显式声明可省略的输入，并可提供默认值和说明：

```yambl
@extra_input_params(industry_date: date, 'Industry observation date')
@extra_input_params(price_date: date = '2026-01-01', description='Price observation date')
computed attr amount: money {
    return self.price::value(as_of_date=input.price_date ?? input.as_of_date)
}
```

每次调用接收一个 pair；可重复声明不同输入，同名声明报错。声明参与类型检查、补全、
悬停、IR 和生成文档；与自动推导的同名输入合并时，类型与约束必须一致。
调用者提供的值优先，其次为声明默认值，再次为使用处的 `??`。声明默认值使后备分支
不再贡献外部参数，但该分支仍接受类型检查。无默认值的显式输入可省略；若使用处也
没有回退，运行时实际需要它时返回 ERROR，不把省略解释为 EMPTY 或 NO_ENTRY。
默认值使用现有 decorator 值表达式，不能包含实例读取或非正常结果常量。date 默认值
使用有效的 `YYYY-MM-DD` 字符串；引用默认值按目标 ID 约束检查，不查询实例是否存在。

格式化保留计算体内已有的换行，不强制将 lambda 或方法链合并成一行。括号内续行
每层增加四空格，行首闭括号回退一级；lambda 体中的 receiver 与随后单独一行的
`.recover(...)` 使用同一级缩进。短的字段操作参数列表可以保持同行，去除行末空白。

## 集合方法与结果

`Seq<T>` 与 `Grouped<K,T>` 仅是计算过程类型，不增加物理集合格式。

| 方法 | 签名与行为 |
| --- | --- |
| map(f) | Seq<T> → Seq<U>，保留行数和重复贡献 |
| filter(predicate) | Seq<T> → Seq<T>，保留条件为真的行 |
| flat_map(f) | Seq<T> → Seq<U>，展开一层 |
| group_by(key) | Seq<T> → Grouped<K,T>，按类型化键相等分组 |
| sum_by(value) | 序列返回数值；分组返回 mapping<K, Number> |
| recover(cases) | 显式匹配非正常状态，未匹配结果保持原样 |

读取请求可去重，持仓贡献不能去重。空序列求和为对应数值类型的零，空分组为正常空 mapping。
integer 保持任意精度，与 decimal 混算使用 decimal；decimal 运算不受 Python 默认精度截断。
`/` 无论操作数为 integer、decimal 还是 float，结果均为 float；非有限结果或溢出为
ERROR。`//` 返回向下取整的 integer，负数同样向负无穷方向取整，例如 `-7 // 3 = -3`。
两种除法的除零均为 ERROR。结果 precision/scale 超限报 ERROR，不自动舍入。

```yambl
expression.recover(
    case EMPTY -> replacement,
    case NO_ENTRY, NO_DATA -> replacement,
    case PARTIAL as p -> p.value
)
```

重复标签、非 PARTIAL 绑定或不兼容分支类型报错。PARTIAL 必须携带有效载荷和不可变 issues，
不增加到物理状态编码中。显式返回 p.value 表示接受部分结果；未显式接受时，后续算子保留 issues。

严格模式不丢弃失败贡献：同一状态返回该状态，混合状态或任何 ERROR 返回 ERROR。
外层 `best_effort=True` 传递整棵计算树，允许略过六种非错误状态；有有效贡献且有遗漏时
返回 Partial，全失败仍返回失败。ERROR 只能由源码 recover 显式处理。
issues 保留逻辑字段、实例、日期、维度和贡献位置，共享读取不合并贡献定位。

## 有效 ConfigGroup

每个 config 字段按 **匹配组 → 实例值 → 实际子类型默认值** 求值。组 priority 是必填
integer，数值越大越优先；最高优先级并列时，类型化值相同则合并，否则 ERROR。
组必须设置该字段才参与该字段竞争。自动考虑所有组，不增加启用列表参数。
when 只读取存储 static 字段并作等值 AND；非错误非正常值为不匹配，ERROR 阻止配置求值。
实例仅 NO_ENTRY 触发默认值，EMPTY/NOT_APPLICABLE 不触发。结果记录 ConfigGroup 来源和组身份。
会话内配置保持一致，修改后重新打开；缓存按实际实例和实现区分。

## 产物、执行与边界

IR 修订号 8，运行时契约 8，存储布局 7，JSONL 封装格式 2。
IR 保存独立表达式 AST、解析字段身份、参数默认图及相对源码来源，不保存可执行源码字符串。
生成包要求 Python 3.14+，运行依赖由生成项目的 `pyproject.toml` 声明。
计算执行生成阶段确定的函数，不重新解释 YAMBL，不使用 eval。

计算字段仅生成 read 方法和 frozen 请求数据类；存储字段保留惰性 property。
批量 API 返回外层查询结果和按请求顺序排列的逐请求结果，保留重复请求。
SQLite 按依赖阶段批量查询身份、静态字段、配置、行业期间和价格窗口；精确金额在 Python 中计算。
文件后端每表每会话只加载一次，复用等值和时间索引。两后端共享选择、状态、配置和聚合规则。
完整 property 缓存可复用；关闭后只允许完全由缓存完成的计算。操作失败 ERROR 不缓存。

不提供通用函数声明、通用查询语言、数据库迁移、汇率换算或多 Hierarchy 自动组合。
数据写入和回滚使用 [事务接口](transactions.md)。
