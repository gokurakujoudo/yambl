# 命名空间与跨文件引用

当前业务案例将实体和代码字典放在不同文件中，通过命名空间和显式导入引用字典。
命名空间由文件中的声明决定，不强制与目录结构对应；一般建议两者保持一致。
同一命名空间下的声明可以跨文件直接引用。跨命名空间通过
`from 命名空间 import 名称` 显式导入，导入只在当前文件内有效。

## 当前案例

`decodes/currencies.yambl`：

```text
namespace decodes

decodes Currencies {
    - 100 CNY: 'CNY'
    - 200 USD: 'USD'
}
```

`core/security.yambl`：

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

多个文件都声明 `namespace core` 时，它们之间可以直接引用同一命名空间内的声明。

## 数据模型仓库

包含 `yambl-root.lclcfg` 的目录是一个 YAMBL 数据模型仓库，与 Git 仓库无关。
根配置要求一个静态字符串 prefix，允许注释、空行和单引号或双引号字符串：

```text
prefix: 'example'
```

空 prefix 合法；非空 prefix 为点分隔的 ASCII 标识符。未知或重复配置项、缺失
prefix、表达式和其他配置加载语法均报错，不执行配置。
完整命名空间为仓库 prefix 与文件 namespace 的拼接。例如上面的仓库中，
`namespace core` 得到 `example.core`；省略 namespace 时归入 `example`。
每文件至多一个 namespace，声明位于 import 和模型声明之前。

仓库内导入使用相对名称：`from decodes import Currencies` 定位到
`example.decodes.Currencies`，不尝试绝对名称回退。暂不支持跨普通仓库导入、
依赖配置、导入别名或通配符。同名声明和导入冲突报错。

`check` 对文件或子目录向上查找最近根标记，检查所属整仓库。父仓库发现嵌套
根标记时报错。无根标记时按输入文件或目录独立检查，prefix 为空；无根目录
扫描发现下属仓库时提示分别指定仓库，不将多个仓库混为一个编译单元。
`format` 始终只处理显式输入的文件或目录，不扩大到所属整仓库。

## 内置模型仓库

`yambl/lang/` 是随工具提供的内置仓库，prefix 为空，模型文件声明 `namespace builtins`。
其中的实体和值类型可由任何仓库直接使用，无需导入；普通空前缀仓库不会自动
成为 builtins。完整命名空间 `builtins` 允许编写内置模型定义，使源文件在任意检出路径
都能独立检查和编辑；同一仓库中的重复声明仍报错。其他命名空间不得重声明或导入
遮蔽内置名称，`example.builtins` 也不例外。只有工具携带的模型获得全局可见性；在本地
`builtins` 中新增声明不会自动导出给其他命名空间或仓库。基础值类型和泛型仍由语言实现。
编译器与 VS Code 安装包携带模型资源，运行时无需其他仓库或网络。

`extend` 的目标和 `inherits` 的父类型也按当前文件的可见名称解析。同 namespace
可以在另一个文件扩展实体；跨 namespace 必须导入目标。扩展不引入新实体或
命名空间符号，只将字段加入目标类型；字段类型和注解中的引用保留定义文件的作用域。
文件和声明顺序不影响合并后的字段集合。

`code<Currencies>` 和 `code<'Currencies'>` 使用相同的字典名称查找规则。
裸名称未定义或未导入时报错。带引号的名称若无法解析到声明，则按外部 Decodes
处理：CLI 逐处 warning，不阻止检查通过；LSP 不显示该 warning。
不存在的显式导入和未知实体类型仍报错；warning 不会掩盖这些错误。
