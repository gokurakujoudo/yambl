# 内置语言仓库

[yambl-root.lclcfg](yambl-root.lclcfg) 将 lang 定义为 prefix 为空的内置数据仓库。
可由语言表达的定义保存在 `.yambl` 文件，声明 namespace builtins。

- [models](models/README.md)：Decodes、Hierarchy、ConfigGroup 及结构化条目。
- [builtins](builtins/README.md)：AttrCats、field_mapping 和基础类型说明。
- [syntex](syntex/README.md)：词法、语法、类型表达式及仓库规则。

Python 包和 VSIX 按相对目录递归携带 `.yambl` 文件及根配置。只有随工具发布的
定义全局可见；普通仓库不能重声明内置名称。本地 builtins 新增名称仍按普通作用域解析。
基础标量、抽象 Entity 和类型运算符由实现提供，不能用当前声明语法自举。
