# 五子棋 · 联机对战（React + TypeScript / Python）

一个可以直接放到公网联机的五子棋小游戏：**前端 React 18 + TypeScript + Vite**，
**后端 Python 3.11 + FastAPI + WebSocket**。服务端为唯一裁判，房间码邀请、
快速匹配、准备开局、聊天、再来一局、断线重连全部可用。

- 前端构建产物由后端同端口托管 —— 对外只需要暴露 **一个端口**，天然同源，
  没有额外的 CORS / 跨域 WebSocket 问题。
- 单进程内存房间，零数据库，零 Redis，部署成本极低。
- 协议契约见 [`PROTOCOL.md`](./PROTOCOL.md)，前后端都按它实现。

```
浏览器 ──HTTP / WS──► FastAPI (8765) ──► 房间内存状态
                        │
                        └─ 托管 web/dist 静态资源
```

## 功能

| 模块 | 能力 |
| --- | --- |
| 大厅 | 修改昵称、快速匹配、创建房间（公开/私密、执黑/执白/随机）、公开房间列表、房间码加入、`?room=CODE` 邀请链接 |
| 对局 | 15 路棋盘、黑白轮流、服务端判胜（横/竖/斜，≥5 连）、和棋、最后一手标记、胜利连线高亮、手数、双方在线状态 |
| 房间 | 双方准备开局、房主标识、复制房间码/邀请链接、离开房间、对手离开判负并重置等待新对手 |
| 社交 | 房间内聊天（保留最近 50 条、长度限制、频率限制） |
| 稳定性 | 断线自动重连、会话恢复（playerId + token）、掉线 60s 宽限、心跳保活、消息限流 |

## 界面预览

| 大厅 | 对局中 |
| --- | --- |
| ![大厅](docs/screenshots/lobby.png) | ![对局中](docs/screenshots/midgame.png) |

| 五连复盘 | 移动端 |
| --- | --- |
| ![五连](docs/screenshots/finished.png) | ![移动端](docs/screenshots/mobile.png) |

## 目录

```
gomoku/
├── PROTOCOL.md          # 前后端 WebSocket 协议契约（唯一事实源）
├── README.md
├── Dockerfile           # 多阶段构建：Node 构建前端 → Python 运行
├── docker-compose.yml
├── .env.example
├── docs/screenshots/    # 界面截图（README 预览用）
├── scripts/
│   ├── dev.sh           # 开发：后端 8765 + Vite 5173
│   ├── start.sh         # 生产：单端口 8765
│   ├── e2e.py           # 端到端联机冒烟（真实 WebSocket 双人对局）
│   └── ui_smoke.py      # 浏览器 UI 冒烟（可选，Playwright + 本机 Chrome）
├── server/              # Python 后端
│   ├── app/             # main / config / game / rooms / ws ...
│   ├── tests/           # pytest：规则 + 房间 + WebSocket 全流程
│   └── requirements.txt
└── web/                 # React + TS 前端
    ├── src/
    └── vite.config.ts
```

## 快速开始（开发模式）

环境：Node.js ≥ 18、Python ≥ 3.11。

```bash
cd gomoku
./scripts/dev.sh
```

- 前端：<http://localhost:5173>（Vite HMR，`/api` 与 `/ws` 代理到后端）
- 后端：<http://127.0.0.1:8765>（`/api/health` 可探活）

首次运行脚本会自动 `python3 -m venv server/.venv`、安装依赖、`npm install`。

### 手动启动

```bash
# 后端
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8765 --reload

# 前端（另开终端）
cd web
npm install
npm run dev
```

## 生产 / 公网部署（单端口）

```bash
cd gomoku
./scripts/start.sh          # 自动构建前端 + 建 venv + 启动 8765
```

脚本等价于：

```bash
cd web && npm ci && npm run build
cd ../server && .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8765
```

构建完成后访问 `http://<服务器IP>:8765` 即可，静态页面、REST、WebSocket 全部同源。

### 方式一：局域网直连

后端默认已监听 `0.0.0.0`。确保防火墙/安全组放行 8765，然后访问
`http://<局域网IP>:8765`。手机连同一 Wi-Fi 也能直接玩。

### 方式二：公网隧道（最快，无需域名/证书，自动 HTTPS + WSS）

```bash
# Cloudflare Tunnel（免费、支持 WebSocket）
cloudflared tunnel --url http://localhost:8765

# 或 ngrok
ngrok http 8765
```

把隧道给出的 `https://xxx.trycloudflare.com` 发给朋友即可。页面里点「复制邀请链接」
会把 `?room=房间码` 带上，好友打开自动进入同一房间。

> 隧道域名是临时的，重开会变；长期使用请用方式三。

### 方式三：VPS + Nginx + 域名 + HTTPS（推荐长期）

```nginx
server {
    listen 80;
    server_name gomoku.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name gomoku.example.com;

    ssl_certificate     /etc/letsencrypt/live/gomoku.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gomoku.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        # WebSocket 升级（/ws 必需）
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

证书：`sudo certbot --nginx -d gomoku.example.com`。Nginx 反代不需要改后端配置；
WSS 由 `https` 页面自动推导。若前端被单独部署到别的域名，再设置后端的
`CORS_ORIGINS` / `ALLOWED_ORIGINS`。

用 systemd 守护：

```ini
# /etc/systemd/system/gomoku.service
[Unit]
Description=Gomoku game
After=network.target

[Service]
WorkingDirectory=/opt/gomoku/server
Environment=HOST=0.0.0.0
Environment=PORT=8765
Environment=WEB_DIST=/opt/gomoku/web/dist
ExecStart=/opt/gomoku/server/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8765 --workers 1
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now gomoku
```

> ⚠️ 房间状态在进程内存中，**只能跑 1 个 worker / 1 个实例**；
> 不要开 `--workers 4`，也不要多副本无 sticky。需要水平扩展时把房间状态换成
> Redis 再谈多实例。

### 方式四：Docker

```bash
cd gomoku
docker compose up -d --build
# 或
docker build -t gomoku .
docker run -d --name gomoku -p 8765:8765 gomoku
```

## 配置（环境变量）

复制 `.env.example` 为 `.env`（`scripts/start.sh` 会读取；Docker 用 compose 的 `environment`）。
**所有变量都可不设，默认值即可跑。**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址，公网部署必须 `0.0.0.0` |
| `PORT` | `8765` | 监听端口 |
| `WEB_DIST` | `gomoku/web/dist` | 前端静态产物目录；不存在时只提供 API/WS |
| `BOARD_SIZE` | `15` | 棋盘路数（同时下发前端） |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | REST 允许跨域来源，逗号分隔；同源部署可不管 |
| `ALLOWED_ORIGINS` | 空（放行） | WS 握手 Origin 白名单，公网建议设为你的域名 |
| `ROOM_TTL_SECONDS` | `21600` | waiting 房间空闲回收时间（6 小时） |
| `DISCONNECT_GRACE_SECONDS` | `60` | 掉线保留席位时间 |

## 测试

```bash
# 1) 后端单元 + WebSocket 集成测试（50 个用例）
cd server && .venv/bin/python -m pytest -q

# 2) 端到端：真实启动服务后，用两个 WebSocket 客户端打完整对局（14 项检查）
cd ../..   # 回到 gomoku/
server/.venv/bin/python scripts/e2e.py --url http://127.0.0.1:8765

# 3) 前端类型检查 + 生产构建
cd web && npx tsc --noEmit && npm run build
```

浏览器 UI 冒烟（可选，需要本机 Chrome；不参与运行时依赖）：

```bash
python3 -m venv /tmp/pwenv && /tmp/pwenv/bin/pip install playwright
cd gomoku
/tmp/pwenv/bin/python scripts/ui_smoke.py --url http://127.0.0.1:8765
```

它会开两个独立浏览器上下文，真实走完「建房 → 邀请链接加入 → 双方准备 →
九手五连 → 再来一局换色 → 聊天 → 刷新断线重连 → 移动端视图」，
并断言零控制台错误、截图输出到 `/tmp/gomoku-ui/`。

## REST / 协议

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（uptime、房间数、连接数） |
| GET | `/api/rooms` | 公开房间列表 |
| GET | `/api/config` | 协议版本、棋盘大小等前端配置 |
| WS | `/ws` | 全部游戏逻辑，消息格式见 [`PROTOCOL.md`](./PROTOCOL.md) |

## 设计与实现要点

- **服务端裁决**：落子合法性、回合、五连、和棋、房间状态机全在 `server/app/game.py`
  与 `server/app/rooms.py`；前端不做任何规则判断，只渲染服务端下发的快照。
- **全量快照 + 增量事件**：每次房间变化广播完整 `room` 快照（含棋盘、聊天），
  前端无状态回放压力；聊天另有 `chat` 事件用于即时追加（按 id 去重）。
- **重连**：`welcome` 下发 `playerId` + 一次性 `token`，重连发 `hello` 恢复；
  掉线 60s 内座位保留，对手界面显示掉线状态。
- **安全**：昵称/房间名/聊天长度与空白校验、每连接消息限流、发送锁、
  token 不进入任何广播、WS Origin 白名单可选、无 SQL/无文件写入。

## 已知边界

- 单实例内存态，重启后房间丢失（休闲棋局可接受）。
- 无账号体系，昵称仅用于展示，token 只用于断线重连身份。
- 不含观战、悔棋、计时器；如需可在协议 v2 上扩展。
