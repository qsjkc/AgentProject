# 小猪首次相处渐进式引导 P1-K 执行记录

## 1. 阶段结论

P1-K 把小猪第一次可用的 3 分钟改造成可恢复、非任务式的渐进引导：先让用户看到桌宠的生命感并自然完成一次触摸或拖拽，再展示真实的亲密度关系，最后由用户明确选择是否创建一个 1 分钟后的喝水提醒，并通过真实提醒的送达与完成闭环结束引导。

本阶段只解决既有能力的发现问题，不新增后端接口、关系经验、奖励或提醒业务规则；不做清单、步骤编号、进度条、连续签到、惩罚、自动创建提醒或自动打开主面板。猫和狗不进入本轮范围。

## 2. 启动边界与资格

引导的 T0 不是进程启动，而是以下条件同时成立的时刻：

- 用户已经登录并取得稳定的数字 `user_id`；
- 当前选择的小猪关系已经加载，且关系的 `user_id` 与当前用户一致；
- 当前宠物是 `pig`；
- 桌宠窗口可见、可交互，用户没有长时间离开系统。

应用现有默认宠物仍是猫，本阶段不会替用户自动切换为小猪。因此只有选择小猪并满足上述条件的新关系才会进入引导。

资格限定为创建不超过 24 小时、仍处于 Lv.1 的小猪关系。状态按 `user_id + relationship_id + pig + v1` 隔离；切换账号、关系或宠物不会沿用其他上下文的引导。损坏的本地状态会转为终止墓碑，不用猜测数据继续播放。

## 3. 可恢复状态机

Electron 主进程保存版本化引导状态，包括已观察能力、已经展示的桌宠步骤、真实 reminder ID、可见活跃时长、暂停时间、终止原因、presentation 租约和 revision。观察只允许单调增加，完成、超时和永久关闭均为不可逆终态。

桌宠 presentation 使用 15 秒 UUID 租约。领取、续租、确认和释放都必须同时匹配步骤与 token；过期租约不能确认或释放。渲染进程用用户、关系、宠物和 context epoch 丢弃晚到的旧请求，主进程则校验 IPC 窗口角色和当前会话身份。

系统时间回拨时，持久时间戳仍取当前状态时间与新时间的最大值，避免状态失效或 mutation 崩溃。可见活跃预算使用主进程单调时钟限速：第一次上报只建立基线，之后每次最多接受请求值、真实经过时间和 5 秒三者中的最小值，渲染进程单次上报最多 1 秒，因此高频 IPC 不能瞬间耗尽预算。

## 4. 桌宠渐进提示

桌宠只在语音空闲、窗口可见、系统活跃、没有拖拽/回弹/照料/临时气泡/锁定动画/关系里程碑/陪伴请求时领取提示。

第一段 `meet_pet` 使用约 6 秒的轻量观察动作和“摸摸 / 拖拽”文案。一次真实点击、摸摸、照料或拖拽会记录互动；即使用户没有操作，本段完整展示后也只记录“已经看过”，不会产生经验或业务奖励。

第二段 `relationship` 使用约 8 秒展示真实的 `亲密度 Lv.X · 阶段`，并说明忙几天不会倒退。它只提供显式“看看我们”按钮：超时会释放租约并在本机冷却 30 秒后重试，不会把入口永久标记为完成，也不会自动打开主面板。

用户点击“看看我们”后，桌宠先请求打开主面板并携带关系导航 intent、非敏感 semantic identity 与主进程签发的 opaque `{id}` capability。renderer 看不到 capability 内部的 token、scope、identity、revision 或过期时间。React 只建立 context-bound 临时 tab override，不改持久 tab；认证、semantic identity、main capability 校验和目标 DOM 都成立后才滚动，并由 React 显式发送 exact ACK。ACK 返回 true 后才提交持久 chat tab；ACK false、5 秒超时、目标缺失、用户切 tab、新 intent 或上下文变化都只清临时 override，原 tab 自然恢复。打开成功后才续租并确认步骤，不抢键盘焦点。

## 5. 提醒闭环

真实关系卡在聊天页可见后，主面板幂等记录 `relationship_viewed`，随后显示一个非模态、无进度的可选提醒邀请。

- 只有用户点击“试一个 1 分钟后的喝水提醒”才调用现有提醒接口；
- “以后再说”暂停 24 小时，“不再提示”进入永久终态；
- 任何用户主动创建且解析成功的小猪提醒也可满足创建能力，并绑定真实 reminder ID；解析失败不记录；
- 等待阶段不计入 180 秒超时，直到绑定提醒完成或用户明确结束；
- 只有匹配 reminder ID 且已经触发的待处理项才显示引导高亮；
- 只有完成同一 reminder ID 才记录 `reminder_completed`，其他提醒不会误结束引导。

提醒高亮使用视觉提示和 `aria-live` 文案，不主动聚焦按钮；用户正在聊天或操作其他控件时不会被抢走键盘焦点。

## 6. 优先级与恢复

提醒、语音、关系里程碑、拖拽、照料和用户主动操作优先于 onboarding；onboarding 又优先于陪伴轮询和随机待机。中断只释放当前 presentation，不假装已经展示；下一次安全窗口可以继续。

窗口隐藏、系统空闲、暂停期间不累计 180 秒。用户已经创建但尚未完成绑定提醒时豁免超时，避免一分钟提醒还没送达引导就提前结束。应用重启后会从持久状态继续；切换账号、宠物或关系会立即清理运行时上下文，但保留各自隔离的历史终态。

陪伴轮询在发起、摘要返回和最终提交前都检查 onboarding 请求和可见提示，且 onboarding 在陪伴请求未结束时不会领取 presentation，避免异步陪伴文案覆盖引导。桌宠原有启动语音在符合 P1-K 资格时被抑制，提醒轮询仍保持后台送达能力。

## 7. 会话与窗口隔离修复

独立 review 后补强了以下边界：

1. `set-session-token`、桌宠状态同步和宠物切换只允许主面板窗口调用；主动登出仅主面板可无条件发起，401/403 清理必须匹配请求发起时的 exact token 与 session generation。
2. 会话 token 的 JWT `sub` 只用于当前凭据内部的一致性校验，不替代服务端验签；同步用户必须与 `sub` 相同。
3. token 切换会先清当前用户、关系、里程碑和陪伴缓存并广播空上下文，但保留按用户隔离的 onboarding 历史。
4. 关系缓存写入必须同时匹配 token 用户、当前用户、当前宠物和关系归属，旧账号的晚到响应不能恢复到新会话。
5. 未授权 onboarding IPC 会先完成窗口角色校验，不返回当前状态。
6. 主面板 intent 由 UUID 关联：preload 只负责 listener 0→1/1→0 readiness，不自动 ACK。React DOM consumer 完成 semantic/cap 校验、临时 override、目标存在与真实 scroll 后显式 ACK；main exact ACK true 后才提交持久 tab。错误/重复 ACK、未认证、关系未加载、目标缺失、主 frame 加载失败、renderer gone、窗口销毁和 5 秒超时都失败并清临时 override。seen intent ID 使用固定容量与 TTL。
7. 主进程维护分 scope 的权威 revision：account revision 只随 exact session/active user 改变，pet revision 再随 active pet 改变，relationship revision 再随关系 identity 或可信写入改变。renderer capability 公开 DTO 永远只有 `{id}`；scope/identity/revisions/expiry 只存在 main registry entry。过期 capability 不能授权 mutation，但同 sender/role 且内部 snapshot 仍 current 时，capture 可原 ID 滑动续租；pet/account/relationship ABA、cross-sender 和 semantic mismatch 都拒绝。每 sender 使用固定上限 LRU，session transition 与 window destroy 主动 revoke。
8. renderer 的 HTTP `session` 与 capability 分离；`local` 保存 scope/user/pet/relationship/epoch，仅用于 UI freshness，main 不把它当 authority。account gate 不受 pet switch 影响，pet/relationship gate 逐级增加 semantic identity；main handler 仍各自声明 requiredScope。
9. relationship/pet-state 广播对每个目标窗口签独立 opaque capability。deferred relationship emit 执行时重新读取当前 cache；main-panel、pet、quick-chat 都先做 payload relationship/semantic exact compare，再让 main 将 semantic 与 registry 内 snapshot 比对，旧 payload + 新 cap 或过期事件不会被采用。
10. 到期提醒的系统通知仅允许 pet renderer 携带当前 pet capability 调用，主进程在真正 `Notification.show()` 前做最终授权；登录成功提示保留 main-panel role-only 的非账户通知路径。

## 8. 已完成验证

- `desktop/`: `npm.cmd test`，轻量测试通过，覆盖资格、上下文隔离、观察单调性、180 秒预算、waiting 豁免、UUID 租约、过期确认/释放、时钟回拨、单调限流、损坏状态、提醒 ID、导航 intent、冷却和陪伴提交门禁。
- `desktop/`: `npm.cmd run build:renderer`，生产渲染构建通过。
- `desktop/`: `node --check electron/main.cjs`、`node --check electron/preload.cjs` 和 `node --check electron/pet-onboarding-store.cjs`，通过。
- `git diff --check`，通过。
- 2026-09-05：`npm.cmd run test:e2e` 完整九场景连续两次通过；最新记录为 `desktop/artifacts/e2e/2026-09-05T09-16-41-793Z--31876--d42533/run.json`。覆盖真实 Electron 的三窗口、首次互动与提醒闭环、过期 capability、重载恢复 intent、真实 UI 的 A/B 登录切换、窗口销毁重建、ACK 拒绝与五秒超时、关系广播后的快捷聊天。
- 本轮修复提醒面板重复加载/旧 capability、主面板过早注册 intent consumer、导航失败后的 presentation 释放、已销毁窗口访问 `webContents`、快捷聊天焦点与会话同步竞态。请求完成日志与实际 React 提交证据分开记录。

E2E 使用隔离 userData、本地 stub 账号与接口；测试模式将系统空闲值固定为零，并通过推进 stub 提醒时间验证送达。权限过期由测试控制强制触发，不是等待自然 TTL。主链未使用引导状态重置；拒绝/超时等故障场景使用明确 fixture。因此不证明真实三分钟计时、自然一分钟等待、外部 LLM/RTC、真实后端或真实系统空闲行为。

渲染构建仍有既有的 Vite CJS Node API 弃用和大于 500 kB chunk 警告，本阶段没有扩大范围处理。

## 9. 尚未验证与运行风险

- 未在真实 Windows 安装包中用全新账号和真实后端按秒表完成首次 3 分钟验收。
- 已做真实 Electron + stub 的三窗口自动化与快速 A/B 账号切换；Windows 睡眠/唤醒、长时间挂起和屏幕阅读器仍未验收。
- renderer 在每个账户请求发起时把独立 `{token, session generation}`、opaque `{id}` capability 与 UI-only `local` semantic context 一起捕获；等待 API base 后及响应解析前后都以 requiredScope 向主进程复验 capability。旧请求不会借用新 token，也不会在同账号 pet/relationship 切换后实际 fetch，迟到的 401/403 也只能 compare-clear 原 session snapshot。同 token 的 logout/relogin ABA 同样会因 generation 不同而本地终止。
- 无 provenance 的 legacy 裸 `petMilestonePlayback.pig` 不会迁给当前首个登录者：读取时删除/隔离，绝不播放、ACK 或复制；只有条目自身带明确且匹配 JWT `sub` 的 `account_user_id` 才原子搬迁。该取舍优先防跨账户 tombstone，接受极少数服务端里程碑可能重新协调一次。
- JWT payload 在主进程中不做本地验签，只作为已经存储的真实会话凭据与渲染上下文之间的一致性约束；认证安全边界仍在后端。
- P1-J PostgreSQL 14 的迁移、合成旧数据恢复、双服务会话领取竞争与 ACK 幂等已通过；双桌面 UI 的领取竞争、生产数据升级和长时间挂起仍未验收。详见项目根目录 `P1L-验收记录.md`。

## 10. 下一步建议

下一轮优先做 P1-L Windows 真实安装验收与可重复 smoke 流程：使用全新小猪账号验证 T0、生命感、互动、关系导航、1 分钟提醒送达/完成、重启恢复和 A/B 切换，并保存可审计的时间线与日志。先验证已经实现的留存主链，再决定是否继续增加功能。
