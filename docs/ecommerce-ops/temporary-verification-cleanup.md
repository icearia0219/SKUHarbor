# 临时验证目录清理记录

更新：2026-11-13。真实模型验证仅在私有临时工作区复制现有加密 Provider 配置及其密钥，未改写项目原 data、原配置或密钥。复制内容、密钥与 token 未写入 Git、fixture、聊天或日志。

当前不能宣称“正常退出的验证均已清理”：早期 01–03 的手动清理两次被自动审批拒绝，工具仅返回 `blocked by policy`，没有具体理由；之后没有绕过或再次尝试删除。04/05/07 的退出清理又遇到 Windows `EPERM`，凭据副本仍存在；具体失败步骤未被完整记录，不能断定根因。08 已完成第二轮验证并退出；cleanup.json 状态为 directory_cleanup_pending，claude-provider.json、claude-provider.key、broker-token.txt 三份副本仍在。

以下目录均由本次任务创建，位于私有 Windows 临时工作区，不是项目原 data。此记录只核对了 broker 连接元数据与文件存在状态，未读出凭据内容。用户可在确认对应验证进程已退出后手动清理：

| 验证轮次   | 临时目录                                                            | 当前状态                                                                                    |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 早期 01–03 | `C:/Users/17495/AppData/Local/Temp/opendot-ecommerce-model-xkK957/` | 凭据副本仍在；手动清理被自动审批拒绝                                                        |
| 早期 01–03 | `C:/Users/17495/AppData/Local/Temp/opendot-ecommerce-model-Sbu22t/` | 凭据副本仍在；手动清理被自动审批拒绝                                                        |
| 早期 01–03 | `C:/Users/17495/AppData/Local/Temp/opendot-ecommerce-model-PSY2RW/` | 凭据副本仍在；手动清理被自动审批拒绝                                                        |
| 04         | `C:/Users/17495/AppData/Local/Temp/opendot-ecommerce-model-GQEQ9R/` | 凭据副本仍在；退出清理遇 Windows EPERM                                                      |
| 05         | `C:/Users/17495/AppData/Local/Temp/opendot-ecommerce-model-yVl5XT/` | 凭据副本仍在；退出清理遇 Windows EPERM                                                      |
| 07         | `C:/Users/17495/AppData/Local/Temp/opendot-ecommerce-model-OLM3db/` | 凭据副本仍在；退出清理遇 Windows EPERM                                                      |
| 08         | `C:/Users/17495/AppData/Local/Temp/opendot-ecommerce-model-F6dUgv/` | 验证已退出；directory_cleanup_pending，三份凭据副本仍在，留待用户在确认进程已退出后手动处置 |

06 的 `opendot-ecommerce-model-PHwC96` 已核对没有凭据副本，不列为待清理。各轮可能的副本路径为目录内的 `data/config/claude-provider.json`、`data/config/claude-provider.key` 和 `broker-token.txt`，使用现有 Windows 私有数据 ACL；本记录只列路径，未包含内容。

未来 broker 改为通过 `scripts/ecommerce-broker-scratch.mjs` 对 Windows junction 使用非递归 rmdir，并记录清理错误 code。仅在新建、无密钥 dummy 目录中验证了临时目录移除、链接目标不变及范围外拒绝（[结果](../../artifacts/ecommerce-ops/broker-cleanup/result.json)）；dummy 的原 unlink 未重现 EPERM，因此这不证明真实 Provider 进程退出清理的根因已经解决。未再运行真实凭据 broker，也未将新 helper 用于任何旧副本；没有绕过拒绝。清理失败应保留明确状态，不能由“进程退出”推断文件已经删除。

不要删除或改写项目原配置目录 `D:/opendot/OpenDot-main-0689098/OpenDot/data/config/`。自动审批拒绝与 Windows 清理失败是当前交付的独立阻塞，保留上述列表供用户在进程退出后手动处置，无需重复确认请求。
