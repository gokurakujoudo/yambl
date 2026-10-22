# VS Code 语法高亮

本目录提供 YAMBL 的本地 VS Code 扩展，使用
[TextMate 语法](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide)。
支持 `.yambl` 文件识别，以及命名空间和 `from ... import ...`、实体、字段、内置类型、集合泛型、`decodes`
声明和条目、`code<Currencies>`、`Currencies.CNY` 代码值、注解、数值、单引号字符串和 `#` 注释的
高亮，并提供括号配对和切换行注释。

高亮不执行语法或类型校验，也不实现格式化。注释空格的标准格式仍以
[语法说明](../../language/syntax.md)为准，切换注释不等于运行 YAMBL 格式化器。
字符串转义等尚待定义的语义不会由高亮规则确定。

## 安装

在 Windows PowerShell 或 PowerShell 中，从 `yambl` 仓库根目录运行：

```powershell
.\tools\vscode\install.ps1
```

脚本使用 .NET 打包，输出 `build/vscode/yambl-0.0.1.vsix`，然后通过
[VS Code 命令行](https://code.visualstudio.com/docs/configure/command-line)
安装到当前用户的默认扩展配置中。需要 `code` 命令可用，不需要 npm 依赖或
发布到 Marketplace。安装会使该用户的 VS Code 能识别 `.yambl` 文件。

如果 VS Code 已打开，安装后执行 `Developer: Reload Window`。打开 `.yambl`
文件后，状态栏语言模式应显示 `YAMBL`，颜色由当前主题决定。

只打包而不安装：

```powershell
.\tools\vscode\install.ps1 -PackageOnly
```

重复运行会重新生成本地 VSIX；安装时会更新同一个本地扩展。修改高亮规则后
重新运行安装脚本并重载窗口。

## 检查

```powershell
.\tools\vscode\test.ps1
```

检查使用当前安装的 VS Code 自带的 TextMate 和 Oniguruma，验证类型和泛型
高亮、正则表达式中的 `#`、行注释、转义引号及未闭合字符串后的高亮恢复。
测试依赖 VS Code 的安装目录布局；扩展运行本身不依赖此测试脚本。

## 工作区设置

扩展通过 `.yambl` 后缀自动识别语言。当前父工作区的 `.vscode/settings.json`
还明确设置了 `*.yambl` 到 `yambl` 的关联，并使用四个空格缩进。该配置位于
三个独立 Git 仓库之外，不随 `yambl` 仓库提交；高亮和语言关联由已安装扩展
提供，因此单独打开任一模型仓库也可识别 `.yambl`。
