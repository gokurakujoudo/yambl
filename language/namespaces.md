# 命名空间与跨文件引用

当前业务案例将实体和代码字典放在不同文件中，通过命名空间和显式导入引用字典。
本页记录案例的写法；完整的名称解析规则仍在讨论中。

## 当前案例

`fmc-data-model/decodes/currencies.yambl`：

```text
namespace decodes

decodes Currencies {
    - 100 CNY: 'CNY'
    - 200 USD: 'USD'
}
```

`fmc-data-model/core/security.yambl`：

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

- 同一命名空间的不同文件是否自动共享声明。
- 命名空间由显式声明决定，还是必须与仓库目录对应；文件名是否参与名称解析。
- 导入名称仅在当前文件有效，还是在整个命名空间内有效。
- 一个文件能否包含多个命名空间，以及能否省略命名空间声明。
- 命名冲突、别名、完整名称、可见性和循环引用的处理方式。
- 编译单个文件时如何查找根标记、确定仓库边界并定位其他文件。

当前仅记录按名称导入的形式，尚未定义通配符导入、批量导入或别名语法。
