# 计算内置函数

这些函数用于计算体与编译期 const，不读取实例，不依赖当前区域或系统时区。
普通调用按位置或名称赋值，位置参数须在命名参数之前。所有列出的参数必填。
运行时转换失败返回 ERROR；const 求值失败阻止编译。函数不隐式恢复非正常结果。

| 签名 | 返回类型 | 接受范围 |
| --- | --- | --- |
| `to_string(value)` | string | string、bool、integer、decimal、float、date、datetime、实体引用 ID |
| `to_integer(value)` | integer | 数字或数值字符串，必须精确为整数 |
| `to_decimal(value)` | decimal | 数字或数值字符串，必须有限 |
| `to_float(value)` | float | 数字或数值字符串，必须能被有限 float 精确表示 |
| `parse_date(text: string)` | date | 严格 `YYYY-MM-DD`，日期必须有效 |
| `format_date(value: date)` | string | ISO `YYYY-MM-DD` |
| `parse_datetime(text: string)` | datetime | ISO 日期时间，包含秒与明确的 Z 或 `±HH:MM` 时区 |
| `format_datetime(value: datetime)` | string | UTC ISO 日期时间 |
| `truncate(value, scale: integer)` | decimal | 数字，向零截断 |
| `round(value, scale: integer, mode: string)` | decimal | 数字，使用明确舍入模式 |

数值转换不接受 bool。数值字符串不接受空白、NaN、Infinity、下划线或区域化分隔符。
to_decimal(float) 保留二进制浮点的实际值；例如 float 0.1 转换后不等于 decimal 0.1。
to_float(0.1) 因精度损失失败，而 `1 / 10` 明确选择近似 float 计算。
to_integer 不截断小数，调用者应先使用 truncate 或 round。

scale 可为负数：scale=2 表示小数点后两位，scale=-2 表示百位。
round 的 mode 必须显式指定：

| mode | 规则 |
| --- | --- |
| `'half_even'` | 最近值，中点取偶数 |
| `'half_up'` | 最近值，中点远离零 |
| `'floor'` | 向负无穷 |
| `'ceil'` | 向正无穷 |
| `'toward_zero'` | 向零 |

```yambl
const RATIO: float = 1 / 3
const QUOTIENT: integer = -7 // 3
const TRUNCATED: decimal = truncate(-1.239, scale=2)
const ROUNDED: decimal = round(1.25, scale=1, mode='half_even')
const DAY: date = parse_date('2026-01-01')
const INSTANT: datetime = parse_datetime('2026-01-01T08:00:00+08:00')
const LABEL: string = format_date(DAY)
```

这些常量分别得到近似 1/3、-3、-1.23、1.2、指定日期、UTC 零点和日期文本。
datetime 小数秒最多六位；省略时区时报错。日期格式暂不接受自定义模板。
集合、mapping 和结构值没有通用字符串序列化转换。
