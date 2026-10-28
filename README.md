# YAMBL

YAMBL（Yet Another Model-Based Language）用于描述实体、属性、类型、字典与计算规则。
[YAMBL 编译器](https://github.com/gokurakujoudo/yambl-compiler)可检查、格式化模型，
编译中间模型并生成数据访问包。

## 快速开始

安装 Python 3.14 或更新版本和 Git，在 PowerShell 中运行：

```powershell
git clone https://github.com/gokurakujoudo/yambl-compiler.git
cd yambl-compiler
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
```

在一个新工作目录创建 `model` 目录和两个 UTF-8 文件。`model/yambl-root.lclcfg`：

```text
prefix: 'example'
```

`model/items.yambl`：

```yambl
namespace inventory

entity Item {
    id item_id: string
    static attr name: string
}
```

实体 `Item` 用 `item_id` 标识，每个实例可以有一个名称。在 `model` 的父目录运行：

```powershell
yambl check -o path ./model
yambl format -o path ./model
yambl format -o path ./model -o check
```

第一条命令检查整个模型仓库；第二条格式化所选目录；第三条确认文件符合格式要求。
格式化使用 LF 和四空格缩进。

## 文档

- [从零开始](docs/tutorial/getting-started.md)：安装工具、编写模型、检查并生成数据包。
- [中文参考](docs/reference/README.md)：语言规则、计算、事务和存储能力。
- [VS Code 扩展](tools/vscode/README.md)：语法高亮、补全、诊断和导航。
- [内置模型](lang/README.md)：随工具分发的定义和模型源码。
