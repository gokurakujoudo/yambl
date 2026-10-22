# VS Code 扩展

本扩展提供 YAMBL 语法高亮和自包含 [LSP](../lsp/README.md)。安装包使用
VS Code 自带的 Node 运行时，不需要另外安装 Python、Node、npm 依赖、其他扩展，
也不需要外部服务或联网下载组件。

## 安装与使用

从 `yambl` 仓库根目录运行：

```powershell
.\tools\vscode\install.ps1
```

脚本使用 .NET 生成 `build/vscode/yambl-0.1.0.vsix`，然后通过 `code` 命令
安装。也可以只打包，再通过 VS Code 的 “Install from VSIX” 安装到其他机器：

```powershell
.\tools\vscode\install.ps1 -PackageOnly
```

安装后执行 `Developer: Reload Window`，打开 `.yambl` 文件即可启动语言服务。
在 VS Code 中可以使用：

- Problems 面板中的实时语法、类型及引用诊断；未定义 Decodes 为 warning。
- Format Document 格式化当前文档；存在语法错误时不提供修改。
- 输入补全，包括关键字、注解、内置类型和当前文件可见的声明。
- 悬停查看元信息和内置语义，Go to Definition 跳转实体或字典定义。
- Outline 查看实体、字段和字典条目；扩展属性显示为 `Entity.field`。

语言服务读取未保存的编辑内容，并按最近的 `yambl-root.lclcfg` 查找同仓库文件；
没有根标记时只检查当前文件。根标记仅用于定位，不执行其配置。打开的不同仓库
分别解析，不合并同名类型。文件变化后自动更新诊断。

运行日志位于 Output → YAMBL。若语言服务异常退出，可重载窗口重新启动。
当前支持桌面扩展宿主的本地文件和未保存文档；不支持浏览器或虚拟文件系统。
首版不提供重命名、引用搜索或代码修复，详细边界见 LSP 文档。

## 高亮与语言规则同步

支持命名空间、导入、实体、`extend`、`inherits`、`snapshot`、`scd`、`config`、
内置值与集合类型、Decodes 声明和代码值、注解、默认值、数值、字符串、转义和注释。
颜色由主题决定；高亮自身不承担类型校验。

每次新增关键字、注解、内置类型或常量，必须同步修改编译器、LSP 词汇表及
`syntaxes/yambl.tmLanguage.json`，并加入测试。补全词汇表中的关键字会自动参与
TextMate 高亮检查。

## 测试

```powershell
.\tools\vscode\test.ps1
```

测试使用 VS Code 自带 TextMate、Oniguruma 和 Node，执行高亮、语言语义、
格式化、源码发现及真实 stdio 协议测试。无需 npm 安装。

开发时可使用 `node tools/lsp/tests/parity.cjs` 与同工作区 Python 编译器对照，
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
