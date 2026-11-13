# 客服输入与人工处理

`support.us.synthetic.json`、`support.de.synthetic.json` 是合成测试输入，不是真实订单、政策、执行回执或已验证的自然语言结果。模型调用由现有OpenDot统一入口执行，不使用这些样例冒充正式生成。

服务端先验证 ticket、order、policy 全属当前 workspace，再调用 `prepareSupportContext`。只有返回的 `model_context` 进入模型：个人字段、邮箱、电话、地址、订单号先脱敏；工单命令仅作为不可信正文；不注入发送/退款/补发工具。姓名或地址若无法从正文可靠识别，应在导入时填写 ticket.pii 对应字段或人工脱敏；自动规则不能证明任意文本完全无PII。

订单状态分别为 requested、pending、accepted、completed。完成仅在服务器提供verified执行回执、证据引用及不晚于as_of的完成时间后成立；不能信任客户自述或模型生成的receipt。快照有observed_at/valid_until且归属已核实；政策需本站点、已审核、有效期和known_at均适用。过期/缺证据要求补料；订单归属不明、政策不可用或人身/电器危险转人工。

生成遵循共享support_draft契约：目标语言回复、intent、action、订单证据引用、中文内部说明。`validateSupportDraft`检查已知的英/德/中文执行断言、PII模式和原个人字段指纹、工单/证据关联及强制分支。它是确定性的防线，不是任意自然语言的事实证明；仍需共享claim-evidence质检与人工审核。没有执行回执不写已退款/已补发，不保证到账或到货日期。

页面及导出应显著标明“客服草稿，需人工审核和发送”；这套接口不会发送消息或执行退款，也不会因为Goal完成改变审核状态。
