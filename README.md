# 按需读取的 Skill 双榜

云端已部署到 https://github.com/Tang-dx/skill-rankings ，首轮Action 41305136840成功，15个真实公开仓库形成基线，尚无可比较日增。正式桌面新增 Skills → 涨星榜，点击获取已生成的数据，不在电脑后台采集。实际桌面验证结果以项目当前开发状态及本批证据为准。

用户目标：电脑不用常开，点击即读取已经计算好的公开数据；不让模型逐仓库调查，不消耗模型 token。GitHub 当前星数接口没有历史日增量，因此必须由其他持续运行的环境保存快照。本包供独立数据仓库定时执行，不能把正式 AI 开发助手仓库整个发布出去。

## 已核查的数据源

- `https://api.ossinsight.io/v1/trends/repos/?period=past_24_hours` 在 2026-11-01 实测返回 `data_quality.status=unavailable`，声明公开事件采集量约为基线的 0.3%，不能计算可靠排名。HTTP 200 不计作可用。
- `https://api.star-history.com/repo/morluto/rea` 实测给出 `weekly_activity.new_stars` 和总星数，没有本次所需的每日增量；不以周增量代替日增量。
- GitHub Trending 的 `stars today` 是原站日榜显示值，不提供本方案所需的完整 Skill 覆盖及统一历史基线，不能假称全站涨星排行。
- 上述事实只说明这些已核查接口不满足需求，不断言所有第三方服务都不可用。

## 本地验证

需要 Node.js 22+，无 npm 安装或第三方依赖。

```powershell
node --test tools/skill-rankings/collector.test.mjs
node tools/skill-rankings/collector.mjs --repos morluto/rea --output docs/b1a-evidence/skill-rankings-20261101/live-baseline
```

`--repos owner/repo,owner/repo` 是显式小范围采集；`--discover` 启用三组固定 GitHub 查询（热门 agent-skills、新建小体量 agent-skills、新建名称/描述含 skills 的仓库）。每次最多新增核查15个、监测上限200个、执行预算240秒，单请求12秒。GitHub API 限流/网络失败逐项记录；无成功当前样本则失败并保留旧文件。不调用模型，不运行下载的 Skill，不安装软件。

只对新候选查询递归文件树确认存在 `SKILL.md`，缓存路径及检查时间；这是文件存在证据，不是包内容质量、安全性或运行验证。目录有截断且没发现入口时标未知，不算没有 Skill。三组发现交错，未尝试候选优先、最早检查其次并设24h冷却，避免拒绝项每日占满名额。显式拒绝private或公开属性未知的仓库。使用仓库星数，不把集合内多个 Skill 拆成独立星数。

## 榜单口径

- `daily`：两个实际观测时间之间的净增星数降序，允许20–28小时窗口应对云端调度延迟。逐行保留起止时间、基数、实际间隔；不能展示成严格北京时间自然日或精确24小时。取消收藏会减少净增，不叫新增加星事件数。
- `rising`：在上述可比较仓库中，仓库创建不超过183天、期初少于10000星、净增至少30，按 `净增 / max(期初星数,100)` 排序。原始增长率另显示；零基数增长率为未知。年龄是仓库创建年龄，不冒充首次 Skill 发布时间。这些为准备包初始参数，尚待实际一周数据校准，不是用户已验收结论。
- 首次采集、历史缺口或本次失败放 `unranked`，`net_stars=null`；不把未知写0。小盘榜可以为空，不凑数。
- 监测池内排行，不保证全 GitHub 无遗漏。每日发现也不能回填新候选昨天的星数。
- 每小时保留一次最新采集，历史35天；小时只是存储桶，增长用真实间隔，手动重跑不删除同日较早基线。手动触发改变采集间隔，超过窗口则不生成对应日增。定时任务被禁用/延迟会形成数据缺口。

## 独立数据仓库部署与桌面读取

1. 本次经用户登录验证和授权建立独立公开数据仓库 `Tang-dx/skill-rankings`，只放采集器/测试/工作流/公开元数据。未发布正式软件工程。没有将登录密码、cookie或个人令牌写入本地文件或仓库。
2. 本目录 `collector.mjs`、`collector.test.mjs` 已复制到独立仓库根，`collector-workflow.yml` 已复制到 `.github/workflows/collect.yml`；原软件仓库tools目录模板自身不会运行。远程两份源码与本地逐字核对（忽略末尾换行），证据published-source-check.json。
3. 模板北京时间约20:00执行，支持手动触发，使用该仓库的 `GITHUB_TOKEN` 读取GitHub并提交 `data/state.json`、`data/rankings.json`。只记录公开仓库元数据，无正式项目资料或模型凭据。Actions可用额度/调度限制须按用户仓库实际核实，不承诺永久免费或准点。
4. 桌面使用固定官方 GitHub API contents URL：`https://api.github.com/repos/Tang-dx/skill-rankings/contents/data/rankings.json?ref=main`，Accept为 `application/vnd.github.raw+json`。raw.githubusercontent.com本机实测超时，故不作为默认读取端点。当前客户端不需要登录令牌；受到公开API限流时明确失败并保留缓存。
5. Skills页“涨星榜”进入时只读取隔离应用配置目录cache/skill-rankings.json，点击“获取榜单”才请求。后端校验schema/仓库URL/原始星数算术/实际间隔/同批观测/增长率/未来时间及新锐条件，最多2MiB响应、12秒请求；拒绝旧批次倒灌，无效或失败不覆盖有效缓存。生成时间超过36h标旧。列表为两张各最多20项，默认零模型请求。不写项目context或运行模型。

至少第二次满足时间窗口的云端成功采集后才有真实增长榜；首次采集不显示假数据。日程从准备包的00:07调整为北京时间20:00，与首轮11月1日20:09接近；如果后续正常运行，首个可比较日榜预计11月2日20:00采集完成后产生，实际以Action完成及快照间隔为准。不能把本地合成单测当作两次真实云端增长验收。独立审查记录见本批evidence目录，个人收益/接受仍待本人。

## 日期归档与工具查询（2026-11-01）

成功采集额外保存 data/daily/YYYY-MM-DD.json，日期按北京时间从真实 generated_at 得到。同日保留较新的成功批次，不覆盖其他日期；失败不生成假日报。日报文件不随35天原始采样清理，包含两榜、简介、时间、范围与异常；rankings.json 继续作为最新入口。工作流必须 git add data/daily。

桌面日期选择后显式查询固定GitHub contents API的对应归档，严格核对返回批次的北京时间日期，不用最新榜单替代缺失日期。每日期独立缓存；进入仅读最新缓存，查历史时先读所选日缓存后联网，失败保留同日缓存。历史报告不显示最新榜单的36小时过期警告。同日尚可更新；日期是报告日期，仍是实际20–28小时净增，非零点自然日。归档前缺失日期不凭空重建。
