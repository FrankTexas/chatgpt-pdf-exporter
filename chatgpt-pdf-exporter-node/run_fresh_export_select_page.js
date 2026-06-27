const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
let puppeteer = null;

// 用脚本所在目录作为项目目录，避免用户从别的目录启动时路径错乱。
const ROOT = __dirname;
const CAPTURE_DIR = path.join(ROOT, "captures");
const LOG_DIR = path.join(ROOT, "logs");
const ASSET_DIR = path.join(CAPTURE_DIR, "assets");

fs.mkdirSync(CAPTURE_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = path.join(LOG_DIR, "fresh_export_select_log.txt");

const REQUIRED_RUNTIME_DEPS = ["puppeteer-core"];
const TOOL_VERSION = "v28-force-exit-autoclose";

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

function debugLog(...args) {
  if (process.env.CHATGPT_EXPORT_DEBUG === "1") {
    log(...args);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatClockTime(date = new Date()) {
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function ask(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    process.stdin.once("data", data => resolve(data.toString().trim()));
  });
}

async function askContinueExport() {
  while (true) {
    log("");
    log("下一步：");
    log("1. 继续导出其他 ChatGPT 对话");
    log("0. 退出程序并关闭窗口");
    log("");

    const input = (await ask("请选择 1 / 0（直接回车退出并关闭窗口）：")).trim().toLowerCase();

    if (input === "" || input === "0" || input === "q" || input === "quit" || input === "exit" || input === "n" || input === "no") {
      return false;
    }

    if (input === "1" || input === "c" || input === "continue" || input === "y" || input === "yes") {
      return true;
    }

    warn("输入无效，请输入 1 继续，或输入 0 退出。");
  }
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
  let refreshCount = 0;
  let refreshedAt = "";

  while (true) {
    const pages = await browser.pages();

    log("");
    log("========================================");
    if (refreshCount > 0) {
      ok("页面列表已刷新");
      log("刷新次数：" + refreshCount + "    时间：" + refreshedAt);
    } else {
      log("当前 Chrome 页面");
    }
    log("========================================");

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
    log("请输入页面编号导出。");
    log("输入 r 刷新页面列表，输入 0/1/2... 选择页面。");
    log("");

    const input = await ask("页面编号 / r：");
    const normalized = input.trim().toLowerCase();

    if (normalized === "r" || normalized === "refresh") {
      refreshCount += 1;
      refreshedAt = formatClockTime();

      log("");
      log("========================================");
      log("正在刷新页面列表...");
      log("请稍等，刷新完成后会重新显示当前 Chrome 页面。");
      log("========================================");
      log("");

      await sleep(500);
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

  fs.rmSync(ASSET_DIR, { recursive: true, force: true });
  fs.mkdirSync(ASSET_DIR, { recursive: true });

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


function pathToFileUrl(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, "/");
  return "file:///" + encodeURI(resolved);
}

function safeFilename(name, fallback = "asset") {
  const raw = String(name || fallback)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\r\n\t]+/g, " ")
    .trim();

  return raw || fallback;
}

function extFromMimeType(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("bmp")) return ".bmp";
  if (mime.includes("avif")) return ".avif";
  if (mime.includes("heic")) return ".heic";
  if (mime.includes("heif")) return ".heif";
  if (mime.includes("tiff") || mime.includes("tif")) return ".tiff";
  if (mime.includes("ico") || mime.includes("x-icon")) return ".ico";
  if (mime.includes("svg")) return ".svg";
  return "";
}

function extFromUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const ext = path.extname(u.pathname || "").toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg", ".avif", ".heic", ".heif", ".tif", ".tiff", ".ico"].includes(ext)) {
      if (ext === ".jpeg") return ".jpg";
      if (ext === ".tif") return ".tiff";
      return ext;
    }
  } catch (_) {}
  return "";
}

function isImageLike(name, mimeType) {
  const n = String(name || "").toLowerCase();
  const m = String(mimeType || "").toLowerCase();
  return m.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif|bmp|svg|avif|heic|heif|tif|tiff|ico)$/i.test(n);
}

function extractPossibleAttachmentUrls(raw) {
  const urls = [];
  const seen = new Set();

  function add(value) {
    const s = String(value || "").trim();
    if (!s) return;

    const looksUrl =
      /^https?:\/\//i.test(s) ||
      s.startsWith("/backend-api/") ||
      s.startsWith("/api/") ||
      s.startsWith("/cdn-cgi/");

    if (!looksUrl) return;
    if (seen.has(s)) return;

    seen.add(s);
    urls.push(s);
  }

  function walk(value, depth = 0) {
    if (!value || depth > 5) return;

    if (typeof value === "string") {
      add(value);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(x => walk(x, depth + 1));
      return;
    }

    if (typeof value === "object") {
      for (const v of Object.values(value)) {
        walk(v, depth + 1);
      }
    }
  }

  walk(raw);
  return urls;
}

function normalizeAttachmentRecord(raw, source, role, messageIndex, messageText, userMessageIndex) {
  if (!raw || typeof raw !== "object") return null;

  const fileId = raw.file_id || raw.fileId || raw.id || raw.fileID || "";
  const name = raw.name || raw.file_name || raw.filename || raw.display_name || raw.title || "";
  const mimeType = raw.mime_type || raw.mimeType || raw.content_type || raw.contentType || raw.type || "";

  if (!fileId && !name) return null;

  return {
    fileId: String(fileId || ""),
    name: String(name || ""),
    mimeType: String(mimeType || ""),
    source,
    role,
    messageIndex,
    userMessageIndex,
    messageTextSnippet: String(messageText || "").replace(/\s+/g, " ").slice(0, 240),
    possibleUrls: extractPossibleAttachmentUrls(raw),
    isImage: isImageLike(name, mimeType)
  };
}

function pushUniqueAttachment(list, seen, record) {
  if (!record) return;
  const key = (record.fileId || "") + "|" + (record.name || "") + "|" + (record.source || "");
  if (seen.has(key)) return;
  seen.add(key);
  list.push(record);
}

function collectAttachmentRecordsFromConversation(data) {
  const branch = getCurrentBranch(data);
  const records = [];
  const seen = new Set();
  let userMessageIndex = -1;

  for (let i = 0; i < branch.length; i++) {
    const msg = branch[i]?.message;
    if (!msg) continue;

    const role = msg.author?.role || "unknown";
    if (role === "user") userMessageIndex++;

    const messageText = contentText(msg.content);
    const attachments = Array.isArray(msg.metadata?.attachments) ? msg.metadata.attachments : [];

    for (const a of attachments) {
      pushUniqueAttachment(records, seen, normalizeAttachmentRecord(a, "metadata.attachments", role, i, messageText, userMessageIndex));
    }

    const parts = Array.isArray(msg.content?.parts) ? msg.content.parts : [];
    for (const part of parts) {
      if (part && typeof part === "object") {
        pushUniqueAttachment(records, seen, normalizeAttachmentRecord(part, "content.parts", role, i, messageText, userMessageIndex));
      }
    }
  }

  return records;
}

async function waitForChatContentReady(page, timeoutMs = 20000) {
  log("等待 ChatGPT 聊天正文加载完成...");

  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const info = await page.evaluate(() => {
      const messages = Array.from(document.querySelectorAll("[data-message-author-role], article"));

      const main =
        document.querySelector("main#main") ||
        document.querySelector("main") ||
        document.querySelector("[role='main']");

      return {
        messageCount: messages.length,
        userMessageCount: messages.filter(x => x.getAttribute("data-message-author-role") === "user").length,
        mainScrollHeight: main ? main.scrollHeight : 0,
        mainClientHeight: main ? main.clientHeight : 0,
        bodyScrollHeight: document.body ? document.body.scrollHeight : 0,
        viewportHeight: window.innerHeight || 0
      };
    }).catch(() => null);

    if (
      info &&
      info.messageCount > 0 &&
      (
        info.mainScrollHeight > info.mainClientHeight + 50 ||
        info.bodyScrollHeight > info.viewportHeight + 50
      )
    ) {
      ok(
        "聊天正文已加载：messages=" + info.messageCount +
        " userMessages=" + info.userMessageCount +
        " main=" + info.mainScrollHeight + "/" + info.mainClientHeight
      );
      return info;
    }

    await sleep(500);
  }

  warn("等待聊天正文加载超时，将继续尝试滚动。");
  return null;
}

async function scrollPageToLoadImages(page, options = {}) {
  const settleDelay = options.settleDelay || 1200;
  const stepDelay = options.stepDelay || 650;
  const direction = options.direction || "down";

  log("滚动聊天正文：" + direction);

  const result = await page.evaluate(async ({ direction, stepDelay, settleDelay }) => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    function rectInfo(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();

      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        height: Math.round(r.height)
      };
    }

    const rawMessages = Array.from(document.querySelectorAll("[data-message-author-role], article"))
      .filter(el => {
        const r = el.getBoundingClientRect();
        const text = String(el.innerText || "").trim();

        // 排除侧栏/空节点；正文消息通常有高度或文本。
        if (el.closest("aside, nav")) return false;
        if (r.height < 10 && !text) return false;

        return true;
      });

    // 去重：有些 article 内外层都会命中，保留更靠内或有 role 的节点。
    const messages = [];
    const seen = new Set();

    for (const el of rawMessages) {
      const key = (el.getAttribute("data-message-id") || "") + "|" +
        (el.getAttribute("data-message-author-role") || "") + "|" +
        String(el.innerText || "").slice(0, 80);

      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(el);
    }

    if (messages.length === 0) {
      return {
        ok: false,
        reason: "没有找到聊天消息节点"
      };
    }

    const ordered = direction === "up"
      ? messages.slice().reverse()
      : messages.slice();

    const beforeFirst = rectInfo(messages[0]);
    const beforeLast = rectInfo(messages[messages.length - 1]);


    // 关键改动：不再改 scrollTop，不再 wheel。
    // 直接让每条正文消息 scrollIntoView，这会让浏览器自己滚动正确的祖先容器。
    // direction=up 时从最后一条消息开始往第一条消息滚，确保有真实“向上滚”的过程。
    for (let i = 0; i < ordered.length; i++) {
      const msg = ordered[i];

      try {
        msg.scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: "instant"
        });
      } catch (_) {
        try {
          msg.scrollIntoView(false);
        } catch (_) {}
      }

      window.dispatchEvent(new Event("scroll"));
      msg.dispatchEvent(new Event("scroll", { bubbles: true }));

      await wait(stepDelay);
    }

    await wait(settleDelay);

    const afterFirst = rectInfo(messages[0]);
    const afterLast = rectInfo(messages[messages.length - 1]);

    const main =
      document.querySelector("main#main") ||
      document.querySelector("main") ||
      document.querySelector("[role='main']");

    return {
      ok: true,
      direction,
      messageCount: messages.length,
      userMessageCount: messages.filter(x => x.getAttribute("data-message-author-role") === "user").length,
      beforeFirst,
      beforeLast,
      afterFirst,
      afterLast,
      main: main ? {
        tag: main.tagName,
        id: main.id || "",
        className: String(main.className || "").slice(0, 160),
        scrollTop: main.scrollTop || 0,
        scrollHeight: main.scrollHeight || 0,
        clientHeight: main.clientHeight || 0
      } : null
    };
  }, { direction, stepDelay, settleDelay }).catch(e => {
    warn("按消息节点滚动时出现警告：" + e.message);
    return null;
  });

  if (result) {
    if (!result.ok) {
      warn("按消息节点滚动失败：" + result.reason);
    } else {
      log("滚动完成：" + result.direction + "，消息 " + result.messageCount + " 条");
    }
  }
}

async function collectDomImageCandidates(page) {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll("img")).map((img, index) => {
      const rect = img.getBoundingClientRect();
      const article = img.closest("article") || img.closest('[data-message-author-role]');
      const roleNode = img.closest('[data-message-author-role]');

      return {
        index,
        src: img.currentSrc || img.src || "",
        alt: img.alt || "",
        width: img.naturalWidth || Math.round(rect.width) || 0,
        height: img.naturalHeight || Math.round(rect.height) || 0,
        renderedWidth: Math.round(rect.width) || 0,
        renderedHeight: Math.round(rect.height) || 0,
        role: roleNode ? roleNode.getAttribute("data-message-author-role") || "" : "",
        nearbyText: article ? String(article.innerText || "").slice(0, 300) : ""
      };
    }).filter(x => {
      if (!x.src) return false;
      if (x.src.startsWith("chrome-extension:")) return false;

      // 只保留消息区里的较大图片，过滤头像、logo、图标、表情。
      // 用户头像通常是 80-160px 的小方图，不能当作附件图片保存。
      if (!x.role) return false;
      if (x.width < 220 || x.height < 160) return false;
      if (x.width <= 180 && x.height <= 180) return false;

      const src = String(x.src || "").toLowerCase();
      if (src.includes("avatar") || src.includes("profile") || src.includes("emoji") || src.includes("favicon")) {
        return false;
      }

      return true;
    });
  });
}

async function downloadImageFromPage(page, src) {
  if (!src) throw new Error("图片 src 为空");

  return await page.evaluate(async imageSrc => {
    const response = await fetch(imageSrc, { credentials: "include" });
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " " + response.statusText);
    }

    const contentType = response.headers.get("content-type") || "";
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";

    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }

    return {
      contentType,
      byteLength: bytes.length,
      base64: btoa(binary)
    };
  }, src);
}

function chooseImageCandidatesForAttachments(candidates, imageAttachments) {
  const chosen = [];
  const usedSrc = new Set();

  function scoreCandidate(candidate, attachment) {
    const name = String(attachment.name || "").toLowerCase();
    const fileId = String(attachment.fileId || "").toLowerCase();

    const haystack = [
      candidate.src || "",
      candidate.alt || "",
      candidate.nearbyText || ""
    ].join("\n").toLowerCase();

    let score = 0;

    if (fileId && haystack.includes(fileId)) score += 1000;
    if (name && haystack.includes(name)) score += 800;
    if (candidate.role === "user") score += 100;

    return score;
  }

  for (const attachment of imageAttachments) {
    let best = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      if (!candidate || !candidate.src) continue;
      if (usedSrc.has(candidate.src)) continue;

      const score = scoreCandidate(candidate, attachment);

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    // 只有明确命中附件文件名或 file_id 的 DOM 图片才作为候选。
    // 不按数量、顺序、大小硬猜，避免错图。
    if (best && bestScore > 0) {
      usedSrc.add(best.src);
      chosen.push(best);
    }
  }

  return chosen;
}

function getVerifiedMappedCount(savedImages, imageAttachments) {
  const mapped = mapSavedImagesToAttachments(savedImages, imageAttachments);
  const unique = new Set();

  for (const rec of Object.values(mapped.filesById || {})) {
    if (rec && rec.localPath) unique.add(rec.localPath);
  }

  for (const rec of Object.values(mapped.filesByName || {})) {
    if (rec && rec.localPath) unique.add(rec.localPath);
  }

  return unique.size;
}

function isLikelyUsefulImageUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return false;
  if (u.startsWith("data:")) return false;
  if (u.startsWith("chrome-extension:")) return false;

  // 明确排除 UI 资源：头像、资料图、图标、表情、sprite、favicon。
  const blocked = [
    "favicon",
    "avatar",
    "profile",
    "emoji",
    "sprite",
    "icon",
    "logo",
    "gravatar"
  ];

  if (blocked.some(k => u.includes(k))) return false;
  if (u.endsWith(".svg")) return false;

  return true;
}

function getImageDimensions(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 32) return null;

    // PNG: width/height are big-endian at offset 16/20.
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
        format: "png"
      };
    }

    // JPEG: scan SOF markers.
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;

      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xff) {
          offset++;
          continue;
        }

        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);

        // SOF0 / SOF1 / SOF2 / SOF3 and related markers.
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
            format: "jpg"
          };
        }

        if (!length || length < 2) break;
        offset += 2 + length;
      }
    }

    // WebP VP8X.
    if (
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
      const chunk = buffer.toString("ascii", 12, 16);

      if (chunk === "VP8X" && buffer.length >= 30) {
        const width = 1 + buffer.readUIntLE(24, 3);
        const height = 1 + buffer.readUIntLE(27, 3);
        return { width, height, format: "webp" };
      }

      if (chunk === "VP8 " && buffer.length >= 30) {
        const width = buffer.readUInt16LE(26) & 0x3fff;
        const height = buffer.readUInt16LE(28) & 0x3fff;
        return { width, height, format: "webp" };
      }

      if (chunk === "VP8L" && buffer.length >= 25) {
        const b0 = buffer[21];
        const b1 = buffer[22];
        const b2 = buffer[23];
        const b3 = buffer[24];
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { width, height, format: "webp" };
      }
    }

    // GIF: logical screen width/height at offset 6/8.
    if (
      buffer.toString("ascii", 0, 3) === "GIF" &&
      buffer.length >= 10
    ) {
      return {
        width: buffer.readUInt16LE(6),
        height: buffer.readUInt16LE(8),
        format: "gif"
      };
    }

    // BMP: width/height at offset 18/22.
    if (
      buffer[0] === 0x42 &&
      buffer[1] === 0x4d &&
      buffer.length >= 26
    ) {
      return {
        width: Math.abs(buffer.readInt32LE(18)),
        height: Math.abs(buffer.readInt32LE(22)),
        format: "bmp"
      };
    }

    // ICO: first icon width/height. 0 means 256.
    if (
      buffer.length >= 8 &&
      buffer.readUInt16LE(0) === 0 &&
      buffer.readUInt16LE(2) === 1
    ) {
      const w = buffer[6] || 256;
      const h = buffer[7] || 256;
      return { width: w, height: h, format: "ico" };
    }
  } catch (_) {}

  return null;
}

function guessAssetNameFromUrl(url, fallback) {
  try {
    const u = new URL(String(url || ""));
    const base = path.basename(decodeURIComponent(u.pathname || ""));
    if (base && base.includes(".") && base.length <= 120) return safeFilename(base, fallback);
  } catch (_) {}
  return fallback;
}

function fileIdFromUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const fromQuery = u.searchParams.get("id") || u.searchParams.get("file_id") || "";
    if (/^file_[a-z0-9]+/i.test(fromQuery)) return fromQuery;

    const m = String(url || "").match(/file_[a-z0-9]+/i);
    return m ? m[0] : "";
  } catch (_) {
    const m = String(url || "").match(/file_[a-z0-9]+/i);
    return m ? m[0] : "";
  }
}

function isExactAttachmentUrl(url, imageAttachments) {
  const fileId = fileIdFromUrl(url);
  if (!fileId) return false;

  return (imageAttachments || []).some(att => String(att?.fileId || "") === fileId);
}

function shouldKeepCapturedImage(meta, buffer, imageAttachments = []) {
  const mime = String(meta.mimeType || meta.contentType || "").toLowerCase();
  const url = String(meta.url || "");
  const ext = extFromUrl(url);
  const isImage = mime.startsWith("image/") || !!ext;
  const exactAttachment = isExactAttachmentUrl(url, imageAttachments);

  if (!isImage) return false;
  if (!isLikelyUsefulImageUrl(url) && !exactAttachment) return false;

  // 关键修复：如果 URL 里明确带着当前附件的 file_id，就不能再按“15KB/高度”过滤。
  // 这类截图可能很窄很矮，比如 615x50、412x85，但仍然是用户上传的图片。
  if (exactAttachment) {
    if (!buffer || buffer.length < 512) return false;
    return true;
  }

  if (mime.includes("svg") || ext === ".svg") return false;

  // 非精确附件图继续过滤网页图标、头像、小 logo。
  if (!buffer || buffer.length < 15 * 1024) return false;

  const dim = getImageDimensions(buffer);

  if (dim) {
    if (dim.width <= 180 && dim.height <= 180) return false;
    if (dim.width < 220 && dim.height < 220) return false;
  }

  return true;
}

function mapSavedImagesToAttachments(savedImages, imageAttachments) {
  const filesById = {};
  const filesByName = {};
  const used = new Set();

  const nameCounts = new Map();

  for (const att of imageAttachments || []) {
    const n = String(att?.name || "").trim().toLowerCase();
    if (!n) continue;
    nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
  }

  function score(img, att) {
    let s = 0;
    const url = String(img.url || "").toLowerCase();
    const name = String(att.name || "").toLowerCase();
    const fileId = String(att.fileId || "").toLowerCase();
    const filename = String(img.filename || "").toLowerCase();
    const nearbyText = String(img.domImage?.nearbyText || "").toLowerCase();
    const alt = String(img.domImage?.alt || "").toLowerCase();
    const attachmentName = String(img.attachmentName || "").toLowerCase();
    const attachmentFileId = String(img.attachmentFileId || "").toLowerCase();

    const urlFileId = String(fileIdFromUrl(img.url || "") || "").toLowerCase();
    const haystack = [url, filename, nearbyText, alt, attachmentName, attachmentFileId].join("\n");

    if (fileId && urlFileId === fileId) s += 3000;
    if (fileId && attachmentFileId === fileId) s += 2500;
    if (fileId && haystack.includes(fileId)) s += 1800;

    // 文件名只有唯一时才作为强匹配。image.png 这种重复名不能用来兜底，否则会错配/重复插图。
    const nameUnique = name && (nameCounts.get(name) || 0) === 1;
    if (nameUnique && haystack.includes(name)) s += 700;
    if (nameUnique && filename.includes(name)) s += 500;
    if (nameUnique && attachmentName === name) s += 1200;

    return s;
  }

  for (let i = 0; i < imageAttachments.length; i++) {
    const att = imageAttachments[i];
    let best = null;
    let bestScore = -1;

    for (const img of savedImages) {
      if (used.has(img.localPath)) continue;
      const sc = score(img, att);
      if (sc > bestScore) {
        best = img;
        bestScore = sc;
      }
    }

    if (!best || bestScore <= 0) {
      continue;
    }

    used.add(best.localPath);

    const record = {
      fileId: att.fileId,
      name: att.name || best.filename,
      mimeType: att.mimeType || best.mimeType || "",
      localPath: best.localPath,
      fileUrl: pathToFileUrl(best.localPath),
      relativeToCaptureDir: best.relativeToCaptureDir,
      bytes: best.bytes,
      source: best.source,
      url: best.url
    };

    if (att.fileId) filesById[att.fileId] = record;

    // 只给“唯一文件名”建 name 索引，避免所有 image.png 互相覆盖。
    const n = String(att.name || "").trim().toLowerCase();
    if (att.name && n && (nameCounts.get(n) || 0) === 1) {
      filesByName[att.name] = record;
    }
  }

  return { filesById, filesByName };
}

function imageAttachmentKey(att) {
  const fileId = String(att?.fileId || "").trim();
  if (fileId) return "id:" + fileId;

  const name = String(att?.name || "").trim().toLowerCase();
  const mime = String(att?.mimeType || "").trim().toLowerCase();

  if (name) return "name:" + name + "|" + mime;

  return "";
}

function dedupeImageAttachments(list) {
  const result = [];
  const seen = new Set();

  for (const item of list || []) {
    const key = imageAttachmentKey(item);
    if (!key) continue;
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(item);
  }

  return result;
}

function attachmentMapped(att, mapped) {
  if (!att || !mapped) return false;
  if (att.fileId && mapped.filesById && mapped.filesById[att.fileId]) return true;
  if (att.name && mapped.filesByName && mapped.filesByName[att.name]) return true;
  return false;
}

function getUnmatchedImageAttachments(savedImages, imageAttachments) {
  const mapped = mapSavedImagesToAttachments(savedImages, imageAttachments);
  return imageAttachments.filter(att => !attachmentMapped(att, mapped));
}

async function collectAttachmentCandidatesFromVisibleMessage(page, attachment) {
  const terms = {
    fileId: String(attachment?.fileId || ""),
    name: String(attachment?.name || ""),
    messageTextSnippet: String(attachment?.messageTextSnippet || "").replace(/\s+/g, " ").slice(0, 180),
    userMessageIndex: Number.isFinite(attachment?.userMessageIndex) ? attachment.userMessageIndex : -1
  };

  return await page.evaluate(({ fileId, name, messageTextSnippet, userMessageIndex }) => {
    function normalize(value) {
      return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    }

    function usefulSnippet(text) {
      const t = normalize(text)
        .replace(/\[附件：[^\]]+\]/g, "")
        .replace(/\[文件：[^\]]+\]/g, "")
        .replace(/\[图片：[^\]]+\]/g, "")
        .trim();

      if (t.length <= 8) return "";
      return t.slice(0, 80);
    }

    const nameLower = normalize(name);
    const fileIdLower = normalize(fileId);
    const snippet = usefulSnippet(messageTextSnippet);

    const nodes = Array.from(document.querySelectorAll("[data-message-author-role], article"))
      .filter(el => !el.closest("aside, nav"));

    const userNodes = nodes.filter(el => (el.getAttribute("data-message-author-role") || "") === "user");

    function nodeInfo(el, index) {
      const rect = el.getBoundingClientRect();
      const text = String(el.innerText || "");
      const imgs = Array.from(el.querySelectorAll("img")).map(img => ({
        src: img.currentSrc || img.src || "",
        alt: img.alt || "",
        width: img.naturalWidth || Math.round(img.getBoundingClientRect().width) || 0,
        height: img.naturalHeight || Math.round(img.getBoundingClientRect().height) || 0
      }));

      const links = Array.from(el.querySelectorAll("a[href]")).map(a => ({
        href: a.href || "",
        text: String(a.innerText || a.getAttribute("aria-label") || a.getAttribute("title") || "")
      }));

      return {
        index,
        role: el.getAttribute("data-message-author-role") || "",
        text,
        imgs,
        links,
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    }

    const matchedMessages = [];

    for (let i = 0; i < nodes.length; i++) {
      const info = nodeInfo(nodes[i], i);
      if (info.width < 100 || info.height < 20) continue;

      const haystack = normalize([
        info.text,
        ...info.imgs.map(x => [x.alt, x.src].join(" ")),
        ...info.links.map(x => [x.text, x.href].join(" "))
      ].join("\n"));

      const exactMatch =
        (fileIdLower && haystack.includes(fileIdLower)) ||
        (nameLower && haystack.includes(nameLower));

      const textMatch =
        snippet && normalize(info.text).includes(snippet);

      // 如果 DOM 是完整用户消息列表，也允许按 userMessageIndex 定位；
      // 如果是虚拟列表，则这个条件通常不会命中，不会误用。
      const ordinalMatch =
        userMessageIndex >= 0 &&
        info.role === "user" &&
        userNodes.length > userMessageIndex &&
        userNodes[userMessageIndex] === nodes[i];

      if (exactMatch || textMatch || ordinalMatch) {
        matchedMessages.push(info);
      }
    }

    const candidates = [];

    for (const msg of matchedMessages) {
      for (const img of msg.imgs || []) {
        if (!img.src) continue;
        candidates.push({
          src: img.src,
          kind: "img",
          reason: "matched-message",
          role: msg.role,
          nearbyText: String(msg.text || "").slice(0, 300),
          alt: img.alt || "",
          width: img.width || 0,
          height: img.height || 0
        });
      }

      for (const link of msg.links || []) {
        if (!link.href) continue;
        const lower = String(link.href || "").toLowerCase();
        const looksImageOrFile =
          /\.(jpg|jpeg|png|webp|gif|bmp|svg|avif|heic|heif|tif|tiff|ico)(\?|#|$)/i.test(lower) ||
          lower.includes("/backend-api/") ||
          lower.includes("/files/") ||
          lower.includes("download") ||
          lower.includes("file");

        if (!looksImageOrFile) continue;

        candidates.push({
          src: link.href,
          kind: "link",
          reason: "matched-message",
          role: msg.role,
          nearbyText: String(msg.text || "").slice(0, 300),
          alt: link.text || "",
          width: 0,
          height: 0
        });
      }
    }

    const seen = new Set();
    return candidates.filter(x => {
      if (!x.src) return false;
      if (seen.has(x.src)) return false;
      seen.add(x.src);
      return true;
    });
  }, terms);
}

function shouldAcceptMessageContextDownload(downloaded, buffer, candidate) {
  const contentType = String(downloaded?.contentType || "").toLowerCase();
  const url = String(candidate?.src || "");
  const isImage = contentType.startsWith("image/") || !!extFromUrl(url);
  const exactAttachment =
    candidate?.attachmentFileId &&
    fileIdFromUrl(url) &&
    String(candidate.attachmentFileId) === String(fileIdFromUrl(url));

  if (!isImage) return false;

  // 精确命中附件 file_id 的图片允许很小，因为用户上传的裁剪截图可能只有几十像素高。
  if (exactAttachment) {
    return !!buffer && buffer.length >= 512;
  }

  if (contentType.includes("svg") || extFromUrl(url) === ".svg") return false;
  if (!buffer || buffer.length < 1024) return false;

  const dim = getImageDimensions(buffer);

  if (dim) {
    if (dim.width <= 120 && dim.height <= 120) return false;
    if (dim.width < 160 && dim.height < 160) return false;
  }

  return true;
}

async function pullMissingAttachmentsFromMessageContext(page, imageAttachments, savedImages) {
  let missing = getUnmatchedImageAttachments(savedImages, imageAttachments)
    .filter(att => att && (att.name || att.fileId));

  if (missing.length === 0) return [];

  log("尝试定位对应消息拉取附件：" + missing.length + " 个");

  const result = [];
  const done = new Set();

  async function tryVisibleMessagesOnce() {
    missing = getUnmatchedImageAttachments(savedImages.concat(result), imageAttachments)
      .filter(att => att && (att.name || att.fileId));

    for (const att of missing) {
      const k = imageAttachmentKey(att) || String(att.name || att.fileId || "");
      if (done.has(k)) continue;

      let candidates = [];

      try {
        candidates = await collectAttachmentCandidatesFromVisibleMessage(page, att);
      } catch (_) {
        candidates = [];
      }

      for (const candidate of candidates) {
        try {
          candidate.attachmentFileId = att.fileId || "";
          candidate.attachmentName = att.name || "";

          const downloaded = await downloadImageFromPage(page, candidate.src);
          const buffer = Buffer.from(downloaded.base64, "base64");

          if (!shouldAcceptMessageContextDownload(downloaded, buffer, candidate)) {
            continue;
          }

          const dimensions = getImageDimensions(buffer) || {};
          const ext =
            extFromMimeType(downloaded.contentType) ||
            extFromUrl(candidate.src) ||
            path.extname(att.name || "") ||
            ".png";

          const safeBase = safeFilename(att.name || att.fileId || ("message_attachment_" + (result.length + 1)), "message_attachment_" + (result.length + 1));
          const parsed = path.parse(safeBase);
          let filename = path.extname(safeBase) ? safeBase : safeBase + ext;
          let outPath = path.join(ASSET_DIR, filename);

          let suffix = 1;
          while (fs.existsSync(outPath)) {
            filename = (parsed.name || "message_attachment") + "_msg_" + suffix + (parsed.ext || ext);
            outPath = path.join(ASSET_DIR, filename);
            suffix++;
          }

          fs.writeFileSync(outPath, buffer);

          result.push({
            filename: path.basename(outPath),
            localPath: outPath,
            fileUrl: pathToFileUrl(outPath),
            relativeToCaptureDir: path.relative(CAPTURE_DIR, outPath).replace(/\\/g, "/"),
            bytes: buffer.length,
            width: dimensions.width || candidate.width || 0,
            height: dimensions.height || candidate.height || 0,
            mimeType: downloaded.contentType || "",
            url: candidate.src,
            source: "message-context-fetch",
            attachmentFileId: att.fileId || "",
            attachmentName: att.name || "",
            domImage: {
              nearbyText: [candidate.nearbyText || "", att.name || "", att.fileId || ""].join(" "),
              alt: candidate.alt || att.name || ""
            }
          });

          done.add(k);
          break;
        } catch (_) {}
      }
    }
  }

  await tryVisibleMessagesOnce();

  if (getUnmatchedImageAttachments(savedImages.concat(result), imageAttachments).length === 0) {
    ok("对应消息拉取附件：" + result.length + " 个");
    return result;
  }

  // 长对话是虚拟列表时，缺失消息未必在当前 DOM。
  // 多轮上下 scrollIntoView，把对应消息滚出来后再从该消息内部抓 img/link。
  for (let round = 0; round < 12; round++) {
    const stillMissing = getUnmatchedImageAttachments(savedImages.concat(result), imageAttachments);

    if (stillMissing.length === 0) break;

    await scrollPageToLoadImages(page, {
      direction: round % 2 === 0 ? "up" : "down",
      stepDelay: 450,
      settleDelay: 900
    });

    await sleep(800);
    await tryVisibleMessagesOnce();
  }

  if (result.length > 0) {
    ok("对应消息拉取附件：" + result.length + " 个");
  }

  return result;
}


async function downloadAttachmentFileByApi(page, attachment) {
  const fileId = String(attachment?.fileId || "").trim();
  if (!fileId) return null;

  const name = String(attachment?.name || "").trim();

  return await page.evaluate(async ({ fileId, name }) => {
    function toAbsoluteUrl(value) {
      if (!value || typeof value !== "string") return "";

      try {
        return new URL(value, location.origin).toString();
      } catch (_) {
        return "";
      }
    }

    function findDownloadUrl(obj) {
      const seen = new Set();
      const stack = [obj];

      while (stack.length) {
        const cur = stack.pop();

        if (!cur || typeof cur !== "object") continue;
        if (seen.has(cur)) continue;
        seen.add(cur);

        for (const [key, value] of Object.entries(cur)) {
          if (typeof value === "string") {
            const lowerKey = String(key || "").toLowerCase();
            const looksUrl =
              value.startsWith("http://") ||
              value.startsWith("https://") ||
              value.startsWith("/backend-api/") ||
              value.startsWith("/api/") ||
              value.startsWith("/cdn-cgi/");

            const goodKey =
              lowerKey.includes("download") ||
              lowerKey.includes("url") ||
              lowerKey.includes("image") ||
              lowerKey.includes("content") ||
              lowerKey.includes("file");

            if (looksUrl && goodKey) {
              const abs = toAbsoluteUrl(value);
              if (abs) return abs;
            }
          } else if (value && typeof value === "object") {
            stack.push(value);
          }
        }
      }

      return "";
    }

    async function responseToPayload(response, url) {
      const contentType = response.headers.get("content-type") || "";

      if (
        contentType.toLowerCase().startsWith("image/") ||
        contentType.toLowerCase().includes("octet-stream")
      ) {
        const buffer = await response.arrayBuffer();

        if (!buffer || buffer.byteLength <= 0) return null;

        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        let binary = "";

        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }

        return {
          contentType,
          byteLength: bytes.length,
          base64: btoa(binary),
          url
        };
      }

      if (contentType.toLowerCase().includes("json")) {
        let json = null;

        try {
          json = await response.json();
        } catch (_) {}

        const nestedUrl = findDownloadUrl(json);

        if (nestedUrl) {
          const nested = await fetch(nestedUrl, { credentials: "include" });
          if (nested.ok) {
            return await responseToPayload(nested, nestedUrl);
          }
        }
      }

      return null;
    }

    const encodedId = encodeURIComponent(fileId);
    const encodedName = encodeURIComponent(name || "");

    const endpoints = [
      `/backend-api/estuary/content?id=${encodedId}`,
      `/backend-api/files/${encodedId}/download`,
      `/backend-api/files/${encodedId}/download?filename=${encodedName}`,
      `/backend-api/files/${encodedId}/download?download=true`,
      `/backend-api/files/${encodedId}/content`,
      `/backend-api/files/${encodedId}`,
      `/backend-api/files/${encodedId}/metadata`
    ];

    for (const endpoint of endpoints) {
      const url = toAbsoluteUrl(endpoint);

      if (!url) continue;

      try {
        const response = await fetch(url, { credentials: "include" });

        if (!response.ok) continue;

        const payload = await responseToPayload(response, url);
        if (payload && payload.base64 && payload.byteLength > 0) {
          return payload;
        }
      } catch (_) {}
    }

    return null;
  }, { fileId, name });
}

async function downloadMissingAttachmentsByApi(page, imageAttachments, savedImages) {
  const missing = getUnmatchedImageAttachments(savedImages, imageAttachments)
    .filter(x => x.fileId);

  if (missing.length === 0) return [];

  log("尝试通过 file_id 补抓缺失图片：" + missing.length + " 个");

  const result = [];

  for (let i = 0; i < missing.length; i++) {
    const att = missing[i];

    try {
      const downloaded = await downloadAttachmentFileByApi(page, att);

      if (!downloaded || !downloaded.base64) {
        debugLog("file_id 补抓失败：" + (att.name || att.fileId));
        continue;
      }

      const buffer = Buffer.from(downloaded.base64, "base64");
      if (!buffer || buffer.length <= 0) continue;

      const dim = getImageDimensions(buffer) || {};
      const ext =
        extFromMimeType(downloaded.contentType) ||
        extFromUrl(downloaded.url) ||
        path.extname(att.name || "") ||
        ".jpg";

      const baseName = safeFilename(att.name || att.fileId || ("api_image_" + (i + 1)), "api_image_" + (i + 1));
      const filename = path.extname(baseName) ? baseName : baseName + ext;
      let outPath = path.join(ASSET_DIR, filename);

      if (fs.existsSync(outPath)) {
        const parsed = path.parse(filename);
        outPath = path.join(ASSET_DIR, parsed.name + "_api_" + (i + 1) + parsed.ext);
      }

      fs.writeFileSync(outPath, buffer);

      result.push({
        filename: path.basename(outPath),
        localPath: outPath,
        fileUrl: pathToFileUrl(outPath),
        relativeToCaptureDir: path.relative(CAPTURE_DIR, outPath).replace(/\\/g, "/"),
        bytes: buffer.length,
        width: dim.width || 0,
        height: dim.height || 0,
        mimeType: downloaded.contentType || att.mimeType || "",
        url: downloaded.url || "",
        source: "backend-file-api",
        attachmentFileId: att.fileId,
        attachmentName: att.name
      });

      debugLog("file_id 补抓成功：" + path.basename(outPath));
    } catch (e) {
      debugLog("file_id 补抓异常：" + (att.name || att.fileId) + " - " + e.message);
    }

    // 每抓一张就看是否已经补齐。
    const combined = savedImages.concat(result);
    if (getVerifiedMappedCount(combined, imageAttachments) >= imageAttachments.length) {
      break;
    }
  }

  if (result.length > 0) {
    ok("file_id 补抓图片：" + result.length + " 个");
  }

  return result;
}



async function captureNetworkImages(page, imageAttachments) {
  log("开始 Network 捕获图片资源...");

  const client = await page.target().createCDPSession();
  const responses = new Map();
  const savedImages = [];
  let counter = 0;

  await client.send("Network.enable");
  await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  await client.send("Network.setBypassServiceWorker", { bypass: true });

  client.on("Network.responseReceived", event => {
    const response = event.response || {};
    const mimeType = response.mimeType || "";
    const url = response.url || "";
    const type = event.type || "";

    const looksImage =
      String(mimeType).toLowerCase().startsWith("image/") ||
      type === "Image" ||
      !!extFromUrl(url);

    if (!looksImage) return;

    responses.set(event.requestId, {
      url,
      status: response.status,
      mimeType,
      type,
      headers: response.headers || {}
    });
  });

  client.on("Network.loadingFinished", async event => {
    const meta = responses.get(event.requestId);
    if (!meta) return;

    try {
      const result = await client.send("Network.getResponseBody", { requestId: event.requestId });
      let buffer;

      if (result.base64Encoded) {
        buffer = Buffer.from(result.body || "", "base64");
      } else {
        buffer = Buffer.from(result.body || "", "utf8");
      }

      if (!shouldKeepCapturedImage(meta, buffer, imageAttachments)) return;

      const dimensions = getImageDimensions(buffer) || {};

      counter++;
      const ext = extFromMimeType(meta.mimeType) || extFromUrl(meta.url) || ".jpg";
      const guessed = guessAssetNameFromUrl(meta.url, "network_image_" + String(counter).padStart(3, "0") + ext);
      const filename = safeFilename(path.extname(guessed) ? guessed : guessed + ext, "network_image_" + counter + ext);
      let outPath = path.join(ASSET_DIR, filename);

      // 避免同名覆盖
      if (fs.existsSync(outPath)) {
        const parsed = path.parse(filename);
        outPath = path.join(ASSET_DIR, parsed.name + "_" + counter + parsed.ext);
      }

      fs.writeFileSync(outPath, buffer);

      savedImages.push({
        filename: path.basename(outPath),
        localPath: outPath,
        fileUrl: pathToFileUrl(outPath),
        relativeToCaptureDir: path.relative(CAPTURE_DIR, outPath).replace(/\\/g, "/"),
        bytes: buffer.length,
        width: dimensions.width || 0,
        height: dimensions.height || 0,
        mimeType: meta.mimeType,
        url: meta.url,
        source: "network-response"
      });

      debugLog("Network 候选图片已保存：" + path.basename(outPath) + " (" + buffer.length + " bytes)");
    } catch (e) {
      // 很多缓存响应/跨域响应无法通过 getResponseBody 获取，这是正常现象。
    }
  });

  try {
    log("刷新页面以触发图片请求...");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(e => {
      warn("图片捕获阶段刷新页面警告：" + e.message);
    });

    await waitForChatContentReady(page, 20000);

    // ChatGPT 图片是懒加载的。这里只滚聊天正文区域，并且“核对成功”后立刻停止。
    await sleep(1200);

    const targetCount = Math.max(1, imageAttachments.length);
    const maxRounds = Math.min(12, Math.max(5, Math.ceil(targetCount / 4) + 4));

    for (let round = 0; round < maxRounds; round++) {
      const verifiedBefore = getVerifiedMappedCount(savedImages, imageAttachments);

      if (verifiedBefore >= targetCount) {
        ok("图片附件已核对通过：" + verifiedBefore + "/" + targetCount + "，提前停止滚动");
        break;
      }

      log("图片加载滚动轮次：" + (round + 1) + "/" + maxRounds + "，已保存：" + savedImages.length + "，已核对：" + verifiedBefore + "/" + targetCount);

      await scrollPageToLoadImages(page, {
        passes: 1,
        direction: round % 2 === 0 ? "down" : "up",
        stepDelay: 620,
        settleDelay: 1800
      });

      // 等 Network.loadingFinished 回调把图片落盘。
      await sleep(1800);

      const verifiedAfter = getVerifiedMappedCount(savedImages, imageAttachments);

      if (verifiedAfter >= targetCount) {
        ok("图片附件已核对通过：" + verifiedAfter + "/" + targetCount + "，提前停止滚动");
        break;
      }
    }

    // 最后短暂停留一次，等待异步图片响应落盘。
    await sleep(2600);
  } finally {
    try { await client.detach(); } catch (_) {}
  }

  return savedImages;
}


function cleanUserDisplayName(value) {
  let s = String(value || "")
    .replace(/\uFEFF/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return "";

  const cutTokens = [
    "免费版升级",
    "免费版",
    "升级",
    "Free plan Upgrade",
    "Free Plan Upgrade",
    "free plan upgrade",
    "Free plan",
    "Free Plan",
    "free plan",
    "Upgrade plan",
    "upgrade plan",
    "Upgrade",
    "upgrade",
    "Plus plan",
    "plus plan",
    "Go plan",
    "go plan",
    "Pro plan",
    "pro plan",
    "Team plan",
    "team plan",
    "Enterprise plan",
    "enterprise plan"
  ];

  for (const token of cutTokens) {
    const idx = s.toLowerCase().indexOf(token.toLowerCase());
    if (idx >= 0) s = s.slice(0, idx).trim();
  }

  s = s
    .replace(/[|｜·•\-–—]\s*(免费版|升级|free|upgrade|plus|go|pro|team|enterprise).*$/i, "")
    .trim();

  const lower = s.toLowerCase();

  const badContains = [
    "打开",
    "菜单",
    "个人资料",
    "账户",
    "账号",
    "profile",
    "account",
    "menu",
    "settings",
    "setting",
    "logout",
    "log out",
    "sign out",
    "upgrade",
    "new chat",
    "chatgpt",
    "openai"
  ];

  if (badContains.some(k => lower.includes(k))) return "";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "";
  if (s.length < 2 || s.length > 40) return "";

  return s;
}

function readConfiguredUserDisplayName() {
  const fromEnv = cleanUserDisplayName(process.env.CHATGPT_EXPORT_USER_NAME || process.env.PDF_USER_NAME || "");
  if (fromEnv) return fromEnv;

  const candidates = [
    path.join(ROOT, "pdf_user_name.txt"),
    path.join(ROOT, "user_name.txt"),
    path.join(ROOT, "display_name.txt")
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;

      const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
      const name = cleanUserDisplayName(raw);

      if (name) {
        if (String(raw || "").trim() !== name && path.basename(p).toLowerCase() === "pdf_user_name.txt") {
          fs.writeFileSync(p, name + "\n", "utf8");
        }
        return name;
      }
    } catch (_) {}
  }

  return "";
}

async function captureUserDisplayName(page) {
  const configured = readConfiguredUserDisplayName();

  if (configured) {
    ok("PDF 用户名：" + configured);
    return configured;
  }

  log("PDF 用户名：默认“用户”");
  return "";
}

async function captureMissingAttachmentsAsMessageScreenshots(page, imageAttachments, savedImages) {
  const missing = getUnmatchedImageAttachments(savedImages, imageAttachments)
    .filter(att => att && (att.name || att.fileId));

  if (missing.length === 0) return [];

  log("尝试截图兜底缺失图片：" + missing.length + " 个");

  const result = [];
  const doneKeys = new Set();

  function keyFor(att) {
    return imageAttachmentKey(att) || String(att.name || att.fileId || "");
  }

  async function findAndScreenshotVisibleMessages() {
    const handles = await page.$$("[data-message-author-role], article");

    for (const handle of handles) {
      let info = null;

      try {
        info = await handle.evaluate(el => {
          const text = String(el.innerText || "");
          const role = el.getAttribute("data-message-author-role") || "";
          const imgs = Array.from(el.querySelectorAll("img")).map(img => ({
            alt: img.alt || "",
            src: img.currentSrc || img.src || "",
            width: img.naturalWidth || img.width || 0,
            height: img.naturalHeight || img.height || 0
          }));

          const rect = el.getBoundingClientRect();

          return {
            role,
            text,
            imgs,
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        });
      } catch (_) {
        continue;
      }

      if (!info) continue;
      if (info.width < 100 || info.height < 30) continue;

      const haystack = [
        info.text,
        ...(info.imgs || []).map(x => [x.alt, x.src].join(" "))
      ].join("\n").toLowerCase();

      for (const att of missing) {
        const k = keyFor(att);

        if (doneKeys.has(k)) continue;

        const name = String(att.name || "").toLowerCase();
        const fileId = String(att.fileId || "").toLowerCase();

        const matched =
          (name && haystack.includes(name)) ||
          (fileId && haystack.includes(fileId));

        if (!matched) continue;

        const safeBase = safeFilename(att.name || att.fileId || ("message_screenshot_" + (result.length + 1)), "message_screenshot_" + (result.length + 1));
        const parsed = path.parse(safeBase);
        let filename = (parsed.name || safeBase) + "_message.png";
        let outPath = path.join(ASSET_DIR, filename);

        let suffix = 1;
        while (fs.existsSync(outPath)) {
          filename = (parsed.name || safeBase) + "_message_" + suffix + ".png";
          outPath = path.join(ASSET_DIR, filename);
          suffix++;
        }

        try {
          await handle.screenshot({ path: outPath });
          const stat = fs.statSync(outPath);

          result.push({
            filename: path.basename(outPath),
            localPath: outPath,
            fileUrl: pathToFileUrl(outPath),
            relativeToCaptureDir: path.relative(CAPTURE_DIR, outPath).replace(/\\/g, "/"),
            bytes: stat.size,
            width: info.width || 0,
            height: info.height || 0,
            mimeType: "image/png",
            url: "",
            source: "message-screenshot-fallback",
            attachmentFileId: att.fileId || "",
            attachmentName: att.name || "",
            domImage: {
              nearbyText: [att.name || "", att.fileId || ""].join(" "),
              alt: att.name || ""
            }
          });

          doneKeys.add(k);
          debugLog("消息截图兜底成功：" + path.basename(outPath));
        } catch (e) {
          debugLog("消息截图兜底失败：" + (att.name || att.fileId) + " - " + e.message);
        }
      }
    }
  }

  await findAndScreenshotVisibleMessages();

  if (result.length >= missing.length) {
    ok("消息截图兜底：" + result.length + " 个");
    return result;
  }

  // 长对话可能是虚拟列表，只保留当前视口附近消息。多滚几轮，把缺失附件所在消息滚出来再截图。
  for (let round = 0; round < 10; round++) {
    const combined = savedImages.concat(result);
    const stillMissing = getUnmatchedImageAttachments(combined, imageAttachments);

    if (stillMissing.length === 0) break;

    await scrollPageToLoadImages(page, {
      direction: round % 2 === 0 ? "up" : "down",
      stepDelay: 420,
      settleDelay: 900
    });

    await sleep(600);
    await findAndScreenshotVisibleMessages();

    if (getUnmatchedImageAttachments(savedImages.concat(result), imageAttachments).length === 0) {
      break;
    }
  }

  if (result.length > 0) {
    ok("消息截图兜底：" + result.length + " 个");
  }

  return result;
}


async function collectAndSaveImageAssets(page, jsonPath) {
  log("");
  log("开始尝试抓取页面图片附件...");

  fs.rmSync(ASSET_DIR, { recursive: true, force: true });
  fs.mkdirSync(ASSET_DIR, { recursive: true });

  const raw = fs.readFileSync(jsonPath, "utf8");
  const data = JSON.parse(extractJsonText(raw));
  const attachments = collectAttachmentRecordsFromConversation(data);
  const imageAttachments = attachments.filter(x => x.isImage);
  const uniqueImageAttachments = dedupeImageAttachments(imageAttachments);

  const manifest = {
    version: 24,
    generatedAt: new Date().toISOString(),
    note: "v24：精确 file_id 命中时允许小图；禁止 image.png 这类重复文件名兜底误配；增加 estuary file_id 直连补抓。",
    captureDir: CAPTURE_DIR,
    assetDir: ASSET_DIR,
    attachments,
    imageAttachments,
    uniqueImageAttachments,
    filesById: {},
    filesByName: {},
    allSavedImages: [],
    domImages: [],
    userDisplayName: "",
    errors: []
  };

  manifest.userDisplayName = await captureUserDisplayName(page);

  log("附件元数据数量：" + attachments.length);
  log("图片附件元数据数量：" + imageAttachments.length + "，去重后：" + uniqueImageAttachments.length);

  if (uniqueImageAttachments.length === 0) {
    warn("conversation JSON 中没有发现图片附件元数据，跳过图片抓取。");
    fs.writeFileSync(path.join(CAPTURE_DIR, "assets_manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    return manifest;
  }

  // 第一优先级：Network 响应抓图。这个比 DOM img 更适合抓用户上传附件。
  const networkImages = await captureNetworkImages(page, uniqueImageAttachments).catch(e => {
    warn("Network 图片捕获失败：" + e.message);
    manifest.errors.push({ stage: "network", error: e.message });
    return [];
  });

  manifest.allSavedImages.push(...networkImages);

  // 第二优先级：DOM img 下载，作为兜底。
  // 已核对通过时不再继续滚动；未核对通过时，只滚聊天正文区域补一次。
  const networkVerifiedCount = getVerifiedMappedCount(manifest.allSavedImages, uniqueImageAttachments);
  log("图片候选：" + manifest.allSavedImages.length + " 个，已匹配：" + networkVerifiedCount + "/" + uniqueImageAttachments.length);

  if (networkVerifiedCount < uniqueImageAttachments.length) {
    await scrollPageToLoadImages(page, { passes: 1, direction: "both", stepDelay: 600, settleDelay: 1700 });
  } else {
    ok("图片附件已全部核对通过，跳过 DOM 兜底滚动");
  }

  const candidates = await collectDomImageCandidates(page).catch(e => {
    warn("读取页面 img 标签失败：" + e.message);
    manifest.errors.push({ stage: "dom-list", error: e.message });
    return [];
  });

  manifest.domImages = candidates;
  fs.writeFileSync(path.join(CAPTURE_DIR, "page_images_debug.json"), JSON.stringify(candidates, null, 2), "utf8");
  debugLog("页面可疑 img 数量：" + candidates.length);
  debugLog("页面图片诊断已保存：" + path.join(CAPTURE_DIR, "page_images_debug.json"));

  if (getVerifiedMappedCount(manifest.allSavedImages, uniqueImageAttachments) < uniqueImageAttachments.length && candidates.length > 0) {
    const chosen = chooseImageCandidatesForAttachments(candidates, uniqueImageAttachments);

    if (chosen.length === 0) {
      warn("DOM 中没有找到能明确匹配附件文件名/file_id 的图片，跳过 DOM 下载，避免错图。");
    }

    for (let i = 0; i < chosen.length; i++) {
      const candidate = chosen[i];
      if (manifest.allSavedImages.some(x => x.url === candidate.src)) continue;

      try {
        const downloaded = await downloadImageFromPage(page, candidate.src);
        const ext = extFromMimeType(downloaded.contentType) || extFromUrl(candidate.src) || ".jpg";
        const filename = "dom_image_" + String(i + 1).padStart(3, "0") + ext;
        const outPath = path.join(ASSET_DIR, filename);
        fs.writeFileSync(outPath, Buffer.from(downloaded.base64, "base64"));

        const domBuffer = Buffer.from(downloaded.base64, "base64");
        const dimensions = getImageDimensions(domBuffer) || {};

        manifest.allSavedImages.push({
          filename,
          localPath: outPath,
          fileUrl: pathToFileUrl(outPath),
          relativeToCaptureDir: path.relative(CAPTURE_DIR, outPath).replace(/\\/g, "/"),
          bytes: downloaded.byteLength,
          width: dimensions.width || candidate.width || 0,
          height: dimensions.height || candidate.height || 0,
          mimeType: downloaded.contentType || "",
          url: candidate.src,
          source: "dom-img-fetch",
          domImage: candidate
        });

        debugLog("DOM 候选图片已保存：" + filename + " (" + downloaded.byteLength + " bytes)");

        const verifiedNow = getVerifiedMappedCount(manifest.allSavedImages, uniqueImageAttachments);
        if (verifiedNow >= uniqueImageAttachments.length) {
          ok("DOM 图片附件已核对通过：" + verifiedNow + "/" + uniqueImageAttachments.length + "，停止 DOM 下载");
          break;
        }
      } catch (e) {
        warn("DOM 图片下载失败：" + candidate.src + " - " + e.message);
      }
    }
  }

  // 第三优先级：如果前面读取失败，先定位到对应消息，在那条消息内拉取 img/link 附件。
  // 这个比全局抓图更安全：只在匹配到文件名/file_id/消息文本的消息里取图。
  const verifiedBeforeMessagePull = getVerifiedMappedCount(manifest.allSavedImages, uniqueImageAttachments);

  if (verifiedBeforeMessagePull < uniqueImageAttachments.length) {
    const messageImages = await pullMissingAttachmentsFromMessageContext(page, uniqueImageAttachments, manifest.allSavedImages).catch(e => {
      warn("对应消息拉取附件失败：" + e.message);
      manifest.errors.push({ stage: "message-context-fetch", error: e.message });
      return [];
    });

    manifest.allSavedImages.push(...messageImages);
  }

  // 第四优先级：用 file_id 后端接口补抓缺失图片。
  // 这个不依赖滚动页面，适合长对话里 Network 没触发到的图片。
  const verifiedBeforeApi = getVerifiedMappedCount(manifest.allSavedImages, uniqueImageAttachments);

  if (verifiedBeforeApi < uniqueImageAttachments.length) {
    const apiImages = await downloadMissingAttachmentsByApi(page, uniqueImageAttachments, manifest.allSavedImages).catch(e => {
      warn("file_id 补抓失败：" + e.message);
      manifest.errors.push({ stage: "file-api", error: e.message });
      return [];
    });

    manifest.allSavedImages.push(...apiImages);
  }

  // 第五优先级：仍然缺失时，截图包含附件的消息区域作为兜底。
  // 这不是原图，但能保证 PDF 里有可见内容，适合 ChatGPT 虚拟列表/鉴权图片拿不到原图的情况。
  const verifiedBeforeScreenshot = getVerifiedMappedCount(manifest.allSavedImages, uniqueImageAttachments);

  if (verifiedBeforeScreenshot < uniqueImageAttachments.length) {
    const screenshotImages = await captureMissingAttachmentsAsMessageScreenshots(page, uniqueImageAttachments, manifest.allSavedImages).catch(e => {
      warn("消息截图兜底失败：" + e.message);
      manifest.errors.push({ stage: "message-screenshot", error: e.message });
      return [];
    });

    manifest.allSavedImages.push(...screenshotImages);
  }

  const mapped = mapSavedImagesToAttachments(manifest.allSavedImages, uniqueImageAttachments);
  manifest.filesById = mapped.filesById;
  manifest.filesByName = mapped.filesByName;

  const manifestPath = path.join(CAPTURE_DIR, "assets_manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const savedCount = manifest.allSavedImages.length;
  const mappedCount = Object.keys(manifest.filesById).length + Object.keys(manifest.filesByName).filter(name => {
    const rec = manifest.filesByName[name];
    return !rec.fileId;
  }).length;

  const verifiedFinalCount = getVerifiedMappedCount(manifest.allSavedImages, uniqueImageAttachments);
  ok("图片附件完成：匹配 " + verifiedFinalCount + "/" + uniqueImageAttachments.length);
  debugLog("图片 manifest：" + manifestPath);

  if (savedCount === 0) {
    warn("没有成功保存图片文件。说明当前页面没有暴露可抓取的图片响应，PDF 仍只能显示附件名。");
  }

  return manifest;
}

function runJsonToPdf() {
  return new Promise((resolve, reject) => {
    log("");
    log("开始生成 PDF...");

    const script = path.join(ROOT, "run_json_to_pdf_pick_output.js");

    if (!fs.existsSync(script)) {
      reject(new Error("找不到 run_json_to_pdf_pick_output.js"));
      return;
    }

    const child = childProcess.spawn(
      process.platform === "win32" ? "node.exe" : "node",
      [script],
      {
        cwd: ROOT,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PDF 生成超过 10 分钟，已自动停止。"));
    }, 10 * 60 * 1000);

    child.stdout.on("data", data => log(data.toString("utf8")));
    child.stderr.on("data", data => log(data.toString("utf8")));

    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", code => {
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error("PDF 生成脚本运行失败，退出码：" + code));
        return;
      }

      ok("PDF 导出完成");
      resolve();
    });
  });
}

async function main() {
  fs.writeFileSync(LOG_FILE, "", "utf8");

  log("========================================");
  log("ChatGPT 半自动选择窗口导出");
  log("版本：" + TOOL_VERSION);
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
    while (true) {
      const selected = await selectPage(browser);

      const jsonPath = await captureConversationJson(selected.page, selected.conversationId);

      const result = checkConversationJson(jsonPath);

      log("");
      log("JSON 抓取与检查完成。");
      log("可导出消息数：" + result.visible);
      log("疑似图片/附件数量：" + result.media);

      await collectAndSaveImageAssets(selected.page, jsonPath);

      await runJsonToPdf();

      log("");
      log("========================================");
      log("SUCCESS");
      log("已完成：选择窗口 → 抓取最新 JSON → 检查 → 生成 PDF");
      log("========================================");

      const shouldContinue = await askContinueExport();

      if (!shouldContinue) {
        log("");
        ok("已退出导出流程，窗口将自动关闭。");
        break;
      }

      log("");
      log("准备继续导出，下次选择页面会重新列出当前 Chrome 页面。");
    }
  } finally {
    await browser.disconnect().catch(() => {});
  }
}

main()
  .then(() => {
    // 显式退出，避免 puppeteer/chrome 连接、stdin 等句柄残留导致 bat 窗口不关闭。
    process.exit(0);
  })
  .catch(err => {
    log("");
    log("========================================");
    log("FAILED");
    log(String(err.stack || err.message || err));
    log("========================================");
    process.exit(1);
  });
