# 从零开始使用 YAMBL

本教程建立一个商品模型：每件商品有编号、名称、状态、单价和数量，金额由单价与数量计算。
实体表示有身份的对象；属性描述对象的数据；字典列出某个字段允许使用的代码。

## 1. 准备编译器

安装 Python 3.14 或更新版本及 Git。克隆并安装编译器：

```powershell
git clone https://github.com/gokurakujoudo/yambl-compiler.git
cd yambl-compiler
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
```

以下命令均在激活的环境中运行。macOS 或 Linux 使用
`source .venv/bin/activate` 激活环境。安装依赖需要网络或预先准备的软件包。

## 2. 创建模型仓库

回到克隆目录的父目录，创建本教程的工作目录和 `model` 文件夹：

```powershell
cd ..
mkdir yambl-demo
cd yambl-demo
mkdir model
```

以下步骤都在 `yambl-demo` 中执行。`model` 目录中放置两个 UTF-8 文件：

```text
model/
  yambl-root.lclcfg
  inventory.yambl
```

文件使用 UTF-8、LF 换行。`model/yambl-root.lclcfg` 的内容是：

```text
prefix: 'example'
```

根配置标识模型仓库；`example` 成为仓库内声明完整名称的前缀。打开
`model/inventory.yambl`，输入以下完整内容：

```yambl
namespace inventory

decodes ProductStates {
    - 100 Active: 'Active'
    - 200 Inactive: 'Inactive'
}

entity Product {
    id product_id: string
    static attr name: string
    static attr product_state: code<ProductStates>
    static attr unit_price: decimal[18, 2]
    static attr quantity: integer

    lookup by_name {
        name = self.name::value()
    }

    computed attr total: decimal {
        return self.unit_price::value() * self.quantity::value()
    }
}
```

实体完整名称是 `example.inventory.Product`。`product_id` 是身份；`product_state` 只能使用
`ProductStates` 字典中的代码。`decimal[18, 2]` 描述十进制精度和小数位数。
计算属性 `total` 不存储额外的列，读取时从当前商品的单价和数量计算；
`::value()` 是读取字段值的操作。这里定义的是数据结构，尚未创建商品数据。

需要只作为继承基类的实体时，可使用 `abstract entity`；抽象计算属性由具体子类
实现。字符串格式也可以通过 `${类型名}` 组合已有约束。规则和示例见
[计算字段](../reference/computations.md)与[内置值类型](../reference/value-types.md#string)。

## 3. 检查和格式化

在 `model` 的父目录运行：

```powershell
yambl check -o path ./model
yambl format -o path ./model -o check
```

两个命令成功时退出状态为 0。检查会发现未定义名称、类型错误和其他模型约束错误；
格式检查只报告格式差异。如果第二条命令提示格式不符，可以运行
`yambl format -o path ./model` 写入格式化结果，再重新检查。格式化处理所选路径，
检查则会根据根配置检查整个模型仓库。

例如将 `code<ProductStates>` 改成 `code<UnknownStates>`，检查器会指出字典未定义。
把名称改回后重新运行检查。

## 4. 编译并生成数据包

仍在 `model` 的父目录运行：

```powershell
yambl compile -o path ./model -o output ./model.yambl-ir.json
yambl generate -o path ./model.yambl-ir.json -o output ./generated -o package example_model
```

第一条命令输出独立 JSON 中间模型。第二条命令在新的或空的 `generated` 目录中生成
Python 包、SQLite 结构、文件后端模板及接口参考。它检查目标后端是否支持模型使用的
类型；检查通过不代表所有语言类型都能存储。修改模型后应重新编译和生成，生成器不会
迁移已有数据。

安装生成包及其运行依赖：

```powershell
python -m pip install ./generated
```

## 5. 创建数据仓库

在当前目录创建 `repository.lclcfg`：

```text
backend: 'sqlite'
path: './example.sqlite'
```

运行以下命令创建新仓库并验证其数据：

```powershell
python -m example_model create -o config repository.lclcfg
python -m example_model check-data -o config repository.lclcfg
```

创建只接受不存在的目标；重复执行时请先选择新的路径。

## 6. 插入商品

在 `yambl-demo` 中创建 `initial.yaplan`：

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

应用 Plan，再检查仓库：

```powershell
python -m example_model apply -o config repository.lclcfg -o source initial.yaplan
python -m example_model check-data -o config repository.lclcfg
```

商品 `P1` 的单价是 12.50，数量是 3。应用成功后输出的事务文件路径可用于回滚；
再次应用同一 Plan 会因 ID 已存在而失败。

## 7. 读取计算结果

在 `yambl-demo` 中创建 `read_product.py`：

```python
import asyncio
import sys
from pathlib import Path

from example_model import ExampleData, Success


async def main():
    config = Path(sys.argv[1])
    with await ExampleData.open(config) as data:
        with data.read() as reader:
            product = reader.get_product('P1')
            if not isinstance(product, Success):
                raise RuntimeError(f'读取商品失败：{product}')
            total = product.value.read_total()
            if not isinstance(total, Success):
                raise RuntimeError(f'计算金额失败：{total}')
            print(f'商品金额：{total.value:.2f}')


asyncio.run(main())
```

运行 `python read_product.py repository.lclcfg`，按两位小数格式化后输出 `商品金额：37.50`。
`get_product` 和 `read_total` 返回结果对象，正常结果的 `value` 分别为商品句柄和
十进制计算结果；非正常结果需要单独处理。`with` 在使用后关闭读取会话和数据接口。

## 8. 批量匹配商品

模型中的 `by_name` 将商品名称作为外部输入键。准备一次匹配器后，可以重复处理批次。
在 `yambl-demo` 中创建 `match_product.py`：

```python
import asyncio
import sys
from pathlib import Path

from example_model import ExampleData, ProductByNameKey, Success


async def main():
    config = Path(sys.argv[1])
    with await ExampleData.open(config) as data:
        with data.read() as reader:
            prepared = reader.prepare_product_by_name()
            if not isinstance(prepared, Success):
                raise RuntimeError(f'准备匹配器失败：{prepared.message}')
        batch = prepared.value.match_many([ProductByNameKey(name='Notebook')])
        if not isinstance(batch, Success):
            raise RuntimeError(f'匹配批次失败：{batch.message}')
        result = batch.value[0]
        if not isinstance(result, Success):
            raise RuntimeError(f'商品未唯一匹配：{result}')
        print(f'商品编号：{result.value}')


asyncio.run(main())
```

运行 `python match_product.py repository.lclcfg`，输出 `商品编号：P1`。匹配器在读取会话
关闭后仍可使用。未命中、歧义及批次输入错误的处理见[具名批量匹配](../reference/lookup.md)。

## 9. 使用文件后端

同一个生成包也可以使用文件后端。在 `yambl-demo` 中创建 `files.lclcfg`：

```text
backend: 'files'
path: './example-files'
```

用相同的 Plan 创建、填充并读取另一份仓库：

```powershell
python -m example_model create -o config files.lclcfg
python -m example_model apply -o config files.lclcfg -o source initial.yaplan
python -m example_model check-data -o config files.lclcfg
python read_product.py files.lclcfg
python match_product.py files.lclcfg
```

输出同样包含 `商品金额：37.50`。两个配置指向各自的数据仓库；文件后端的路径必须是
不存在的新目录。Plan 格式和回滚操作见[事务和数据](../reference/transactions.md)。

## 限制字段取值

如果字段只允许几个编译期值，可以声明有限值类型：

```yambl
const NORMAL: integer = 2
type priority = one_of[1, NORMAL, 3]
entity Task {
    id task_id: string
    attr priority: priority
    attr fixed_priority: exact<NORMAL>
}
```

插入或更新 `priority` 时只能使用 1、2 或 3；`fixed_priority` 只能使用 2。
`one_of` 的候选顺序不影响允许值。更多规则和继承示例见
[类型表达式](../reference/type-expressions.md)。

## 接下来

从[语法总览](../reference/syntax.md)了解更多声明形式；
用[命名空间与导入](../reference/namespaces.md)将模型拆成多个文件；
用[实体关系与反向引用](../reference/relationships.md)描述引用基数和只读反向访问；
在[存储参考](../reference/storage.md)核对生成器和读取接口的支持范围。
