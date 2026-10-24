# 单文件 JSON 中间模型

编译路径为模型仓库 → `model.yambl-ir.json` → 独立加载和静态校验。
JSON 是编译产物，模型修改仍在 YAMBL 源码中完成。本阶段不提供数据库、文件存储、
Python 类型或取数 API 生成器，也不执行实例读取。

## 修订与独立性

首版 `format_revision` 为整数 `1`。格式尚未固化，不承诺修订间兼容；结构变化时递增
修订号。读取器拒绝不支持的修订号，要求重新编译，不自动迁移。

文件完整保存本次采用的内置声明、原语目录和七个结果常量的含义。独立校验仅依赖
文件内容和该修订的检查算法，不读取原仓库，不加载本机另一版内置模型，不查询外部
字典数据。七个常量没有新增赋值、存储编码、回退、比较或运算传播规则。

## 顶层契约

所有表列出的字段均必填；无内容的列表保存为 `[]`，可选对象保存为 `null`。
未定义的结构字段和节点种类均报错。Python 契约位于编译器 `ir/model.py`，编码和解码
只处理这些有明确字段和判别值的纯数据记录。

| 字段 | 内容 |
| --- | --- |
| `format_revision` | 格式修订号 |
| `compiler_version` | 编译器软件包版本 |
| `prefix` | 模型仓库的 namespace prefix |
| `primitives` | `{name, value}` 记录；类别为 `value`、`operator` 或 `abstract_entity` |
| `constants` | 七个 `{name, value}` 记录，value 为已确认的含义 |
| `definitions` | 模型声明和本次采用的内置声明 |
| `fields` | 逻辑字段的共同类型、全部实现和适用实体或 value |
| `external_dictionaries` | 外部字典的作用域身份及全部引用位置 |
| `builtins_digest` | 内置语义内容的 SHA-256 |
| `model_digest` | 完整规范化语义内容的 SHA-256 |

`Entity` 是 `abstract_entity` 原语；泛型操作符在 `primitives` 中声明。
模型可自举的泛型别名（如 `field_mapping`）保存在 `definitions`。

## 声明、字段与身份

声明的 `kind` 为 `entity`、`value`、`type_alias`、`decorator` 或 `decodes`。
每个声明保存 `name`、`identity`、`final`、`parent`、`parameters`、`expression`、
`decorators`、`fields`、`effective`、`entries` 和 `source`。

`name` 是完整 qualified name。通常 `identity` 与它相同。普通仓库允许在
`namespace builtins` 中编写本地定义，这些定义与工具提供的全局内置定义仍是不同
声明；其 `identity` 使用 `model::builtins.Name`，`name` 仍为 `builtins.Name`。
该前缀仅是 IR 身份域，不是新增 YAMBL 语法。引用使用 `identity`，不含检出路径。

- `parent` 是显式父类型身份，未写继承时为空字符串；`Entity` 可作为显式父类型。
- `parameters` 保持形式参数顺序；每项保存 `name`、类型表达式 `type`、可选默认表达式
  `default`、是否为 pair 的 `pair`、是否可省略的 `optional` 和 `source`。
- `expression` 仅用于别名正文，其他声明为 `null`。
- `fields` 保存本声明及合并 extend 的实现；继承来的字段通过 `effective` 选取。
- `entries` 保存 `{code, ordering, decode, generated, source}`；flags 包括生成的
  `None` 和 `All`，`ordering` 保存十进制整数字符串。

字段保存 `name`、逻辑 `identity`、声明 `implementation`、`category`、原始解析表达式
`expression`、别名展开表达式 `expanded`、有效 `type`、`default`、`decorators`、
`extension` 和 `source`。`category` 为 `id/attr/static/config/snapshot/scd`。
`extension` 标记来源是否为 extend；它不会创建额外实体。

`effective` 每项包含 `{name, implementation, identity}`，直接说明该实体采用哪个
字段实现。override 保留逻辑身份；overload 的多处实现共享已有检查器确定的逻辑身份。
继承未重声明的字段仍指向原实现，原字段的声明上下文和元信息不会改成子类上下文。

顶层 `fields` 每项保存 `{identity, type, implementations, applicable}`。type 是已经
检查并协调 overload 后的共同契约；implementations 列出全部实现，applicable 列出
字段实际存在的实体或 value。后端无需重新判定字段关系或计算共同类型。

## 类型、依赖表达式和字面值

`Type` 保存 `name`、存储类别 `kind`、声明引用 `target`、`arguments`、原语
`parameters`、单值约束 `exact`、`dependent`、候选类型 `members` 和候选逻辑字段
`candidates`。`attrs` 的候选包含适用的继承、extend 和后代字段，遵循当前语言的
类别和非集合约束。动态类别或目标仍需要在运行时按表达式选择，不能将候选全集视为
每个实例的实际选择。

每个表达式都有以下字段：

| 字段 | 含义 |
| --- | --- |
| `kind` | `primitive/generic/reference/parameter/self/literal/external` |
| `name` | 原语名、参数名、self 或声明短名；literal 为空 |
| `target` | reference/external 的已解析身份；其他种类为空 |
| `literal` | 字面值对象，其他表达式为 null |
| `arguments` | 有序泛型实参 |
| `parameters` | 规范化原语参数 `{name, value}` |
| `accesses` | 有序 `{operator, name, target, source}`，operator 为 `.` 或 `::` |
| `operations` | 有序 `{operator, operand}`，operator 为 `+` 或 `-` |
| `binding` | mapping 的 `as` 绑定名，无绑定时为空 |
| `source` | 原表达式位置 |

`self` 的上下文由所属字段或 decorator 应用对象确定。可静态确定的字段选择在 access
中保存逻辑字段身份；参数和实例依赖的选择保留操作节点。`::type`、`::value`、
`::entity` 均保存为独立 access。mapping 绑定按参数顺序建立词法作用域。
字段的 `expanded` 消除透明别名，保留替换后的依赖表达式；后端无需重新解释 import
或展开别名。`dependent` 不是宽泛类型替代品，必须连同表达式使用。

字面值统一保存 `{kind, text, target, selections, mask}`。`kind` 区分
`string/integer/decimal/bool/reference/type/dictionary/code/flags`。不用 JSON null
代表七个结果常量中的任何一个。

- integer、decimal 的载荷在 `text` 中使用规范化字符串，避免 JSON 消费端丢失精度。
- bool 的 text 为 `true` 或 `false`；字符串使用 JSON 转义。
- 引用 ID 使用 reference，并携带目标实体身份；类型值和字典实例保存目标身份。
- code 保存字典身份和 code；flags 保存字典身份、排序后的独立选择项与十进制 mask。
- 可静态求值的 flags 运算归一化为独立选择项；动态操作继续保留结构化节点。

例如，`AttrCats.Attr + AttrCats.Config + AttrCats.Attr` 绑定后的 flags 值片段为：

```json
{
    "kind": "flags",
    "text": "",
    "target": "builtins.AttrCats",
    "selections": ["Attr", "Config"],
    "mask": "5"
}
```

这只是嵌套值片段，不是完整可加载文件。完整文件应由编译器生成。

## 元信息和外部字典

decorator 调用保存 `{target, arguments, bound, source}`。`arguments` 保留
位置、命名和 pair 区别及顺序；`bound` 按声明参数顺序保存 `{name, key, type}`，
补齐普通参数默认值，保留 pair 的调用处 key 和类型。省略的可选 pair 不产生绑定项。
普通参数值位于绑定类型的 `exact` 中；相同的可重复调用保留多次。

调用目标、参数类型和默认值均已解析。调用处 self 捕获、targets 和重复限制由共享
语义检查器验证。字段关系标记仍保存，以便独立检查字段身份及签名一致性。

未定义的带引号字典出现在 `external_dictionaries`，保存 `{name, sites}`。
name 包含引用文件的完整 namespace。裸名称未定义仍是编译错误。
允许的外部字典 warning 不阻止编译，CLI 逐处显示；独立加载不查询其数据。

## 来源、确定性和校验

`source` 为 `{origin, path, namespace, line, column, end_line, end_column}`。
origin 为 model 或 builtin；path 为各自仓库的相对 POSIX 路径，不允许绝对路径、
反斜线或 `..`。行列从 1 开始，结束列为排他位置。namespace 保存原词法上下文，
尤其用于跨文件 extend。源码注释、Markdown 文本块和完整源码不进入 IR。

声明、字段、字典项和无序候选按身份或名称排序。参数、pair、access 和动态运算等
具有语义顺序的内容保持顺序。输出为 UTF-8 无 BOM、LF、四空格缩进和一个末尾换行，
不包含时间戳或机器信息。同一输入和工具版本产生相同字节。

摘要使用去除 source、sites、compiler_version 和摘要自身字段的规范化内容；
decorator 使用绑定结果，忽略 arguments 的位置/命名拼写。JSON 对象键排序并使用
紧凑分隔符后计算 SHA-256。移动检出目录或只移动源码位置不改变语义摘要。
摘要用于内容标识，不是可信签名；即使摘要被重新计算，仍需完整校验。

独立校验先检查 JSON 形状、重复 key、非标准数值、修订号和引用，再将显式语义记录
交给共享静态检查器，重算有效字段、类型、别名展开、元信息、候选及外部依赖，与文件
保存的视图比较。它不重新解析源码，也不执行模型。正常实体间循环引用合法；继承、
类型依赖和值嵌套的非法循环仍报错。诊断含 JSON 路径，语义错误附原模型位置。

写入前完成全部分析和 IR 校验，再以同目录临时文件原子替换。编译或发布失败不覆盖
旧产物。`--dryrun` 完成同样校验但不创建输出文件或目录；`check-ir` 始终只读。
