# Linux Dedi 服务器部署指南（systemd + Caddy）

本指南面向**个人多设备（Windows / macOS 等）统一入口**场景：
- 网关本身仅监听服务器本机 `127.0.0.1:4000`，由 **Caddy** 自动申请并续期 HTTPS 证书对外提供服务。
- 管理台（Web Admin）保持仅监听 `127.0.0.1:48731`，**不暴露到公网**，需要查看统计或改配置时通过 **SSH 端口转发** 或 **Tailscale** 访问。
- 网关已内置服务器部署加固：自动剥离 Caddy / Nginx / Cloudflare 注入的代理与 `cf-*` 头、公网未鉴权 `/health` 仅返回 `{ "status": "ok" }`、强校验 `clientToken`、支持优雅停机排空在途流式请求。

---

## 1. 服务器前置条件

- Linux（Debian / Ubuntu 等带 `systemd` 的发行版）
- **Node.js ≥ 20**（推荐 Node 22 LTS）
- 一个解析到本机公网 IP 的域名（例如 `gw.example.com`，开放 TCP `80` 和 `443` 端口给 Caddy 自动签发 Let's Encrypt 证书）
  - 如果域名托管在 Cloudflare，**建议先关闭橙色云朵（DNS Only）**：Cloudflare 免费版默认 100 秒等待响应头超时，容易截断慢思考模型。

---

## 2. 安装代码与依赖

```bash
sudo useradd -r -m -s /bin/bash slizm   # 或直接使用你现有的非 root 账号
sudo mkdir -p /opt/slizm-gateway
sudo chown -R slizm:slizm /opt/slizm-gateway

sudo -iu slizm
git clone https://github.com/slizm2025/slizm-gateway.git /opt/slizm-gateway
cd /opt/slizm-gateway
npm ci --omit=dev
```

---

## 3. 准备配置文件（`.env` 与 `providers.json`）

```bash
cp .env.example .env
cp providers.example.json providers.json
chmod 600 .env providers.json
```

1. **生成高强度 `clientToken`**（≥ 24 位随机字符，部署模式会拒绝空值或示例默认值）：
   ```bash
   echo "sk-gw-$(openssl rand -hex 24)"
   ```
   将生成的值填入 `providers.json` 的 `"clientToken"`（或写入 `.env` 的 `GATEWAY_CLIENT_TOKEN=...` 并删掉 `providers.json` 中的 `clientToken`）。
2. **填写上游密钥**：编辑 `.env`，填入你实际使用的上游 API Key（`providers.json` 中用 `"env:变量名"` 引用）。
3. **清理本机代理字段**：如果你从本地 Windows/macOS 复制了 `providers.json`，请检查并移除指向本机代理端口（如 `http://127.0.0.1:7890`）的 `proxy` 字段。
4. **离线自检配置与测试**：
   ```bash
   node -e "import('./src/config.js').then((m) => { const c = m.loadConfig(); console.log('OK:', c.providers.size, 'providers,', c.routes.size, 'routes'); })"
   ```

---

## 4. 配置 systemd 常驻服务

退出 `slizm` 回到具备 `sudo` 权限的账号：

```bash
sudo cp /opt/slizm-gateway/deploy/slizm-gateway.service /etc/systemd/system/
# 按需修改 User / Group / WorkingDirectory（若路径不是 /opt/slizm-gateway）
sudo nano /etc/systemd/system/slizm-gateway.service

sudo systemctl daemon-reload
sudo systemctl enable --now slizm-gateway
sudo systemctl status slizm-gateway
```

（可选）如果你希望在服务器上也常驻管理台 Web（仅本机监听）：
```bash
sudo cp /opt/slizm-gateway/deploy/slizm-gateway-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now slizm-gateway-web
```

---

## 5. 安装并配置 Caddy（自动 HTTPS）

参考 Caddy 官方源安装后，将示例配置合并到 `/etc/caddy/Caddyfile`：

```bash
cat /opt/slizm-gateway/deploy/Caddyfile.example
sudo nano /etc/caddy/Caddyfile   # 把 gw.example.com 改为你的真实域名
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 验证公网与鉴权隔离

```bash
# 1. 公网未鉴权 /health 应只返回 {"status":"ok"}，不暴露路由与上游 baseUrl
curl -s https://gw.example.com/health
# 期望输出: {"status":"ok"}

# 2. 公网未鉴权 / 应返回 404
curl -i -s https://gw.example.com/ | head -n 1

# 3. 携带 clientToken 访问 /v1/models 应返回 200 与路由列表
curl -s -H "Authorization: Bearer <你的clientToken>" https://gw.example.com/v1/models
```

---

## 6. 远程访问管理台（仅 SSH 隧道 / Tailscale）

> **安全提醒**：管理台（`48731`）为本机自举设计，**绝对不要**通过 Caddy/Nginx 暴露到公网。

在你的 Windows（PowerShell / Windows Terminal）或 macOS 终端执行：

```bash
ssh -N -L 48731:127.0.0.1:48731 user@your-dedi-ip
```

然后在本地浏览器打开 `http://127.0.0.1:48731/` 即可安全查看运行概览、用量趋势与修改 `providers.json`（保存后会自动热更新网关配置，无需重启）。

---

## 7. 多设备客户端配置（Windows / macOS）

### Claude Code

在每台设备的 `~/.claude/settings.json`（Windows 为 `%USERPROFILE%\.claude\settings.json`）中配置：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://gw.example.com",
    "ANTHROPIC_AUTH_TOKEN": "<你的clientToken>"
  }
}
```

### Codex CLI

在每台设备的 `~/.codex/config.toml` 中将自定义 provider 的 `base_url` 指向 `https://gw.example.com/v1`，并把对应环境变量（如 `OPENAI_API_KEY` 或你配置的 `env_key`）设为 `<你的clientToken>`（走 `/v1/responses`）。

### DeepSeek Harness

将 provider 端点指向 `https://gw.example.com`，凭据填写 `<你的clientToken>`（支持 `x-api-key`、`Authorization: Bearer` 与 `x-dsh-auth-token`）。

---

## 8. 日常运维命令

```bash
# 实时查看日志（由 journald 自动管理轮转，不会撑爆磁盘）
sudo journalctl -u slizm-gateway -f

# 更新到最新版本并平滑重启（最多等待 60s 排空在途请求）
sudo -iu slizm bash -lc 'cd /opt/slizm-gateway && git pull --ff-only && npm ci --omit=dev'
sudo systemctl restart slizm-gateway
```
