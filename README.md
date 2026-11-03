# GitHub 项目与 Skill 动态日榜

中文用途总结：仅对两榜去重后的最多30个项目读取仓库简介与README，生成“能做什么、适合什么场景”两句中文；不再调用Google逐句翻译。每次工作流最多一个有界模型请求（60秒、最多5000输出token），不配置隐式模型降级或自动重试。使用明确配置的OpenAI Responses兼容端点（加密Secret `SUMMARY_API_KEY`，变量 `SUMMARY_BASE_URL`/`SUMMARY_MODEL`）；只有管理员明确授权才配置密钥，不写入公开代码/元数据。未配置时仅复用有效缓存，缺失说明记录失败并显示待补。GitHub Models实测未返回推理结果，当前不作为自动回退。模型不可用时不把旧机译冒充新总结。

`summary-cache.json`按仓库、提示版本、模型、实际发送的简介/README摘录及README SHA/URL固定缓存；相同资料复用，不同资料重新生成。仅传公开仓库文字，不传软件项目内容或个人资料。模型输出仍须核查，来源和生成时间随日报保存，不等于功能试用。桌面获取日报不调用模型。

当前日无上榜项目时，`summary-backfill.mjs`可为最近七份归档中最近的有内容日报补齐说明；已生成日期与计数不变，有失败则保留原归档。模型和来源相同的缓存会复用。

电脑不用常开，桌面点击读取成品日报，不调用用户模型进行检索。每次从 Trending 和 GitHub 搜索重新发现候选，**本轮候选全部计数后排名**，两榜各最多15条，不足不凑数，不承诺全站排名。

## 默认采集

Node 22+，无npm依赖：

    node --test collector.test.mjs dynamic.test.mjs
    node dynamic.mjs --output data

由独立公开数据仓库的GitHub Actions运行，使用其GITHUB_TOKEN提供通用API额度及写数据，每天北京时间约20:07主采集、21:17补采，避开整点高负载。计划事件如发现当日20:00后已有成功报告则跳过，手动触发仍可执行。GitHub调度可能延迟或漏触发，不保证整点；定时路径须实际event=schedule回执验证，手动成功不等于定时成功。桌面21:30后仍无最近一期晚间文件会显示缺更，跨午夜仍核对前一晚；归档查询不应用该警告。公开历史接口无需个人token。不要发布正式AI开发助手源码或项目资料。复制collector.mjs/test、dynamic.mjs/test及工作流模板到独立数据仓库；当前部署Tang-dx/skill-rankings。

## 发现和指标

- 来源：GitHub当日Trending全局及TypeScript页的全部结果，4组Skill/近期项目搜索各前30条。来源必须成功且搜索未报告incomplete_results；全去重候选均采集（最多200，超过不截断发布）。3个工作器，总600请求/240秒。
- 每次当前仓库身份/公开状态核验；仅上榜项目补查文件树。普通项目也允许，未核实Skill入口则明确标注；文件存在不证明质量或使用。
- GitHub自2026年7月限制查看他人星标明细。采用官方公开stargazers/history?per_page=2，一次读取至多两周每日计数，验证7天非负整数与周总和，选择最近一个已结束的来源统计日。跨周按相差恰好七天的时间戳匹配，缺周则失败，不把更早数据当昨日。
- 统计日边界由GitHub定义、不保证UTC或北京时间自然日；不是滚动24小时或净增，也不使用Trending的stars today。计数反映指定日期创建且采集时仍存在的星标，取消星标可能修订历史。日窗口结束不保证上游已刷新完毕，接口未提供最后更新时间，不承诺零延迟或数值永久不变。见[官方接口说明](https://docs.github.com/en/rest/activity/starring#get-repository-star-history)。
- 第一榜按新增数；新锐要求创建183天内、当前<10000星、新增>=30，按新增/max(当前总星数,100)排序，显示新增占比，不能称期初增长率。创建只用于筛选，不当上线日期。
- 六个既定来源失败、任一合格候选日计数失败或超预算，则整批失败，最新及日期日报保持原样；明确私有/归档项目记录原因后排除。不能把部分采集称完整日榜。
- collector_revision=3采用上一完整来源统计日；旧revision=2保留当日口径，按版本复核，不重写历史指标。coverage.sources保存候选名称，observations保存全部成功候选计数；star_evidence含官方URL、请求时间和原始周/日数组。由原始days与week复算，不使用Trending的stars today混算。

## 中文与上线

上榜去重条目均读取简介及README开头段落，保留文件SHA与来源。中文总结由上方有界的Responses任务生成，失败显示中文待补，不回退旧机译或英文。桌面已有人工中文整理仍可作为历史兜底，但新云端摘要优先；不代表试用结论。经管理员授权的模型连接仅在云端调用；桌面读取成品，不上传本地项目内容。该连接会使用对应接口额度。

明确绑定项目来源的official_launch才显示首次上线及已上线天数；release_record只显示完整分页后的最早可查版本，保留上线待核实。历史日报按其generated_at算天数。

## 文件与兼容

- data/rankings.json：最新日报，metric=github_reported_daily_new_stars；每行new_stars_day和来源日窗口，未伪装为24小时新增。
- data/daily/YYYY-MM-DD.json：按北京时间日期长期归档，同日更新较新成功批次，其他日期保留。
- data/batches/YYYY-MM-DD/时间戳.json：保留每个成功发布批次；同日报被更新前保存旧文件。日期索引仍指向当天较新批次，批次时间戳相同不覆盖；上线前未曾保存的中间批次不补造。
- data/discovery-cache.json：中文及上线元数据缓存，上限200、35天未使用过期；**不是监控池，不限制谁入榜**。
- data/state.json及collector.mjs：旧净增采集历史与兼容测试/helper，不再作为默认定期采集机制。

桌面固定官方GitHub contents API，仅读缓存进入，点击才联网；选日期查历史，每日独立缓存，失败不替换为其他日期，最新超过36小时标旧。旧metric=net_star_change_between_observed_snapshots的日报保留快照净增说明，不与新版新增星标横比。旧日期缺失不重建。原正式软件源码未公开。
