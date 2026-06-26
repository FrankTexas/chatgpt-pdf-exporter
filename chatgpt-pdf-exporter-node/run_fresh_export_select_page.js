const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
let puppeteer = null;

// 用脚本所在目录作为项目目录，避免用户从别的目录启动时路径错乱。
const ROOT = __dirname;
const CAPTURE_DIR = path.join(ROOT, "captures");
const LOG_DIR = path.join(ROOT, "logs");

fs.mkdirSync(CAPTURE_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = path.join(LOG_DIR, "fresh_export_select_log.txt");

const REQUIRED_RUNTIME_DEPS = ["puppeteer-core"];

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function hasCommand(cmd, args = ["--version"]) {
  const result = childProcess.spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "ignore",
    shell: false
  });

  return !result.error && result.status === 0;
}

function canResolvePackage(packageName) {
  try {
    require.resolve(packageName, { paths: [ROOT] });
    return true;
  } catch (_) {
    return false;
  }
}

function assertSupportedNode() {
  const major = Number(String(process.versions.node || "0").split(".")[0]);

  if (!Number.isFinite(major) || major < 18) {
    throw new Error(
      "当前 Node.js 版本过低：" + process.version + "。请安装 Node.js 18 LTS 或更高版本后再运行。"
    );
  }
}

function ensureDependencies() {
  const missing = REQUIRED_RUNTIME_DEPS.filter(dep => !canResolvePackage(dep));
  const nodeModulesDir = path.join(ROOT, "node_modules");
  const packageJsonPath = path.join(ROOT, "package.json");
  const shouldInstall = missing.length > 0 || !fs.existsSync(nodeModulesDir);

  if (!shouldInstall) {
    ok("依赖检查通过");
    return;
  }

  warn("检测到首次运行或依赖缺失。缺少依赖：" + (missing.join(", ") || "node_modules"));
  warn("正在自动安装依赖，请保持网络畅通。首次运行可能需要 1-5 分钟。");

  const npm = npmCommand();

  if (!hasCommand(npm)) {
    throw new Error("找不到 npm。请重新安装 Node.js 18 LTS 或更高版本，并确认安装时勾选 npm。");
  }

  const args = fs.existsSync(packageJsonPath)
    ? ["install", "--no-audit", "--no-fund"]
    : ["install", "--no-audit", "--no-fund", ...REQUIRED_RUNTIME_DEPS];

  log("执行命令：" + npm + " " + args.join(" "));

  const result = childProcess.spawnSync(npm, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: false
  });

  if (result.error) {
    throw new Error("依赖安装启动失败：" + result.error.message);
  }

  if (result.status !== 0) {
    throw new Error(
      "依赖安装失败。你可以在项目目录手动执行：npm install --no-audit --no-fund"
    );
  }

  const stillMissing = REQUIRED_RUNTIME_DEPS.filter(dep => !canResolvePackage(dep));

  if (stillMissing.length > 0) {
    throw new Error("依赖安装后仍缺少：" + stillMissing.join(", "));
  }

  ok("依赖安装完成");
}

function loadPuppeteer() {
  if (!puppeteer) {
    ensureDependencies();
    puppeteer = require(require.resolve("puppeteer-core", { paths: [ROOT] }));
  }

  return puppeteer;
}

function log(...args) {
  const line = args.join(" ");
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
}

function ok(msg) {
  log("✅", msg);
}

function warn(msg) {
  log("⚠️ ", msg);
}

function fail(msg) {
  log("❌", msg);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ask(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    process.stdin.once("data", data => resolve(data.toString().trim()));
  });
}

function extractConversationId(url) {
  const m = String(url || "").match(/\/c\/([^/?#]+)/);
  return m ? m[1] : null;
}

function findChrome() {
  const candidates = [
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
  ];

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  return null;
}

async function isPortReady() {
  try {
    const r = await fetch("http://127.0.0.1:9222/json/version");
    const text = await r.text();
    return r.ok && text.includes("webSocketDebuggerUrl");
  } catch (_) {
    return false;
  }
}

async function startChromeIfNeeded() {
  if (await isPortReady()) {
    ok("Chrome 调试端口 9222 已开启");
    return;
  }

  warn("Chrome 调试端口 9222 未开启，正在启动调试版 Chrome");

  const chrome = findChrome();

  if (!chrome) {
    throw new Error("找不到 Google Chrome。");
  }

  const profileDir = path.join(ROOT, "chrome-profile-debug");

  const args = [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank"
  ];

  const child = childProcess.spawn(chrome, args, {
    detached: true,
    stdio: "ignore"
  });

  child.unref();

  for (let i = 0; i < 30; i++) {
    if (await isPortReady()) {
      ok("调试版 Chrome 启动成功");
      return;
    }
    await sleep(1000);
  }

  throw new Error("Chrome 已启动，但 9222 调试端口不可用。");
}

async function connectBrowser() {
  const puppeteerCore = loadPuppeteer();

  const browser = await puppeteerCore.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null
  });

  ok("已连接 Chrome");
  return browser;
}

async function selectPage(browser) {
  while (true) {
    const pages = await browser.pages();

    log("");
    log("当前 Chrome 页面：");
    log("----------------------------------------");

    const pageInfos = [];

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      let title = "";

      try {
        title = await page.title();
      } catch (_) {
        title = "";
      }

      const url = page.url();
      const conversationId = extractConversationId(url);

      pageInfos.push({
        index: i,
        page,
        title,
        url,
        conversationId
      });

      const mark = conversationId ? " ✅ ChatGPT对话页" : "";
      log(`${i}. ${title || "(无标题)"}${mark}`);
      log(`   ${url}`);
    }

    log("----------------------------------------");
    log("");
    log("请输入你要导出的页面编号。");
    log("说明：必须选择地址类似 https://chatgpt.com/c/xxxxx 的页面。");
    log("输入 r 可以刷新页面列表。");
    log("");

    const input = await ask("页面编号 / r：");

    if (input.toLowerCase() === "r") {
      continue;
    }

    const index = Number(input);

    if (!Number.isInteger(index) || index < 0 || index >= pageInfos.length) {
      warn("编号无效，请重新输入。");
      continue;
    }

    const selected = pageInfos[index];

    if (!selected.conversationId) {
      warn("你选择的不是具体 ChatGPT 对话页面。");
      warn("请先在 Chrome 里打开目标对话，地址应类似：https://chatgpt.com/c/xxxxx");
      continue;
    }

    await selected.page.bringToFront();

    ok("已选择页面：");
    log(selected.title || "(无标题)");
    log(selected.url);
    log("conversationId：" + selected.conversationId);

    return selected;
  }
}

async function captureConversationJson(page, conversationId) {
  log("");
  log("开始抓取所选页面的聊天 JSON...");

  for (const f of fs.readdirSync(CAPTURE_DIR)) {
    if (f.endsWith(".txt") || f.endsWith(".json")) {
      fs.rmSync(path.join(CAPTURE_DIR, f), { force: true });
    }
  }

  const client = await page.target().createCDPSession();

  await client.send("Network.enable");
  await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  await client.send("Network.setBypassServiceWorker", { bypass: true });

  const requests = new Map();
  let captured = null;

  client.on("Network.responseReceived", event => {
    const url = event.response.url || "";

    const isTarget =
      url.includes("/backend-api/conversation/") &&
      url.includes(conversationId) &&
      !url.includes("/stream_status") &&
      !url.includes("/textdocs");

    if (!isTarget) return;

    requests.set(event.requestId, {
      url,
      status: event.response.status,
      mimeType: event.response.mimeType || "",
      type: event.type || ""
    });
  });

  client.on("Network.loadingFinished", async event => {
    if (captured) return;

    const meta = requests.get(event.requestId);
    if (!meta) return;

    try {
      const result = await client.send("Network.getResponseBody", {
        requestId: event.requestId
      });

      let body = result.body || "";

      if (result.base64Encoded) {
        body = Buffer.from(body, "base64").toString("utf8");
      }

      if (body.includes('"mapping"') && body.includes('"conversation_id"')) {
        captured = {
          meta,
          body
        };
      }
    } catch (_) {}
  });

  log("刷新所选页面以触发 conversation JSON 请求...");

  await page.reload({
    waitUntil: "domcontentloaded",
    timeout: 60000
  }).catch(e => {
    warn("页面刷新警告：" + e.message);
  });

  for (let i = 0; i < 120; i++) {
    if (captured) break;
    await sleep(500);
  }

  try {
    await client.detach();
  } catch (_) {}

  if (!captured) {
    throw new Error("没有抓到 conversation JSON。请确认所选页面已经完整加载。");
  }

  const jsonPath = path.join(CAPTURE_DIR, "conversation_json.txt");

  const wrapped = [
    "URL: " + captured.meta.url,
    "STATUS: " + captured.meta.status,
    "TYPE: " + captured.meta.type,
    "MIME: " + captured.meta.mimeType,
    "",
    captured.body
  ].join("\n");

  fs.writeFileSync(jsonPath, wrapped, "utf8");

  const summary = [
    "#1",
    "score: 999",
    "length: " + captured.body.length,
    "type: " + captured.meta.type,
    "mime: " + captured.meta.mimeType,
    "url: " + captured.meta.url,
    "file: " + jsonPath,
    ""
  ].join("\n");

  fs.writeFileSync(path.join(CAPTURE_DIR, "summary.txt"), summary, "utf8");

  ok("聊天 JSON 已抓取");
  log("保存位置：" + jsonPath);
  log("长度：" + captured.body.length);

  return jsonPath;
}

function extractJsonText(raw) {
  raw = String(raw || "");

  if (raw.trim().startsWith("{")) {
    return raw.trim();
  }

  const idx = raw.indexOf("\n{");
  if (idx >= 0) {
    return raw.slice(idx + 1).trim();
  }

  const first = raw.indexOf("{");
  if (first >= 0) {
    return raw.slice(first).trim();
  }

  return "";
}

function getCurrentBranch(data) {
  const mapping = data.mapping || {};
  const currentNode = data.current_node || data.current_node_id;

  if (!currentNode || !mapping[currentNode]) {
    return Object.values(mapping)
      .filter(x => x && x.message)
      .sort((a, b) => {
        const ta = a.message?.create_time || 0;
        const tb = b.message?.create_time || 0;
        return ta - tb;
      });
  }

  const chain = [];
  let id = currentNode;

  while (id && mapping[id]) {
    chain.push(mapping[id]);
    id = mapping[id].parent;
  }

  return chain.reverse();
}

function contentText(content) {
  if (!content) return "";

  if (typeof content === "string") return content;

  if (content.text) return String(content.text);

  if (Array.isArray(content.parts)) {
    return content.parts.map(part => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        if (part.text) return part.text;
        if (part.name) return "[附件：" + part.name + "]";
        if (part.file_id) return "[文件：" + part.file_id + "]";
        if (part.asset_pointer) return "[图片：" + part.asset_pointer + "]";
      }
      return "";
    }).join("\n");
  }

  return "";
}

function looksInternalToolMessage(msg) {
  const role = msg.author?.role || "";
  const raw = JSON.stringify(msg.content || {});
  const channel = msg.channel || "";
  const recipient = msg.recipient || "";
  const contentType = msg.content?.content_type || "";

  if (role !== "assistant") return false;

  if (channel && channel !== "final") return true;
  if (recipient && recipient !== "all") return true;

  const toolKeys = [
    "system1_search_query",
    "calculator",
    "weather",
    "finance",
    "sports",
    "open",
    "screenshot",
    "response_length",
    "web.run",
    "tool_"
  ];

  if (toolKeys.some(k => raw.includes(k))) return true;

  if (contentType && !["text", "multimodal_text"].includes(contentType)) {
    return true;
  }

  return false;
}

function checkConversationJson(jsonPath) {
  log("");
  log("开始检查聊天 JSON...");

  const raw = fs.readFileSync(jsonPath, "utf8");
  const jsonText = extractJsonText(raw);
  const data = JSON.parse(jsonText);

  if (!data.mapping || typeof data.mapping !== "object") {
    throw new Error("JSON 中没有 mapping，不能作为聊天记录导出。");
  }

  const mapping = data.mapping;
  const allNodes = Object.values(mapping).filter(x => x && x.message);
  const branch = getCurrentBranch(data);

  let visible = 0;
  let internal = 0;
  let hidden = 0;
  let media = 0;

  const roleCount = {};

  for (const node of branch) {
    const msg = node.message;
    if (!msg) continue;

    const role = msg.author?.role || "unknown";
    roleCount[role] = (roleCount[role] || 0) + 1;

    if (msg.metadata?.is_visually_hidden_from_conversation) {
      hidden++;
      continue;
    }

    if (looksInternalToolMessage(msg)) {
      internal++;
      continue;
    }

    if (!["user", "assistant"].includes(role)) continue;

    const text = contentText(msg.content).trim();
    const attachments = msg.metadata?.attachments || [];
    const rawContent = JSON.stringify(msg.content || {});
    const fileMatches = rawContent.match(/file_[a-zA-Z0-9]+/g) || [];

    media += attachments.length + fileMatches.length;

    if (text || attachments.length > 0 || fileMatches.length > 0) {
      visible++;
    }
  }

  log("标题：" + (data.title || "(无标题)"));
  log("conversationId：" + (data.conversation_id || data.id || "(未知)"));
  log("mapping 节点数：" + Object.keys(mapping).length);
  log("全部 message 节点数：" + allNodes.length);
  log("当前分支节点数：" + branch.length);
  log("可导出消息数：" + visible);
  log("内部工具消息数：" + internal);
  log("隐藏消息数：" + hidden);
  log("疑似图片/附件数量：" + media);
  log("角色统计：" + JSON.stringify(roleCount));

  if (visible <= 0) {
    throw new Error("聊天 JSON 抓到了，但可导出消息数为 0。");
  }

  ok("聊天 JSON 检查通过");

  return {
    title: data.title || "",
    visible,
    media
  };
}

function runJsonToPdf() {
  log("");
  log("开始生成 PDF...");

  const script = path.join(ROOT, "run_json_to_pdf_pick_output.js");

  if (!fs.existsSync(script)) {
    throw new Error("找不到 run_json_to_pdf_pick_output.js");
  }

  const result = childProcess.spawnSync(
    "node",
    [script],
    {
      cwd: ROOT,
      stdio: "inherit"
    }
  );

  if (result.status !== 0) {
    throw new Error("PDF 生成脚本运行失败。");
  }
}

async function main() {
  fs.writeFileSync(LOG_FILE, "", "utf8");

  log("========================================");
  log("ChatGPT 半自动选择窗口导出");
  log("========================================");
  log("项目目录：" + ROOT);
  log("日志文件：" + LOG_FILE);
  log("");

  ok("Node 版本：" + process.version);
  assertSupportedNode();
  ensureDependencies();

  await startChromeIfNeeded();

  const browser = await connectBrowser();

  try {
    const selected = await selectPage(browser);

    const jsonPath = await captureConversationJson(selected.page, selected.conversationId);

    const result = checkConversationJson(jsonPath);

    log("");
    log("JSON 抓取与检查完成。");
    log("可导出消息数：" + result.visible);
    log("疑似图片/附件数量：" + result.media);

    runJsonToPdf();

    log("");
    log("========================================");
    log("SUCCESS");
    log("已完成：选择窗口 → 抓取最新 JSON → 检查 → 生成 PDF");
    log("========================================");
  } finally {
    await browser.disconnect().catch(() => {});
  }
}

main().catch(err => {
  log("");
  log("========================================");
  log("FAILED");
  log(String(err.stack || err.message || err));
  log("========================================");
  process.exit(1);
});
