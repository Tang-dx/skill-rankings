# GitHub 项目与 Skill 动态日榜

电脑不用常开，桌面点击读取成品日报，不调用用户模型进行检索。每次从 Trending 和 GitHub 搜索重新发现候选，**本轮候选全部计数后排名**，两榜各最多15条，不足不凑数，不承诺全站排名。

## 默认采集

Node 22+，无npm依赖：

    node --test collector.test.mjs dynamic.test.mjs
    node dynamic.mjs --output data

由独立公开数据仓库的GitHub Actions运行，使用其GITHUB_TOKEN提供通用API额度及写数据，每天北京时间约20:00，调度可能延迟。公开历史接口无需个人token。不要发布正式AI开发助手源码或项目资料。复制collector.mjs/test、dynamic.mjs/test及工作流模板到独立数据仓库；当前部署Tang-dx/skill-rankings。

## 发现和指标

- 来源：GitHub当日Trending全局及TypeScript页的全部结果，4组Skill/近期项目搜索各前30条。来源必须成功且搜索未报告incomplete_results；全去重候选均采集（最多200，超过不截断发布）。3个工作器，总600请求/240秒。
- 每次当前仓库身份/公开状态核验；仅上榜项目补查文件树。普通项目也允许，未核实Skill入口则明确标注；文件存在不证明质量或使用。
- GitHub自2026年7月限制查看他人星标明细。采用官方公开stargazers/history?per_page=2，一次读取两周每日计数，验证7天非负整数与周总和，选择覆盖采集时点的当前统计日。
- 当前统计日未结束，边界由GitHub定义、不保证UTC或北京时间自然日；不是滚动24小时或净增，也不使用Trending的stars today。接口未提供最后更新时间，不承诺即时精确或零值时效。见[官方接口说明](https://docs.github.com/en/rest/activity/starring#get-repository-star-history)。
- 第一榜按新增数；新锐要求创建183天内、当前<10000星、新增>=30，按新增/max(当前总星数,100)排序，显示新增占比，不能称期初增长率。创建只用于筛选，不当上线日期。
- 六个既定来源失败、任一合格候选日计数失败或超预算，则整批失败，最新及日期日报保持原样；明确私有/归档项目记录原因后排除。不能把部分采集称完整日榜。
- collector_revision=2；coverage.sources保存每个来源候选名称，observations保存全部成功候选的原始计数；star_evidence含官方URL、请求时间和原始周/日数组。由原始days与week复算本期新增，不使用Trending的stars today混算。

## 中文与上线

仅上榜条目补查简介；简短description为空时继续读取README开头段落，保留文件SHA与来源，标明README摘录机译。请求Google公开翻译接口，最多220字中文并缓存，描述变化后重新翻译，失败显示中文待补、不回退英文。桌面已有人工中文整理优先，机译不代表试用结论。不调用用户配置的模型API、不消耗其模型token；免费公开翻译服务的可用性不保证。

明确绑定项目来源的official_launch才显示首次上线及已上线天数；release_record只显示完整分页后的最早可查版本，保留上线待核实。历史日报按其generated_at算天数。

## 文件与兼容

- data/rankings.json：最新日报，metric=github_reported_daily_new_stars；每行new_stars_day和来源日窗口，未伪装为24小时新增。
- data/daily/YYYY-MM-DD.json：按北京时间日期长期归档，同日更新较新成功批次，其他日期保留。
- data/discovery-cache.json：中文及上线元数据缓存，上限200、35天未使用过期；**不是监控池，不限制谁入榜**。
- data/state.json及collector.mjs：旧净增采集历史与兼容测试/helper，不再作为默认定期采集机制。

桌面固定官方GitHub contents API，仅读缓存进入，点击才联网；选日期查历史，每日独立缓存，失败不替换为其他日期，最新超过36小时标旧。旧metric=net_star_change_between_observed_snapshots的日报保留快照净增说明，不与新版新增星标横比。旧日期缺失不重建。原正式软件源码未公开。
