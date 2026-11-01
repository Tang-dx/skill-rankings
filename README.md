# GitHub 项目与 Skill 动态日榜

电脑不用常开，桌面点击读取成品日报，不调用用户模型进行检索。新版已纠正固定旧池：**每次从 Trending 和 GitHub 搜索重新发现候选**，两榜各最多10条，不承诺全站前10。

## 默认采集

Node 22+，无npm依赖：

    node --test collector.test.mjs dynamic.test.mjs
    node dynamic.mjs --output data

由独立公开数据仓库的GitHub Actions运行，使用其GITHUB_TOKEN提供通用API额度及写数据，每天北京时间约20:00，调度可能延迟。公开历史接口无需个人token。不要发布正式AI开发助手源码或项目资料。复制collector.mjs/test、dynamic.mjs/test及工作流模板到独立数据仓库；当前部署Tang-dx/skill-rankings。

## 发现和指标

- 来源：GitHub当日Trending全局及TypeScript页，4组Skill/近期项目搜索。各来源交错，预算内最多选择24仓库，3个工作器，总300请求/240秒。
- 每次当前仓库身份/公开状态和文件树核验。普通项目也允许，未核实Skill入口则明确标注；文件存在不证明质量或使用。
- GitHub自2026年7月限制查看他人星标明细。采用官方公开stargazers/history?per_page=2，一次读取两周每日计数，验证7天非负整数与周总和，选择覆盖采集时点的当前统计日。
- 当前统计日未结束，边界由GitHub定义、不保证UTC或北京时间自然日；不是滚动24小时或净增，也不使用Trending的stars today。接口未提供最后更新时间，不承诺即时精确或零值时效。见[官方接口说明](https://docs.github.com/en/rest/activity/starring#get-repository-star-history)。
- 第一榜按新增数；新锐要求创建183天内、当前<10000星、新增>=30，按新增/max(当前总星数,100)排序，显示新增占比，不能称期初增长率。创建只用于筛选，不当上线日期。
- 每次记录发现、选择、核验、完整观测数量及来源/异常。全无有效观测保留上次榜，不补造数据或填0。

## 中文与上线

仅上榜条目请求Google公开翻译接口，将公开简介整理为最多220字中文机译并缓存，描述变化后重新翻译，失败显示中文待补、不回退英文。桌面已有人工中文整理优先，机译不代表试用结论。不调用用户配置的模型API、不消耗其模型token；免费公开翻译服务的可用性不保证。

明确绑定项目来源的official_launch才显示首次上线及已上线天数；release_record只显示完整分页后的最早可查版本，保留上线待核实。历史日报按其generated_at算天数。

## 文件与兼容

- data/rankings.json：最新日报，metric=github_reported_daily_new_stars；每行new_stars_day和来源日窗口，未伪装为24小时新增。
- data/daily/YYYY-MM-DD.json：按北京时间日期长期归档，同日更新较新成功批次，其他日期保留。
- data/discovery-cache.json：中文及上线元数据缓存，上限200、35天未使用过期；**不是监控池，不限制谁入榜**。
- data/state.json及collector.mjs：旧净增采集历史与兼容测试/helper，不再作为默认定期采集机制。

桌面固定官方GitHub contents API，仅读缓存进入，点击才联网；选日期查历史，每日独立缓存，失败不替换为其他日期，最新超过36小时标旧。旧metric=net_star_change_between_observed_snapshots的日报保留快照净增说明，不与新版新增星标横比。旧日期缺失不重建。原正式软件源码未公开。
