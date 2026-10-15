# qq-for-agent

**让 agent 通过官方 QQ Bot 查询已收到的群聊上下文，并发送文本。** 未 @ 的群消息也先入库；是否唤醒模型由 webhook 接收端决定。

```bash
bun install --frozen-lockfile
bun run build
node dist/cli.js connect
node dist/cli.js serve
```

`connect` 会展示腾讯扫码创建应用的二维码，需要管理员在手机 QQ 中确认。已有 App 可直接填写私有配置，跳过扫码。这里使用官方机器人 App 身份，与管理员的个人 QQ 账号不同。

| 能力             | 行为                                                            |
| ---------------- | --------------------------------------------------------------- |
| 单 App 文本网关  | 官方 SDK 接收群聊和单聊；HTTP 仅监听 `127.0.0.1`                |
| 永久 SQLite 记录 | 保存实际收到及平台确认发出的文本；重启可查询                    |
| MCP              | `whoami`、`list_conversations`、`read_messages`、`send_message` |
| 可选 webhook     | 入库后传递消息事实；接收端决定接纳、session 写入及唤醒          |

## 安装与接入

需要 **Node >=24.15**（内置 `node:sqlite`）及 [Bun](https://bun.sh/docs/installation)。Bun 管理依赖和构建，运行与测试使用 Node。建议使用当前 Node 24 LTS。克隆本仓库后执行上面的安装和构建命令，保持 `node_modules` 与 `dist` 一起运行。

运行依赖固定为 `@tencent-connect/qqbot-nodejs@1.0.5` 和 `@tencent-connect/qqbot-connector@1.2.0`。构建只打包本项目，保留所有 npm 依赖及 Node builtins 为外部导入；connector 发布包标记 `UNLICENSED`，本仓库调用其公开 API，不复制或内嵌其实现。

### 扫码创建 App

```bash
node dist/cli.js connect --config "$HOME/.local/share/qq-for-agent/config.json"
node dist/cli.js serve --config "$HOME/.local/share/qq-for-agent/config.json"
```

connector 自行展示二维码、轮询确认并在过期后刷新。成功后保存一个 AppID、AppSecret 及新生成的独立 `gateway_token`，不打印密钥。已有配置会拒绝覆盖；多 App 扫码结果会拒绝自动选择。SIGINT / SIGTERM 取消，晚到成功回调不会写入配置。connector 自身的在途网络请求可能稍后才退出，期间不会接受其晚到凭证。

扫码成功仅证明凭证已取得。仍须在 [QQ 开放平台](https://bot.q.qq.com/wiki/) 完成测试/发布资格、添加机器人、权限及接收设置，才能验证实际收发。

### 已有 App：私有配置

创建项目专用私有目录，将以下 JSON 保存为该目录中的 `config.json`，把三个示例值分别换成你的 AppID、AppSecret 和独立随机网关 token。可用 `openssl rand -hex 32` 生成网关 token。不要将凭证放入命令参数、仓库或共享目录。

```bash
install -d -m 700 "$HOME/.local/share/qq-for-agent"
# 用本地编辑器创建下面的 config.json，然后限制权限：
chmod 600 "$HOME/.local/share/qq-for-agent/config.json"
```

```json
{
  "app_id": "YOUR_APP_ID",
  "app_secret": "YOUR_APP_SECRET",
  "gateway_token": "INDEPENDENT_RANDOM_GATEWAY_TOKEN",
  "port": 8787,
  "webhook": {
    "url": "http://127.0.0.1:9090/qq",
    "bearer": "INDEPENDENT_RECEIVER_TOKEN"
  }
}
```

`webhook` 整项可省略，`bearer` 也可省略；`port` 默认 8787。配置不接受额外字段。AppSecret 与 gateway token 必须不同；receiver Bearer 是另一独立接收端凭证。

`--config PATH` 默认 `~/.local/share/qq-for-agent/config.json`。数据库固定为同目录 `messages.sqlite`；目录会限制为 0700、配置与数据库为 0600，WAL/SHM 位于该私有目录。**每个配置目录只属于一个 App**：更换 AppID 时使用新目录，已有数据库会拒绝不同 App，避免串用历史。一个目录只运行一个 serve 进程。`--help` 和参数解析不创建状态。

## 群消息与历史边界

在腾讯平台为机器人开启**接收所有消息**并取得相应权限后，未 @ 的群消息可通过 `GROUP_MESSAGE_CREATE` 推送。`GROUP_AT_MESSAGE_CREATE` 是另一种事件。网关订阅群聊/单聊 intent，两个群事件都记录；不以 @ 作为入库条件。未开启全量接收时，只能记录平台实际推送的范围。参见[腾讯全量群消息文档](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)。

SQLite 永久保留有效入站顶层文本与确认出站文本，无自动过期、清理或搜索。只有附件而没有文本的消息跳过；混合消息保留顶层文本，不把引用/转发的 `msg_elements` 内容冒充本条原消息。记录可证实的提及和引用索引，不编造引用作者、引用原文或成员列表。不存原始事件、`auth_token`、媒体下载 ticket 或 AppSecret。

历史仅为 **observed history**，不包含接入前、未获推送或停机期间漏掉的内容。SDK 负责连接及短暂断线恢复；恢复补发可入库去重，在 `RESUMED` 前抑制通知，之后的新文本正常通知。[腾讯恢复时序](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)说明补发完成后才发出 `RESUMED`。重启读取旧库不会发送旧通知，没有持久化 webhook 队列或完整离线历史承诺。

## MCP

地址默认 `http://127.0.0.1:8787/mcp`，使用无 session 的 **Streamable HTTP MCP**。每个 POST（包括 initialize、列工具和调用工具）必须且只能提供一个 `Authorization: Bearer <gateway_token>`；它与 QQ AppSecret 分离。只开放 loopback，不提供公网 TLS/部署方案。

将 MCP 客户端配置为 HTTP transport、上述 URL 及该 Authorization header。示例工具参数：

```json
{
  "name": "read_messages",
  "arguments": { "conversation_id": "group:OBSERVED_GROUP_OPENID", "limit": 20 }
}
```

| 工具                 | 参数与结果                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `whoami`             | `{}` → `app_id`、`connection_state`、`identity_source: "configured_app"`；本地配置身份，并非腾讯逐请求身份查询          |
| `list_conversations` | `{limit?, before?}` → `conversations`、`next`、`observed_only: true`、`incomplete: true`；只列实际观测会话              |
| `read_messages`      | `{conversation_id, limit?, before?}` → `messages`、`next`、`observed_only: true`、`incomplete: true`、`page_byte_limit` |
| `send_message`       | `{conversation_id, body, reply_to_message_id?}` → 确认后返回 `status: "sent"`、原生 `message_id`、`stored`              |

会话 ID 格式 `group:<group_openid>` / `c2c:<user_openid>`；只接受本 App 已观测到的会话，OpenID 不是通用 QQ 号。消息含 AppID、会话类型/原生 ID、原生消息 ID、方向、作者、时间、原文及可用来源/提及事实。出站作者用 AppID 表示该 App；没有伪造用户显示名。

分页默认 20，最大 100。`list_conversations` 按会话首次观测的稳定顺序由新到旧列出；`read_messages` 从最近记录向更早翻页，每页内部按入库顺序正序。顺序以 SQLite 自增序号为准，不依赖可能相同或乱序的平台时间。把 `next` 原样传为下次 `before`，直到 `null`；cursor 绑定 App 和查询范围，不能跨会话使用。页间插入新记录不会影响已拿到 cursor 的旧记录遍历。

HTTP 请求最大 128000 bytes。消息查询每页存储 JSON 预算 512000 bytes，达到预算会提前分页；单条超过预算则返回明确工具错误，数据库仍保留全文。通知截断不改变入库文本。发送正文限制 1–16000 个 UTF-16 字符，保留原文，不自动拆分。

认证失败返回 HTTP 401；错误路由/方法为 404/405；JSON 错误 400、请求过大 413。参数错误、未知会话、畸形/跨会话 cursor 和发送错误通过 MCP `isError` 返回。上游原始错误和秘密不会返回客户端。

### 回复与不确定发送

提供 `reply_to_message_id` 表示被动回复：必须是本 App **同会话已观测入站**的原生消息 ID；本地检查群消息 5 分钟、单聊 60 分钟时效。次数、权限、平台的进一步限制由 QQ 判定（目前群最多 5 次、普通单聊最多 4 次，实际规则以平台为准）。这关联原消息生命周期，不承诺 QQ UI 展示引用作者或引用框。[腾讯消息规则](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)

省略回复目标是明确主动发送，可能因平台权限、接收方开关或额度被拒绝。过期或跨会话回复不会退化为主动发言。网关与 SDK 文本发送路径均不自动重试、不拆分。

发送的完整操作期限为 **30 秒**，包括取 token、等待 headers 和消费完整响应体；持续滴流的 body 也不能延长该期限。首次启动须在 **10 秒**内收到 READY，否则取消启动并报告连接错误，需要操作者修正网络/权限后重启 serve。SDK 后台 token 请求也受完整 HTTP 响应期限和网关生命周期信号约束。

只有有效原生消息 ID 才返回 `sent`。超时、网络错误、5xx 或坏回执返回 **outcome unknown**：消息可能已经发出，**不要盲目重发**。平台明确拒绝会返回安全错误。确认成功但入库失败仍返回 `status: "sent"`、`message_id`、`stored: false` 和 warning，不能通过重发修复本地记录。重启后，本地没有记录也不能证明 QQ 没有发送。

## Webhook 与接收端职责

一个固定 URL，可选独立 receiver Bearer；不依赖 MCP 客户端生命周期，也不允许调用者动态注册。有效文本**成功入库后**才排通知，重复事件和可由已确认原生 ID 证明的出站回声不会再次通知。不将所有 `bot` 作者当成本 App。

普通群文本和 @ 文本都通知，接收端按原生来源与 mentions 决定是否唤醒 agent；本项目不调用模型，也不实现 sender allow list、session store 或消费者接线。

```json
{
  "app_id": "123456",
  "conversation_id": "group:GROUP_OPENID",
  "conversation_type": "group",
  "native_conversation_id": "GROUP_OPENID",
  "message_id": "NATIVE_MESSAGE_ID",
  "direction": "inbound",
  "sender_id": "MEMBER_OPENID",
  "sender_name": "可用时保留",
  "timestamp": "2026-10-15T12:00:00Z",
  "body": "群里实际收到的顶层文本",
  "raw_event_type": "GROUP_MESSAGE_CREATE",
  "mentions": [{ "member_openid": "BOT_OPENID", "is_you": true }],
  "truncated": false
}
```

`sender_name`、`mentions`、`ref_msg_idx` 仅来源存在时出现。`mentions` 白名单保留 `scope/id/user_openid/member_openid/nickname/username/bot/is_you`，不从文本猜测。通知正文最多 16000 字符并明确 `truncated`，全文可经 MCP 查询（受单页预算约束）。

有界串行队列最多 100 条（含正在发送的一条）；每条最多 3 次，每次 5 秒，间隔 250ms；任意 2xx 确认，禁止重定向，重试 JSON 字节一致。接收端须按 `(app_id, conversation_id, message_id)` 去重。队列满/尝试耗尽时只记安全摘要并丢通知，数据库记录仍保留。退出会取消在途通知和等待，不再发起重试；队列不跨重启保留。停止网关也会取消 SDK 的在途 HTTP 请求（含 token 和发送响应体），再关闭数据库；停止时尚无有效回执的发送按 unknown 处理，已取得的确认 ID 与存储结果仍保留。

## 验证与真实 QQ 验收

```bash
bun run typecheck
bun run test
bun run build
node dist/cli.js --help
```

自动测试使用 test-owned 临时目录、真实 Node SQLite、本地 MCP client/receiver。真实 SDK 1.0.5 经本地 token/API/WebSocket endpoints 验证 dispatch、IDENTIFY/RESUME、补发到 RESUMED 的边界、群/单聊和实际 REST 请求次数；QR 使用 connector callback seam，没有向腾讯请求创建或授权。

**本地 fake endpoints 成功不等于 QQ 真机验收。** 在操作者另行授权的专用测试 App 上手动执行：

1. 验证已有 App 配置，以及另一个新私有目录的扫码创建、过期刷新、取消和凭证权限；确认不打印密钥。
2. 设置腾讯群全量接收，添加机器人。群成员先发未 @ 文本，再发 @ 请求；receiver 仅按自身唤醒规则处理，MCP 能读到两条。
3. 测试单聊入站；群/单聊分别被动回复和明确主动发送，确认原文及 QQ 界面显示，记录权限/次数拒绝情况。
4. 停止并重启，同库文本可查、旧通知不回放；换 App 与旧库组合必须拒绝。短断线检查补发入库与通知抑制，记录离线观测缺口。
5. 模拟 receiver 不可用、重复通知及 shutdown；对未知发送结果先检查实际 QQ 显示，避免盲目重发。

本 PR 不部署、不创建真实机器人、不扫码授权，也不发真实 QQ 消息。设计参考 matrix-for-agent 的 MCP 与独立 webhook 边界，以及 DeepSeekBot 的官方 QQ 接入研究；领域术语见 [CONTEXT.md](CONTEXT.md)。本项目代码许可见 [LICENSE](LICENSE)，外部依赖各自许可适用。
