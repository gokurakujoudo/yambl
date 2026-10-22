# Decodes

`Decodes` 和 `DecodesEntry` 是 YAMBL 的内置模型，定义见
[decodes.yambl](decodes.yambl)。`decodes` 是声明 `Decodes` 实例的专用关键字，
业务模型可直接在 YAMBL 文件中定义这些实例。

## 模型含义

`Decodes.decodes_id` 标识一个代码字典，`entries` 是该字典的条目引用集合。

| DecodesEntry 字段 | 类型 | 含义 |
| --- | --- | --- |
| `code` | `string` | 在所属 Decodes 中查找 decode 的键 |
| `decode` | `string` | code 对应的内容 |
| `ordering` | `integer` | 数据使用方对条目进行升序排序的基准 |

同一 `Decodes` 中的 `code` 是查找键。`entries` 仍是无序、无重复引用的
`collection<DecodesEntry>`；源文件中的条目顺序不赋予集合顺序。数据使用方
需要按字典顺序展示条目时，按照 `ordering` 升序排序。

## 身份、单例与继承

`Decodes` 以 `decodes_id` 标识，每个标识对应唯一的字典实例。
`DecodesEntry` 以 `(decodes_id, code)` 共同标识，每组标识对应唯一的条目实例，
无需额外的 `id` 字段。其中 `decodes_id` 来自条目所属的字典。

两种模型的单例语义均按上述身份确定，可以同时存在 `Currencies`、`Countries`
等多个字典。不同字典中相同的 `code` 标识不同的条目。

`Decodes` 禁止继承。`decodes Currencies` 定义的是 `Decodes` 的单例实例，
不创建名为 `Currencies` 的实体类型或 `Decodes` 子类。因此，`attr x: Currencies`
不是合法的字段类型声明。

## 代码值与字典引用

| 字段声明 | 含义 | 合理的取值 |
| --- | --- | --- |
| `attr x: code<Currencies>` | Currencies 字典中的代码值 | `Currencies.CNY` |
| `attr y: Decodes` | 一个 Decodes 字典实例的引用 | `Currencies` |

`Currencies.CNY` 表示该字典中 `code` 为 `CNY` 的代码值，`Currencies` 表示
字典实例本身。上述示例沿用复数命名约定。

## 直接声明实例

最新业务案例在 `fmc-data-model/decodes/currencies.yambl` 中声明字典：

```text
namespace decodes

decodes Currencies {
    - 100 CNY: 'CNY'
    - 200 USD: 'USD'
}
```

`fmc-data-model/core/security.yambl` 导入并使用字典：

```text
namespace core

from decodes import Currencies

entity Security {
    id security_id: string['[a-zA-Z0-9]{12}']

    attr currency: code<Currencies>
}
```

`Currencies` 是实例的 `decodes_id`，使用复数命名。声明头使用
`decodes 名称 { ... }`，每条条目写作 `- ordering code: decode`：

- `100` 对应 `ordering`。
- `CNY` 对应字符串键 `code`，在该位置使用不带引号的写法。
- `'CNY'` 对应字符串内容 `decode`。

`code` 与 `decode` 可以表达不同内容；例子中它们恰好相同。
值类型原语 `code<Currencies>` 的含义见 [code](../builtins/value-types.md#code)。

当前实例采用 `Currencies` 这样的 PascalCase 复数名称；命名空间中的查找
方式、完整名称的写法及名称字符集仍待确定。拆分文件后的讨论见
[命名空间与跨文件引用](../language/namespaces.md)。

## 待确定

- 条目裸 `code` 的完整字符集，以及包含空白或标点的代码如何书写。
- `ordering` 相同时的次级排序规则。
- `code` 的跨命名空间解析，以及不同字典之间的代码值兼容规则。

模型描述和类型规则不意味着执行业务数据质量校验。解析器与类型检查器尚未实现。
