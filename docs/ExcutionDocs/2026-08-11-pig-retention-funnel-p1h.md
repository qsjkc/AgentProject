# 小猪周回顾管理员聚合漏斗 P1-H 执行记录

## 1. 阶段结论

P1-H 将 P1-G 的白名单留存事件转换为管理员可读取的周级聚合漏斗。接口只返回按周、按宠物去重后的用户数量和转化率，不返回原始事件、用户 ID、用户名、邮箱或单用户行为轨迹。

当前代码、管理员权限测试、聚合口径测试、后端全量测试和迁移 013 隔离验证已经完成；尚未在真实 PostgreSQL 数据和生产管理员流量上验收。

## 2. 管理员接口

新增接口：

- `GET /api/v1/admin/retention/weekly-reviews`

查询参数：

- `pet_type`：`cat`、`dog` 或 `pig`，默认 `pig`。
- `limit`：返回最近周数，范围 1 至 52，默认 12。

接口继续复用 `get_current_superuser`。未登录返回 401，普通用户返回 403。

## 3. 返回字段

每个 `review_key` 返回：

- `generated_users`
- `shown_users`
- `seen_users`
- `follow_up_users`
- `follow_up_care_users`
- `follow_up_chat_users`
- `follow_up_reminder_users`
- `shown_from_generated_rate`
- `seen_from_shown_rate`
- `follow_up_from_seen_rate`

转化率使用 0 至 1 的小数，保留四位；分母为 0 时返回 `0.0`。

## 4. 聚合口径

漏斗按用户去重，并使用下游事实逻辑补齐上游：

- 任意该周事件都证明周回顾已经生成。
- `seen` 或后续互动证明周回顾已经展示。
- 后续互动证明周回顾已经成功已读。

该口径能够容忍 best-effort `shown` 上报偶发失败，并保证漏斗人数单调不增、转化率不会超过 100%。

照料、聊天和提醒类别分别按用户去重，同一用户可以出现在多个类别中。因此三个类别人数不能直接相加为 `follow_up_users`；总后续人数使用三个类别的用户并集。

## 5. 排序与性能

- `review_key` 使用固定 `YYYY-MM-DD_YYYY-MM-DD` 格式，按字符串倒序等价于按周倒序。
- 先选择指定宠物最近的 N 个周，再只聚合这些周的数据。
- 迁移 013 增加 `pet_type + review_key + event_type + user_id` 覆盖索引，避免数据增长后按周和宠物查询退化为全表扫描。
- 旧 SQLite 数据库在应用启动时会用 `CREATE INDEX IF NOT EXISTS` 补建该索引；迁移 013 同样使用幂等创建，避免先启动应用、后执行迁移时因索引已存在而失败。

## 6. 隐私边界

响应模型没有用户标识或任意 metadata 字段。管理员只能看到聚合人数和比率，不能从接口反查某一用户是否查看周回顾或做过哪类后续行为。

本阶段没有增加事件导出、原始明细接口、用户画像、IP、设备信息或第三方分析平台连接。

## 7. Review 与测试重点

本轮 review 后补充覆盖索引、旧 SQLite 索引补建和迁移幂等保护，并验证以下边界：

1. 未登录和非管理员不能访问。
2. 同一用户多种后续行为只在总后续人数中计算一次。
3. 缺少上游埋点但存在下游事实时，漏斗仍保持逻辑一致。
4. 不同宠物互不串联。
5. 多周按倒序返回，`limit` 正确裁剪。
6. 无数据宠物返回空列表。
7. 非法宠物类型和超范围 `limit` 返回 422。
8. 响应不包含用户 ID 或用户名。

## 8. 已完成验证

- `backend/`: `.\venv\Scripts\python.exe -m pytest tests/test_main.py::test_admin_weekly_review_funnel_is_aggregated_and_private -q`，通过。
- `backend/`: `.\venv\Scripts\python.exe -m pytest tests/test_main.py -q`，13 项通过。
- `backend/`: `.\venv\Scripts\python.exe -m pytest`，全量通过。
- 隔离 SQLite 的 012 基线上执行迁移 013 升级、索引字段核对、回滚到 012、再升级，均通过。
- `git diff --check`，通过。

测试仍报告仓库既有的第三方弃用、SQLAlchemy 连接回收和 pytest 缓存权限提示；本阶段没有扩大范围处理。

## 9. 后续运行验收

1. 在接近真实数据的 PostgreSQL 副本上验证迁移 013 和查询计划。
2. 准备包含缺失 `shown`、多类别后续行为和多宠物的数据，核对聚合结果。
3. 使用真实管理员和普通账号验证权限边界。
4. 确认大于 12 周的数据默认只返回最近 12 周，最大可查看 52 周。

## 10. 下一阶段建议

P1-I 建议在现有管理端增加一个轻量周回顾漏斗视图：宠物筛选、最近周数选择、漏斗人数和三段转化率表格。界面只消费本阶段的聚合接口，不增加原始事件明细或用户下钻。
