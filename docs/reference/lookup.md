# 具名批量匹配

`lookup` 定义一组从实体读取的匹配键。准备匹配器时读取候选实体并建立内存索引；
之后可以重复提交输入批次，按全部键精确相等查找实体 ID。匹配不清洗字符串、不做
模糊比较，也不尝试备用键。lookup 不属于属性，不创建唯一约束。

## 声明和路径

```yambl
entity Issuer {
    id issuer_id: string
    static attr name: string
}

entity Security {
    id security_id: string
    static attr name: string
    static attr issuer: Issuer
    @temporal(day: date)
    scd attr client_id: string

    lookup by_name {
        name = self.name::value()
        issuer_name = self.issuer.name::value()
    }
    @extra_input_param(client_date: date, '可选客户标识日期')
    lookup by_client_id {
        client_id = self.client_id::value(day=input.client_date ?? input.as_of_date)
    }
}
```

规则可写在 entity 或 extend 中，名称和键名使用 snake_case。规则不能为空，键名不能
重复。规则随实体继承，子类可以新增不同名称的规则，但不能重声明祖先的同名规则；
不同分支可以各自声明同名规则。字段和常量按声明所在文件的作用域解析。

左侧键名对应每条外部输入，类型由右侧字段推导；`input.name` 表示准备匹配器时的
参数。路径支持 ID、static 和 SCD 字段，中间节点必须是单值实体引用。末端必须使用
`::value()`，中间引用也可以显式调用 `::value(...)` 后继续导航。集合、config、snapshot、
computed、任意计算和 `::best_available()` 不属于此接口。
当前末端键支持 `string`、`bool`、`integer`、`snowflake_id`、`decimal`、`date`、
普通字典 code 和实体引用；`float`、`datetime`、结构化值、flags code 和动态依赖类型
尚不支持。实体引用键使用声明类型的 `EntityRef`，不能直接传入 ID 字符串。

每个路径节点独立确定时间和维度。未绑定参数按名称合并，类型和约束须兼容；
`input.name` 可将某个参数重命名。参数可绑定仅依赖输入、字面量、编译期常量和字典成员的纯表达式；
固定绑定不会出现在准备方法的参数中。`@extra_input_param` 可声明可选输入、默认值和说明；
其余推导出的准备参数必填。准备参数以关键字传入，参数表达式在准备匹配器时求值一次，
缺少必需输入、类型不符或求值失败返回 `ERROR`。
SCD 使用左闭右开区间，缺口不回退；所有维度都需要确定，不自动选择 Hierarchy。

不依赖输入的固定绑定在编译期求值，求值失败会使编译器检查报错。编辑器暂不对包含浮点
计算或十进制转字符串的固定绑定提前求值，例如 `to_string(1 / 0)` 的求值错误可能不会
在编辑器中显示；请以编译器的 `check` 结果为准。

上面的 `by_client_id` 有一个输入键 `client_id: string`。`@extra_input_param` 将
`client_date` 声明为可省略的日期输入，后面的字符串是说明；`input.as_of_date` 则从
`day` 的日期类型推导为必填准备参数。提供 `client_date` 时用它读取 SCD；省略时
`??` 使用 `as_of_date`，它不处理字段的非正常结果。以下 `reader` 是已打开的生成包读取会话；
两个参数都在准备时传入：

```python
from datetime import date

reader.prepare_security_by_client_id(as_of_date=date(2026, 10, 28))
reader.prepare_security_by_client_id(
    as_of_date=date(2026, 10, 28), client_date=date(2026, 10, 1)
)
```

以下写法不符合 lookup 的路径约束：

```yambl
lookup invalid {
    name = self.name::value() + 'suffix'
}
```

lookup 键只能读取受支持的字段路径；需要计算结果时，应在调用方先计算输入。

## Python 接口

生成包为上述规则提供 `SecurityByClientIdKey`、`SecurityByClientIdMatcher` 和
`reader.prepare_security_by_client_id(as_of_date=...)`。Key 是不可变的关键字记录，字段
顺序与规则一致。子类有自己的准备方法，候选范围限定为该子类及其后代，并复用原规则的
Key 和 Matcher 类型。准备方法返回 `Success[Matcher] | NonNormalResult`。

```python
from datetime import date

from sample_model import SecurityByClientIdKey, Success

# reader 是已打开的生成包读取会话。
prepared = reader.prepare_security_by_client_id(as_of_date=date(2026, 10, 28))
if not isinstance(prepared, Success):
    raise RuntimeError(prepared.message)

batch = prepared.value.match_many([
    SecurityByClientIdKey(client_id="600000.SH"),
    SecurityByClientIdKey(client_id="000001.SZ"),
])
if not isinstance(batch, Success):
    raise RuntimeError(batch.message)
for result in batch.value:
    print(result)
```

`match_many` 接收 Key 记录序列，保留输入顺序和重复项；空批次返回成功的空元组。
每条结果可能是 `Success(id)`、`NonNormalResult`（未命中为 `NO_ENTRY`，输入错误为
`ERROR`）或 `AmbiguousMatch(candidates=...)`。歧义候选 ID 去重并按原生类型升序排列。
单条输入错误不影响其他输入；批次容器错误返回外层 `ERROR`。输入不会自动将字符串
转换为日期、Decimal 或字典 code。

准备时，缺值、不适用字段或悬空引用使候选被跳过；遇到错误则准备失败，不返回部分
匹配器。`matcher.stats` 包含扫描实体数、建键实体数、跳过实体数、不同键数和歧义键数。
匹配器不依赖打开的 reader；关闭 reader 后仍可使用。写入或回滚不会改变已准备的
匹配器，要查看新数据应通过新会话重新准备。

从创建仓库到准备匹配器的完整示例见[入门教程](../tutorial/getting-started.md#8-批量匹配商品)。

准备阶段读取相关表并在内存建立索引，成本随相关数据量、路径和候选数量增长；
后续批次只校验输入并查询内存索引，不读取数据库或文件。匹配器保存键与候选 ID，
不会保存历史批次。
