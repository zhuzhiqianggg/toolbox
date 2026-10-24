# 现有工具全量盘点与迁移清单

> 本文档把网页版（`../` 参考项目）**约 50 个工具**逐一列出，标注 **决策** 与 **旧项目源码位置**，供桌面版开发时按图索骥复用算法、避免遗漏或误迁移。
>
> 决策口径来自 `99-archive/PRD-v1.md` 第 4 章（工具取舍）；源码位置基于 `../ops-tools/src/components/tools/`。

---

## 决策图例

| 标记 | 含义 |
| --- | --- |
| 🟢 **P0** | MVP 必做（12 个核心工具 + 命令面板） |
| 🔵 **P1** | 重要，紧随 MVP |
| 🟡 **P2** | 降级，按反馈排期 |
| 🔴 **砍掉** | 不做（与运维/开发定位无关或已有更优替代） |
| ➕ **新增** | 桌面专属能力，网页版没有 |

---

## A. 文本与数据处理

| 工具 | 旧源码（`src/components/tools/`） | 决策 | 备注 |
| --- | --- | --- | --- |
| JSON 格式化器 | `text-processing/JsonFormatter.tsx` | 🟢 P0 | 全栈/后端最高频；本地格式化 + 错误行号 |
| 文本差异对比 | `text-processing/TextCompare.tsx` | 🟢 P0 | 用户点名；支持本地文件拖拽 |
| SQL 格式化器 | `text-processing/SqlFormatter.tsx` | 🔵 P1 | 后端高频，本地比在线更安全 |
| 正则测试器 | `text-processing/RegexTester.tsx` | 🔵 P1 | 结合剪贴板感知 + 大文本 |
| CSV ↔ JSON | `text-processing/CsvJsonConverter.tsx` | 🔵 P1 | 本地大文件转换优于上传 |
| YAML ↔ JSON | `text-processing/YamlJsonConverter.tsx` | 🔵 P1 | k8s/Docker/CI 配置刚需 |
| JSON → TypeScript | `text-processing/JsonToTypescript.tsx` | 🔵 P1 | 联调高频 |
| 数据脱敏 | `text-processing/DataMasker.tsx` | 🔵 P1 | 分享日志前脱敏 |
| 时区转换器 | `data-processing/TimezoneConverter.tsx` | 🔵 P1 | 跨时区排障 |
| XML ↔ JSON | `text-processing/XmlJsonConverter.tsx` | 🟡 P2 | 低频，企业遗留系统 |
| JSON Schema 生成器 | `text-processing/JsonSchemaGenerator.tsx` | 🟡 P2 | 偏专业、低频 |
| 文本统计 | `text-processing/TextStatistics.tsx` | 🟡 P2 | 编辑器自带 |
| 文本去重排序 | `text-processing/TextDeduplicator.tsx` | 🟡 P2 | `sort/uniq` 更顺手 |
| 大小写转换（12 种命名） | `text-processing/CaseConverter.tsx` | 🟡 P2 | 可并入「文本小工具集」 |
| 文本模板替换 | `text-processing/TemplateReplacer.tsx` | 🟡 P2 | 低频 |
| 日期计算器 | `text-processing/DateCalculator.tsx` | 🟡 P2 | 系统/搜索可替代 |
| 单位转换器 | `data-processing/UnitConverter.tsx` | 🔴 砍掉 | 与运维无关 |
| 科学计算器 | `text-processing/ScientificCalculator.tsx` | 🔴 砍掉 | 系统自带 |
| 简繁转换 | `text-processing/ChineseConverter.tsx` | 🔴 砍掉 | 与运维开发无关 |

## B. 编码与格式转换

| 工具 | 旧源码 | 决策 | 备注 |
| --- | --- | --- | --- |
| 时间戳转换器 | `data-processing/TimestampConverterNew.tsx` | 🟢 P0 | 用户点名；自动识别秒/毫秒 + 多时区 |
| Base64 编解码 | `encoding-decoding/Base64ConverterNew.tsx` | 🟢 P0 | 文本/图片/文件，桌面强项 |
| 进制转换 | `encoding-decoding/NumberBaseConverter.tsx` | 🔵 P1 | 调试内存/权限/协议 |
| 字符串转义（JS/HTML/Shell/SQL/正则） | `encoding-decoding/StringEscaper.tsx` | 🔵 P1 | 写脚本/排查转义 |
| URL 编解码 | `encoding-decoding/UrlConverter.tsx` | 🔵 P1 | 可并入「编码」组 |
| 文件编码检测 | `encoding-decoding/FileEncodingDetector.tsx` | 🔵 P1 | **桌面增益**：直读本地文件判 GBK/UTF-8 |
| HTML 实体编解码 | `encoding-decoding/HtmlEntityEncoder.tsx` | 🟡 P2 | 低频 |
| 图片转 Base64 | `encoding-decoding/ImageToBase64.tsx` | 🟡 P2 | 可并入 Base64 工具 |
| ASCII 码表 | `encoding-decoding/AsciiTable.tsx` | 🟡 P2 | 纯查询 |
| 文件大小转换 | `data-processing/FileSizeConverter.tsx` | 🔴 砍掉 | 无独立价值 |

## C. 加密与安全

| 工具 | 旧源码 | 决策 | 备注 |
| --- | --- | --- | --- |
| 密码生成器 | `encoding-decoding/PasswordGenerator.tsx` | 🟢 P0 | 用户点名；默认不写历史 |
| 哈希生成器（MD5/SHA） | `encoding-decoding/HashGenerator.tsx` | 🟢 P0 | **本地文件哈希**是核心桌面强项 |
| JWT 解码 | `encoding-decoding/JwtDecoder.tsx` | 🟢 P0 | 用户点名场景；离线解码，数据不出本机 |
| AES 加密解密 | `encoding-decoding/AesEncryption.tsx` | 🔵 P1 | 接口签名排查 |
| RSA 密钥对生成 | `encoding-decoding/RsaKeyGenerator.tsx` | 🔵 P1 | 密钥生成/加解密排查 |
| OTP / TOTP 动态验证码 | `security/OtpGenerator.tsx` | 🔵 P1 | 2FA 排查/演示 |
| Bcrypt 密码哈希 | `security/BcryptTool.tsx` | 🔵 P1 | 后端排查 |
| Sudoers 规则生成器 | `development/SudoersGenerator.tsx` | 🔵 P1 | Linux 运维易错项 |
| Basic Auth 生成器 | `security/BasicAuthGenerator.tsx` | 🟡 P2 | 一行命令可替代 |

## D. 网络与 API

| 工具 | 旧源码 | 决策 | 备注 |
| --- | --- | --- | --- |
| IP 地址规划（CIDR/子网） | `network/IpPlanner.tsx` | 🟢 P0 | 运维核心，离线计算 |
| **本地端口占用查询 + 结束进程** | — | ➕ P0 | 桌面独占能力 |
| 常用端口查询 | `network/CommonPortsLookup.tsx` | 🔵 P1 | 本地数据查表 |
| 带宽/传输时间计算器 | `data-processing/BandwidthCalculator.tsx` | 🔵 P1 | 机房/容量评估 |
| HTTP 状态码查询 | `network/HttpStatusCodes.tsx` | 🟡 P2 | 可并入命令速查 |
| MAC 地址厂商查询 | `network/MacAddressLookup.tsx` | 🟡 P2 | 需联网 OUI 库 |
| MIME 类型查询 | `network/MimeTypesLookup.tsx` | 🟡 P2 | 低频 |
| User-Agent 解析器 | `network/UserAgentParser.tsx` | 🟡 P2 | 偏前端 |

## E. 开发与运维

| 工具 | 旧源码 | 决策 | 备注 |
| --- | --- | --- | --- |
| Cron 预览模拟 | `development/CronPreviewSimulator.tsx` | 🟢 P0 | 运维极高易错，需实时预览 |
| Docker run ↔ Compose | `development/DockerRunToCompose.tsx` | 🟢 P0 | 容器化刚需 |
| Shell 命令速查 | `development/ShellCommandsReference.tsx` | 🔵 P1 | 离线手册 |
| Git 命令速查 | `development/GitCommandsReference.tsx` | 🔵 P1 | 并入「命令速查」 |
| Kubectl 命令速查 | `development/KubectlCommandsReference.tsx` | 🔵 P1 | k8s 运维 |
| Nginx 配置生成器 | `development/NginxConfigGenerator.tsx` | 🔵 P1 | 易错，生成器增益明显 |
| Systemd Unit 生成器 | `development/SystemdUnitGenerator.tsx` | 🔵 P1 | Linux 运维易错 |
| SSH 配置生成器 | `development/SshConfigGenerator.tsx` | 🔵 P1 | 运维常用 |
| Rsync 命令生成器 | `development/RsyncCommandGenerator.tsx` | 🔵 P1 | 参数繁杂 |
| 数据库连接串生成器 | `development/DatabaseConnectionString.tsx` | 🔵 P1 | 联调/配环境 |
| HTTP 请求代码生成器 | `development/RequestCodeGenerator.tsx` | 🔵 P1 | curl/Python/Node/Axios |
| UUID 生成器 | `encoding-decoding/UuidGenerator.tsx` | 🔵 P1 | 开发高频 |
| API 测试器 | `development/ApiTesterNew.tsx` | 🟡 P2 | Postman/IDE 已很强 |
| 随机数据生成（Mock） | `development/RandomDataGenerator.tsx` | 🟡 P2 | 测试用 |
| Linux 信号查询 | `development/LinuxSignalsReference.tsx` | 🟡 P2 | 并入命令速查 |
| 退出码查询 | `development/ExitCodesReference.tsx` | 🟡 P2 | 并入命令速查 |
| 机房电力计算器 | `development/DataCenterPowerCalculator.tsx` | 🟡 P2 | 偏 IDC 专业岗 |
| 容量规划计算器 | `development/CapacityPlanner.tsx` | 🟡 P2 | 并入带宽计算 |
| 时区批量校验 | `development/TimezoneBatchChecker.tsx` | 🔴 砍掉 | 并入时区转换即可 |
| 工作日计算器 | `development/WorkdayCalculator.tsx` | 🔴 砍掉 | 非运维核心 |
| 数据中心功率 | `development/DataCenterPowerCalculator.tsx` | 🔴 砍掉 | 与电力计算重复 |
| Slug 生成器 | `development/SlugGenerator.tsx` | 🔴 砍掉 | 前端/SEO 用 |

## F. 媒体与设计

| 工具 | 旧源码 | 决策 | 备注 |
| --- | --- | --- | --- |
| 二维码生成与解析 | `media/QrCodeGenerator.tsx` | 🔵 P1 | 传配置到手机；可解析本地图片 |
| 图片压缩器 | `media/ImageCompressor.tsx` | 🔵 P1 | **桌面增益**：本地批量压缩 |
| 颜色选择器 | `media/ColorPicker.tsx` | 🟡 P2 | 偏设计/前端 |

---

## G. ➕ 桌面专属新增能力（网页版做不到）

| 能力 | 决策 | 说明 |
| --- | --- | --- |
| 本地端口占用查询 + 结束进程 | 🟢 P0 | 输入端口 → PID/进程/路径 → 一键 Kill |
| 本地文件哈希（拖拽） | 🟢 P0 | 拖文件算 MD5/SHA1/SHA256（流式） |
| 进程 / CPU / 内存快查 | 🔵 P1 | 排序查看、结束进程 |
| 剪贴板历史 | 🔵 P1 | 记录/搜索/置顶/清空 |
| 剪贴板智能识别 | 🔵 P1 | 识别 JSON/JWT/时间戳/Base64/URL 并推荐工具 |
| hosts 文件快速编辑 | 🔵 P1 | 含自动备份 + 提权提示 |
| 编码/换行符批量转换 | 🔵 P1 | GBK↔UTF-8、CRLF↔LF |
| 批量重命名 | 🔵 P1 | 正则/序号/大小写 + 预览 |
| 系统环境变量查看 | 🔵 P1 | 查看/搜索 PATH 等 |
| 网络连通性一键诊断 | 🔵 P1 | ping/端口/DNS/路由 汇总 |
| 本机/公网 IP 速查 | 🔵 P1 | 内网 IP、网关 |
| Windows 服务/计划任务查看 | 🟡 P2 | Windows 运维 |
| 屏幕取色器 | 🟡 P2 | 取屏幕任意像素颜色 |
| 资源管理器右键菜单集成 | 🟡 P2 | 「用工具箱打开/算哈希」 |

---

## 量化结论

| 决策 | 数量 |
| --- | --- |
| 🟢 保留 P0 | 约 12 项 |
| 🔵 保留 P1 | 约 20 项 |
| 🟡 降级 P2 | 约 20 项 |
| 🔴 直接砍掉 | 8 项 |
| ➕ 桌面新增 | 14 项 |

> **MVP 聚焦 = 命令面板入口 + 12 个 P0 工具 + 一键复制 + 历史/收藏 + 离线可用 + 浅色扁平 UI。**
