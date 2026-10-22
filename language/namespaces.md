# 命名空间与跨文件引用

当前业务案例将实体和代码字典放在不同文件中，通过命名空间和显式导入引用字典。
命名空间由文件中的声明决定，不强制与目录结构对应；一般建议两者保持一致。
同一命名空间下的声明可以跨文件直接引用。跨命名空间通过
`from 命名空间 import 名称` 显式导入，导入只在当前文件内有效。

## 当前案例

`fmc-data-model/decodes/currencies.yambl`：

```text
namespace decodes

decodes Currencies {
    - 100 CNY: 'CNY'
    - 200 USD: 'USD'
}
```

`fmc-data-model/core/security.yambl`（节选）：

```text
namespace core

from decodes import Currencies

entity Security {
    id security_id: string['[a-zA-Z0-9]{12}']

    attr currency: code<Currencies>
}
```

`namespace 名称` 声明文件使用的命名空间。案例使用
`from 命名空间 import 名称` 引入其他命名空间中的声明。
`Currencies` 是导入的 `Decodes` 实例，在 `code<Currencies>` 中使用；
它不是通过导入产生的新实体类型。

`core/fund.yambl`、`core/holdings_entry.yambl` 和 `core/security.yambl`
都声明了 `namespace core`，案例中的 `Fund` 直接引用 `HoldingEntry`，
`HoldingEntry` 直接引用 `Security`，这两处没有显式导入。

## 待讨论的解析规则

当前案例仓库根目录新增了 `yambl-root.lclcfg`：

```text
# Mark this is the root of a YAMBL repo
prefix: ''
```

该文件标记 YAMBL 仓库根目录。`prefix` 对命名空间的作用以及根目录查找算法
仍待讨论。

- 一个文件能否包含多个命名空间，以及能否省略命名空间声明。
- 命名冲突、别名、完整名称、可见性和循环引用的处理方式。
- 编译单个文件时如何查找根标记、确定仓库边界并定位其他文件。

当前仅记录按名称导入的形式，尚未定义通配符导入、批量导入或别名语法。

## 当前编译器行为

`yambl-compiler` 的首版检查器支持上述声明和导入。检查单个文件时，向上查找最近的
`yambl-root.lclcfg`，找到后将该目录下的 YAMBL 文件作为解析单元；未找到时仅检查
该文件。检查目录时使用给定目录下的文件。根标记目前只用于确定边界，不执行其中
的配置，也不解释 `prefix`。

检查器暂允许省略 namespace，归入当前解析单元的未命名空间，每个文件最多一个
namespace。重复声明、导入名称冲突及不存在的导入会报错。这些是当前工具的边界，
其余待定语言规则仍需后续讨论。

`extend` 的目标和 `inherits` 的父类型也按当前文件的可见名称解析。同 namespace
可以在另一个文件扩展实体；跨 namespace 必须导入目标。扩展不引入新实体或
命名空间符号，只将字段加入目标类型；字段类型和注解中的引用保留定义文件的作用域。
文件和声明顺序不影响合并后的字段集合。

`code<Currencies>` 和 `code<'Currencies'>` 使用相同的字典名称查找规则。
未定义或未导入的字典按外部 Decodes 处理，逐处 warning，不阻止检查通过。
不存在的显式导入和未知实体类型仍报错；warning 不会掩盖这些错误。
