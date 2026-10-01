import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/config.js";

const html = readFileSync(join(ROOT, "src", "admin", "public", "index.html"), "utf8");
const subagents = existsSync(join(ROOT, "src", "admin", "public", "subagents.js"))
  ? readFileSync(join(ROOT, "src", "admin", "public", "subagents.js"), "utf8")
  : "";

let mockSettings = {
  revision: "mock-preview-rev-1",
  defaultRoute: "anthropic-main",
  logRequests: true,
  providers: [
    {
      name: "anthropic-main",
      apiType: "anthropic",
      baseUrl: "https://api.anthropic.com",
      clientProfile: "auto",
      hasApiKey: true,
      maxConcurrency: 10,
      maxAttempts: 3,
      connectTimeoutMs: 5000,
      requestTimeoutMs: 60000,
      models: { "claude-3-5-sonnet": "claude-3-5-sonnet-20241022", "claude-3-5-haiku": "claude-3-5-haiku-20241022" },
      priceMultipliers: { "*": { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }
    },
    {
      name: "openai-backup",
      apiType: "openai",
      baseUrl: "https://api.openai.com/v1",
      clientProfile: "codex",
      hasApiKey: true,
      maxConcurrency: 8,
      maxAttempts: 2,
      connectTimeoutMs: 4000,
      requestTimeoutMs: 45000,
      models: { "gpt-4o": "gpt-4o-2024-08-06" },
      priceMultipliers: { "*": { input: 0.8, output: 0.8, cacheRead: 0.8, cacheWrite: 0.8 } }
    }
  ],
  routes: [
    { alias: "claude-fast", provider: "anthropic-main", model: "claude-3-5-haiku", clientProfile: "auto" },
    { alias: "claude-smart", provider: "anthropic-main", model: "claude-3-5-sonnet", clientProfile: "auto" },
    { alias: "codex-default", provider: "openai-backup", model: "gpt-4o", clientProfile: "codex" }
  ],
  pricing: {
    "claude-3-5-sonnet-20241022": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    "gpt-4o-2024-08-06": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 }
  }
};

const server = http.createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const url = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (url === "/" || url === "/index.html") {
    // 注入自动切换到设置页的逻辑，完全运行原生 app.js
    const autoScript = "<script>window.addEventListener('load', () => { setTimeout(() => { if (typeof switchView === 'function') switchView('settings'); else { const t = document.getElementById('tab-settings'); if (t) t.click(); } if (window.location.search.includes('edit=1')) { setTimeout(() => { const b = document.getElementById('btn-edit-settings'); if (b) b.click(); }, 120); } }, 60); });</script>";
    const servedHtml = html.replace("</body>", autoScript + "</body>");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(servedHtml);
  } else if (url === "/style.css") {
    res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
    res.end(readFileSync(join(ROOT, "src", "admin", "public", "style.css"), "utf8"));
  } else if (url === "/app.js") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(readFileSync(join(ROOT, "src", "admin", "public", "app.js"), "utf8"));
  } else if (url === "/subagents.js") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(subagents);
  } else if (url.startsWith("/api/session")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
  } else if (url.startsWith("/api/settings")) {
    if (req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          mockSettings = { ...mockSettings, ...parsed, revision: "mock-preview-rev-" + Date.now() };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...mockSettings, reloadApplied: true, restartRequired: false }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(mockSettings));
  } else {
    // 其他 overview / switchboard / logs 等端点统一返回有效在线数据，避免 401 阻断认证
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      gateway: { online: true },
      total: { baseCostUsd: 0, costUsd: 0 },
      providerNames: ["anthropic-main", "openai-backup"],
      trend: [],
      inflight: [],
      providers: [],
      models: [],
      recent: [],
      lines: [],
      switchboardActive: [],
      switchboardTopology: [],
      switchboardConfigured: []
    }));
  }
});

const PORT = 48899;
server.listen(PORT, "127.0.0.1", () => {
  console.log("Mock preview server listening on http://127.0.0.1:" + PORT);
});
