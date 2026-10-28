# VS Code 扩展

`tools/vscode/` 包含扩展、语言服务及其测试。

本扩展提供 YAMBL 语法高亮和自包含 [LSP](lsp/README.md)。安装包使用
VS Code 自带的 Node 运行时，不需要另外安装 Python、Node、npm 依赖、其他扩展，
也不需要外部服务或联网下载组件。

## 安装与使用

从 `yambl` 仓库根目录运行：

```powershell
.\tools\vscode\install.ps1
```

脚本使用 .NET 生成 `build/vscode/yambl-0.1.29.vsix`，然后通过 `code` 命令
安装。也可以只打包，再通过 VS Code 的 “Install from VSIX” 安装到其他机器：

```powershell
.\tools\vscode\install.ps1 -PackageOnly
```

安装后执行 `Developer: Reload Window`，打开 `.yambl`、`.yaplan` 或 `.yatran` 文件即可启动语言服务。
三种文件均支持命令面板或编辑器右键菜单中的 **Format Document**（Windows：Shift+Alt+F），格式化整个文件并统一为 LF；无须选择文本或绑定模型目录。扩展为三种语言提供默认 formatter，用户可在设置中覆盖。存在语法错误时不修改文件；Transaction 格式化保留摘要。

YAMBL 模型文件支持：

- Problems 面板中的实时语法、类型及引用诊断；未定义的裸字典名称报错，带引号的外部字典不提示。
- Format Document 格式化当前文档；存在语法错误时不提供修改。
- 输入补全，包括关键字、注解、内置类型和当前文件可见的声明。
- 类型悬停和补全显示内置类型的含义与参数说明。输入 `decimal[` 或 `string[` 时，
  签名提示说明参数，并补全命名参数；泛型参数位置提供类型约束说明和可见名称补全。
- `::` 后按接收字段提示 `value(...)`，存储字段还提示 `best_available(...)`；支持未完成的调用、参数补全与签名提示。
- 计算中的末端字段使用 `::value(...)` 取值。
- `@sparse` / `@dense` 提供 cat 参数补全、签名悬停和定义跳转；补全排除集合、
  非 static 属性以及与已有 sparse/dense/dimension 标记互斥的选项。
- 七个非正常值常量 `NOT_DEFINED`、`NOT_APPLICABLE`、`EMPTY`、`NO_ENTRY`、`NO_DATA`、
  `ENTITY_NOT_FOUND`、`ERROR` 提供高亮、常量补全和含义悬停。显式赋值、回退及运算
  计算表达式支持 recover 与 PARTIAL，config 默认值仍不接受结果常量。
- `@flags`、二进制掩码和 `+`、`-` 支持高亮；字典点号后补全 PascalCase code，包括
  flags 自动生成的 `None`、`All`。组合中每一项可跳转到条目；生成项跳转所属字典声明。
- 属性悬停显示完整类型（含泛型与参数）、存在的 title 和 description。
- 在引用处 Go to Definition 跳转实体或字典；Ctrl+Click 字典声明展开引用列表。
- 字典实例名与值类型使用相同颜色，包括声明、导入和 `code<Currencies>` 的裸名称；
  `code<'PriceSources'>` 的带引号参数保持字符串颜色。
- Ctrl+Click `@overload` 查看其他分支实现，`@override` 跳转最近的父类声明。
- `self.<字段>` 可引用任意已定义的 `type<...>` 字段，支持跳转及 `self.` 后补全。
- Outline 查看实体、字段和字典条目；扩展属性显示为 `Entity.field`。

`.yaplan` 和 `.yatran` 支持高亮、语法诊断、关键字补全、分组 Outline 和格式化。
格式化保留数据行顺序、注释及字面量拼写；Plan 可省略模型摘要，事务文件仍须包含
模型摘要并校验语义完整性摘要。

在事务文件中执行 `YAMBL: Select Transaction Model Directory`，选择包含
`yambl-root.lclcfg` 的模型源码目录。绑定按文档保存在当前 VS Code 工作区状态中。
绑定后，Ctrl+Click 可跳转操作目标、字段列和 scope 坐标的定义；字段补全按操作过滤，
支持继承、extend、维度和时间坐标。模型的未保存修改和绑定切换会重新解析。
执行 `YAMBL: Clear Transaction Model Binding` 可清除当前文档的绑定。
静态诊断检查操作适用性、列名、scope、引用 ID 类型、基础字面量、Decimal 精度、
日期、字典 code、别名和 exact 约束。实体补丁不能写入 computed、集合或带坐标字段。
集合及结构值按模型定义检查成员类型；ConfigGroup 映射检查字段类别和值类型，
目标实体类型在文件中明确给出时还检查所属继承树。before/after 镜像使用相同的行类型规则。
Plan 在同一实体的同一逻辑属性上重复写入时会报错；按 ID 插入实体后写入其他属性或
时态字段仍然允许。
数据实例是否存在、文件之外的配置实例上下文及回滚冲突由执行阶段检查。

语言服务读取未保存的编辑内容，并按最近的 `yambl-root.lclcfg` 查找同仓库文件；
没有根标记时只检查当前文件。根标记仅用于定位，不执行其配置。打开的不同仓库
分别解析，不合并同名类型。文件变化后自动更新诊断。

运行日志位于 Output → YAMBL。若语言服务异常退出，可重载窗口重新启动。
当前支持桌面扩展宿主的本地文件和未保存文档；不支持浏览器或虚拟文件系统。
首版不提供重命名或代码修复，详细边界见 LSP 文档。

引用列表包含当前编译单元中的导入和类型使用，支持未保存的修改，并按实际声明
区分不同 namespace 的同名字典。字典声明上的 Ctrl+Click / F12 使用 VS Code
的 Peek References；即使只有一处引用，也在列表中展示。YAMBL 的默认
`editor.gotoLocation.alternativeDefinitionCommand` 为 `editor.action.referenceSearch.trigger`，
用户显式覆盖该设置时以用户设置为准。也可直接使用 Find All References。

裸名称如 `code<PortfolioGroupTypes>` 必须解析到可见字典，否则报错。
带引号的动态字典如 `code<'PriceSources'>` 可由模型外部提供，编辑器不提示，
CLI 仍逐处 warning。显式导入失败和未知实体类型仍会在编辑器中报错。

## 高亮与语言规则同步

支持命名空间、导入、实体、`extend`、`inherits`、`final`、`static`、`snapshot`、`scd`、`config`、
`type`、`field_mapping`、`self`、`@overload`、`@override`、
内置值与集合类型、Decodes 声明和代码值、注解、默认值、数值、字符串、转义和注释。
颜色由主题决定；高亮自身不承担类型校验。
LSP 将字典实例名和内置值类型统一归类为 `yamblValueType`，映射到
`support.type.yambl`；TextMate 也为字典声明与不带引号的 code 参数提供对应规则。
带引号的 code 参数使用普通字符串规则，LSP 不覆盖其颜色，无论字典是否已定义。

每次新增关键字、注解、内置类型或常量，必须同步修改编译器、LSP 词汇表及
`syntaxes/yambl.tmLanguage.json`，并加入测试。补全词汇表中的关键字会自动参与
TextMate 高亮检查。

## 测试

```powershell
.\tools\vscode\test.ps1
```

测试使用 VS Code 自带 TextMate、Oniguruma 和 Node，执行高亮、语言语义、
格式化、源码发现及真实 stdio 协议测试。无需 npm 安装。

开发时可使用 `node tools/vscode/lsp/tests/parity.cjs` 与同工作区 Python 编译器对照，
核对语法接受结果、诊断和格式化。此步骤使用编译器已有 venv，仅是开发测试依赖。

安装包的真实扩展宿主验证使用：

```powershell
.\tools\vscode\test-integration.ps1
```

该脚本在 `build/` 下建立隔离的 VS Code 配置、扩展目录和临时模型，测试打包
后的扩展，不修改当前编辑器配置。测试退出后保留日志用于诊断。

## 工作区设置

扩展通过后缀识别 `.yambl`。当前父工作区的 `.vscode/settings.json` 使用四空格
缩进，并将 `gokurakujoudo.yambl` 设为 YAMBL 默认格式化器。设置位于三个仓库
之外；单独打开其他模型仓库时，仍可使用本扩展提供的 Format Document。

Type definitions (`type ... = ...`), attrs/mapping key bindings, exact constraints,
and dependent `::type` / `::value` paths share the compiler syntax and diagnostics.
The packaged lang tree includes language-defined AttrCats, DecoratorTargets, decorator signatures and field_mapping.

## Decorators

The language service resolves `decorator @name(...)` declarations from the current
namespace, imports and bundled built-ins. It checks positional and named values,
caller-defined key/type pairs, defaults, repetition and captured `self` constraints.
Completion after `@` filters visible decorators by their declared `@targets` and
the following definition or attribute category. Before that definition is written,
it offers candidates for the kinds still possible at the current nesting level.
Value attributes use Static; extend bodies use entity attributes. Comments, strings,
dictionary entries and formal parameters do not offer decorator names. Missing or
invalid target contracts are omitted. Imports and unsaved scope changes are respected.
Decorators already used on the same object are omitted unless declared
`@allow_multiple`. Uses both before and after the cursor count; the invocation
whose name is being edited does not. Other fields and enclosing declarations do
not consume that object's decorator choices.
Inside a call, completion offers ordinary parameter names with `=`. Hovers show signatures, defaults, explicit `@targets` scopes and `@allow_multiple`.
Every decorator must declare `@targets`; diagnostics check its target kinds and
attribute categories from the language sources. Target codes, generated All/None
and named arguments complete and navigate to their definitions.
Decorator calls navigate to declarations and named arguments to formal parameters.
Override and overload calls retain their field-relationship navigation.
`::entity` selects a concrete field descriptor's declaring entity.

## Computation editing

Hovers retain entity and collection types for local bindings and lambda parameters.
Method hovers show the receiver, result type and operation contract. Completion on
`holdings.` offers sequence methods; completion on `h.` and reference paths offers
resolved fields. Field uses participate in definition navigation and reference search.

`::value(...)`, `::best_available(...)` and `::value(...)` provide named parameter
completion and signature help. The editor inserts `name=` and preserves snippets.
`input.` lists inferred and explicitly declared inputs, their types and defaults.
`@extra_input_params` supplies optional input declarations and descriptions; `??`
handles omitted inputs.
The formatter preserves multiline lambda bodies and chained recovery calls.

Typed locals (`let amount: decimal = 1.25`), contextual collection and structured
value literals, and `const NAME: Type = expression` use the same analysis for
diagnostics, hover, completion and navigation. Member suggestions follow the
receiver type for both `.` and `::`. Conversion functions offer parameter names,
signatures and documentation; `/` and `//` have separate numeric rules.
See the [language reference](../../docs/reference/README.md) and
[conversion functions](../../docs/reference/functions.md).
