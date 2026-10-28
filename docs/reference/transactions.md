# 事务和数据

生成的数据包提供 SQLite 和文件两种后端。配置文件指定 `backend: 'sqlite'` 或
`backend: 'files'` 及 `path`；相对路径以配置文件所在目录为基准。创建操作要求目标
不存在。生成包也提供读取接口和命令行入口，具体名称与模型包有关。

## Plan：描述数据修改

`.yaplan` 文件有名称、版本和一个或多个具名 group。每个操作针对完整实体名称，
字段和值按列对应；每条记录占一行。下面的 Plan 对应[入门教程](../tutorial/getting-started.md)的模型：

```text
plan initial_products {
    version 1
    group products {
        insert example.inventory.Product (product_id, name, product_state, unit_price, quantity) {
            'P1', 'Notebook', 'Active', 12.50, 3
        }
    }
}
```

如果已完成入门教程，这个 Plan 已经应用，无需再次运行。否则将其保存为
`initial.yaplan`，然后对已创建且尚未写入 `P1` 的仓库运行：

```powershell
python -m example_model apply -o config repository.lclcfg -o source initial.yaplan
python -m example_model check-data -o config repository.lclcfg
```

Plan 可选择写入 `model '摘要'`：若提供，摘要必须与当前模型匹配；省略时使用执行
所选的数据包模型。生成包的 `MODEL_DIGEST` 可用于取得实际摘要。相同 ID 不能重复插入。

操作按书写顺序执行：`insert` 创建实体，`update` 修改无时间、无维度字段，`delete`
删除实体；`replace Entity.field scope (...) columns (...)` 替换字段范围内的完整数据，
`delete Entity.field scope (...)` 删除字段范围。字段范围必须以等值条件指定所属实体 ID；
时间和维度条件可省略，省略表示包含该坐标的全部值。SCD 区间使用左闭右开
`[start, end)`，部分范围替换会保留区间之外的片段。

`expect one` 要求操作前匹配一条记录，`expect any` 要求至少一条；不写则允许零条。
集合视为一条字段记录，不按成员数计数。删除带有自有数据的实体时，需要显式使用
`owned_data delete_all`。Plan 内同一实体的同一逻辑属性只能修改一次；可以先按 ID 插入，
再写入其时态字段或按 ID 检查该实体。不支持依靠前序修改后按非 ID 条件查找并修改。

## 扩展字典

普通模型字典可以在数据仓库中增加 code。完整替换 entries 时，模型声明的每个条目必须
原样保留 code、decode 和 ordering；运行时新增条目可以修改或删除。字典本身不能删除。
flags 字典和自动子类型字典是只读的。新增 code 不会成为 YAMBL 源码中的静态成员。

Plan 按顺序追踪字典内容，可以先扩充字典，再在后续操作中使用新增 code。仅根据模型
执行的 `validate_plan_syntax` 无法知道仓库已有的运行时条目；当 Plan 已完整替换某字典
后，它能检查后续引用是否在该替换结果中。`validate_plan_expectations` 使用当前仓库快照
检查前置条件并追踪同一 Plan 内的变化；`apply` 在提交前检查最终候选数据。

删除或改名运行时新增 code 时，如果最终数据仍在任何字段、维度或配置映射中引用它，
提交会失败。回滚也遵守这个规则。读取会话固定一个快照：扩充提交后，新会话能看到
新成员，已经打开的会话继续使用旧快照。

## 事务、回滚和校验

应用成功产生 `.yatran` 事务记录，保存修改前后内容和执行结果。使用生成包的
`rollback` 命令或数据接口可回滚整个事务或指定 group。若后续写入与回滚内容冲突，
结果会报告 `conflicts`，并提交可回滚的部分；不要将其当成全部成功。若状态为
`export_pending`，数据已提交但事务文件尚待恢复，重新打开仓库执行恢复。

Plan 语法校验不写数据；前置条件校验读取快照但不构造完整候选。应用和回滚检查改动
及受影响关系，假设未修改的数据原本有效。`check-data` 或 `reader.validate()` 扫描完整
仓库，检查记录结构、集合归属、时间区间、配置、字典和同字段引用环。它们不执行模型
以外的业务完整性规则。

读取接口的每个会话使用固定快照，关闭后已有缓存可继续访问，未缓存的数据需要新会话。
一次只允许一个进程写入或恢复同一仓库，由调用方保证；读写 API 不提供跨进程写锁。
更多范围、字面量和事务记录细节见[事务格式参考](transactions-format.md)。
