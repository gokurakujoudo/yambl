# 内置数据模型仓库

本目录由 `yambl-root.lclcfg` 定义为内置仓库，prefix 为空，文件声明 `namespace builtins`。
模型声明对所有用户仓库可见，无需导入。说明与定义保存在同一个文件中：

- [Decodes](decodes.yambl)：字典实体及 decodes_entry 值条目。
- [ConfigGroup](config_group.yambl)：实体类型、static 条件与 config 字段映射。
- [Hierarchy](hierarchy.yambl)：维度候选及升序取数优先级。

本目录是模型定义来源。Python 编译器同步这些文件为包资源；VSIX 打包直接包含本目录。
修改后运行编译器仓库的 `tools/sync-models.ps1`，并执行内置模型一致性测试与跨实现校验。
仓库识别和前缀规则见[命名空间](../language/namespaces.md)。
