# Codex 交接：Amazon 跨境电商上新与运营 Copilot

日期：2026-11-12。本包是规划与契约材料，不包含已实现的OpenDot业务代码或已测benchmark结果。

本次改为跨境电商场景；此前的国内竞品情报方案独立保留，本期不要求两套同时实施。

## 文件与阅读顺序

1. [ARCHITECTURE_ECOMMERCE_OPS.md](ARCHITECTURE_ECOMMERCE_OPS.md)：问题、JD映射、架构、设计取舍、数据源、SOP及展示。
2. [ISSUE_ECOMMERCE_OPS.md](ISSUE_ECOMMERCE_OPS.md)：做/不做、12项需求、业务规则、benchmark与验收等级。
3. [PLAN_ECOMMERCE_OPS.md](PLAN_ECOMMERCE_OPS.md)：T0–T11实施步骤、文件改动、接口、测试、验收与交接。
4. [contracts/task-result.schema.json](contracts/task-result.schema.json)：五类任务的统一草稿输出契约，JSON Schema 2020-12；不是Amazon上传schema。
5. [examples/structured-output.example.json](examples/structured-output.example.json)：已通过该schema的US Listing示例；所有产品规格/证据均为合成演示，未调用模型。

ZIP已按 `docs/ecommerce-ops/` 组织。解压到目标OpenDot仓库根目录后，先执行T0核验：没有源码时无法提前给出真实现有文件路径；Plan的逻辑路径必须据仓库落实，不能照着占位目录另造一套基础架构。

## 本期默认

- 中文运营界面；Amazon US/en-US/USD与DE/de-DE/EUR。
- 五类任务：候选资料比较、Listing、广告内容、广告只读报表诊断、多语言客服草稿。
- 一个共享产品事实/规则/证据/审核底座；导入优先，平台只读API后续接入。
- 人工审核导出；平台上架、改价、改广告、退款或发送客服消息不在本期范围。
- 先M1事实/RAG/Listing，再M2广告/客服，最后M3完整UI/审核/评测/部署。
- 工程验收、真实业务试运行、经营收益验证分级；各站点/模块分别记录，缺凭证/数据/人工复核不得假通过。

## 可直接发给Codex

> 阅读 `docs/ecommerce-ops/` 中的Architecture、Issue、Plan、schema及示例。先核验本仓库AGENTS与现有OpenDot，完成T0的真实路径/接口/命令绑定，再按里程碑实现。复用现有模型、权限、Goal、审批、调度、存储与界面。严格遵守不做范围，所有事实有证据、US/DE规格隔离、规则按适用期检索、广告由代码计算，审核绑定精确版本。没有模型/API/真实资料/部署凭证时完成可独立工作并明确阻塞。输出实际文件变更、测试、benchmark/成本/失败案例和逐模块A/B/C验收等级。

## 当前包的检查范围

已检查文档交叉引用、需求/任务/专项覆盖、JSON Schema合法性、示例有效性与若干非法输出拒绝行为。没有执行OpenDot代码测试、平台接入、真实模型评测或部署。Schema检查只能证明结构约束，不能证明文案事实、平台规则或业务效果。
