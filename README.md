# dsh-agent-memory · Claw 记忆

独立记忆插件。每个 Claw Agent 有 USER / MEMORY 金库、日记和回合后回顾。不拦截其它工具。HEARTBEAT 巡检不在本插件。

- `memory` 工具只挂在 Claw 会话上（`agent/created` + `agent/session-start`）
- 回合结束后按设置做回顾；压缩开始时听官方 `session/event` 的 `compaction/start`，立刻把该写入金库
- 设置：自由写或需审批、回顾开关。待审批项在 Claw Agent → 记忆 tab
- 工作区 / 官方会话不注入 Claw 记忆。Claw 会话只读自己的金库。

## 安装

```sh
dsh plugin --profile web add github:xingyingyuzhui/dsh-agent-memory
```

建议装在 `dsh-agent-registry` 和 `dsh-agent-identity` 之后。装完重启 `dsh web`。

本地开发：

```sh
dsh plugin --profile web add link:/abs/path/to/dsh-agent-memory
```

## 数据

- `~/.dsh/DSclaw/<slug>/USER.md`、`MEMORY.md`
- `~/.dsh/DSclaw/<slug>/memory/YYYY-MM-DD.md`
- `~/.dsh/agent-memory/settings.json`（审批、回顾开关）

卸掉后文件留在盘上，不再注入、不再回顾、`memory` 工具消失。

## License

MIT
