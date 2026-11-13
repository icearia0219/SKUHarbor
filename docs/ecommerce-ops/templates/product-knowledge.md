# 产品事实与政策导入模板

`product-facts.csv` 与 `product-facts.de.csv` 是完全虚构的两款产品，不能当用户产品或 Amazon 规则。US 为 120 V / 1500 W；DE 为独立 SKU 的 230 V / 2000 W。分别导入对应市场，不能只改语言后共用规格。

填写对应 metadata 的 `owner_scope` 为当前已授权工作区，按实际来源填写 provenance、rights_note、observed_at。线上正常导入省略 `known_at`，由服务端记录实际入库时间；历史回放数据必须另行审核其 known 时间依据。`product_refs` 可先为空，再通过 SKU 将返回的候选关联产品；有绑定时每个引用使用准确 product_id / sku / revision / market。

CSV 的 `value_type` 支持 number、boolean、string；列名不同时指定 mapping 的 sku/field/value/unit。JSON 可用相同字段的行数组。空值必须在 JSON 中明确写 null。导入返回逐行错误，修正资料后使用新的 requestKey；相同 requestKey 必须对应完全相同资料。导入不等于事实确认，须人工记录理由并对准确产品 revision 执行 confirm/reject。

TXT、Markdown、文本 PDF 和 DOCX 保留完整原文及抽取全文，超过上限明确失败，不截断成可用知识。PDF 依赖可用的 pdftotext；扫描件需另行提供 OCR 文本。DOCX 用有界 ZIP/XML 解析，不执行文档中的实体或指令。XLSX 仅作为 report 原文保存，由报表模块校验和解析，不加入产品知识全文。

`policy.metadata.json` 分为原文 metadata 和知识 metadata。保留真实 source_url、版本、适用商品类型/卖家/站点及生效区间。未知有效期的政策保持 null、pending，检索会给出 applicability_unknown，不自动适用。authority 由审核人员按实际来源设置，模板默认 merchant，不能把经验或竞品转成官方政策。

同一政策主题沿用 policy_id，修订时带 expectedRevision。多个同权威且有效期重叠的文档会返回冲突，不按关键词高低任选。每条知识证据包含原文版本、字符区间、源 hash；原文及导出均经已授权接口读取。
