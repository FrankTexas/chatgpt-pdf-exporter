const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
let puppeteer = null;

let MarkdownIt = null;
try {
  MarkdownIt = require("markdown-it");
} catch (_) {}

const md = MarkdownIt
  ? new MarkdownIt({
      html: false,
      linkify: true,
      breaks: false
    })
  : null;

const ROOT = __dirname;
const CAPTURE_DIR = path.join(ROOT, "captures");
const DEFAULT_JSON_PATH = path.join(CAPTURE_DIR, "conversation_json.txt");
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "output");
const MATHJAX_CDN_SRC = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js";

let mathJaxRuntimeChecked = false;
let mathJaxScriptSrc = "";
let mathJaxRuntimeSource = "";
let mathJaxRuntimeOk = false;

const MATHJAX_RUNTIME_CONFIG_FILE = path.join(ROOT, "mathjax_runtime_config.json");

function log(...args) {
  console.log(args.join(" "));
}

function safeFilename(name, fallback = "chatgpt_export") {
  const raw = String(name || fallback)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return raw || fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pathToFileUrl(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, "/");
  return "file:///" + encodeURI(resolved);
}

function extractJsonText(raw) {
  raw = String(raw || "");
  if (raw.trim().startsWith("{")) return raw.trim();
  const idx = raw.indexOf("\n{");
  if (idx >= 0) return raw.slice(idx + 1).trim();
  const first = raw.indexOf("{");
  if (first >= 0) return raw.slice(first).trim();
  return "";
}

function readConversation(jsonPath = DEFAULT_JSON_PATH) {
  const raw = fs.readFileSync(jsonPath, "utf8");
  return JSON.parse(extractJsonText(raw));
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


function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npmRun(args, options = {}) {
  const stdio = options.stdio || "pipe";
  const encoding = options.encoding || "utf8";
  const attempts = [];
  const nodeDir = path.dirname(process.execPath || "");

  const npmCliCandidates = [
    process.env.npm_execpath,
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(Boolean);

  for (const npmCli of npmCliCandidates) {
    try {
      if (fs.existsSync(npmCli) && npmCli.toLowerCase().endsWith(".js")) {
        attempts.push({
          cmd: process.execPath,
          args: [npmCli, ...args],
          shell: false
        });
      }
    } catch (_) {}
  }

  const npmCmdCandidates = [
    path.join(nodeDir, process.platform === "win32" ? "npm.cmd" : "npm"),
    process.platform === "win32" ? "npm.cmd" : "npm",
    "npm"
  ];

  for (const npmCmd of npmCmdCandidates) {
    attempts.push({
      cmd: npmCmd,
      args,
      shell: false
    });
  }

  attempts.push({
    cmd: "npm",
    args,
    shell: process.platform === "win32"
  });

  let lastResult = null;

  for (const attempt of attempts) {
    try {
      const result = childProcess.spawnSync(attempt.cmd, attempt.args, {
        cwd: ROOT,
        stdio,
        encoding,
        shell: attempt.shell
      });

      lastResult = result;

      if (!result.error && result.status === 0) {
        return { ok: true, result };
      }
    } catch (err) {
      lastResult = { error: err, status: -1, stdout: "", stderr: String(err && (err.stack || err.message) || err) };
    }
  }

  return { ok: false, result: lastResult };
}

function canResolvePackage(packageName) {
  try {
    require.resolve(packageName, { paths: [ROOT] });
    return true;
  } catch (_) {
    return false;
  }
}

function ensureMathJaxPackage(logger = log) {
  if (canResolvePackage("mathjax")) return true;

  try {
    logger("MathJax SVG：本地未安装，正在安装一次...");
    const npmInstall = npmRun(["install", "--no-audit", "--no-fund", "mathjax@3"], {
      stdio: "pipe",
      encoding: "utf8"
    });

    const result = npmInstall.result || { status: -1, stdout: "", stderr: "" };

    if (!npmInstall.ok) {
      const detail = [
        "status=" + String(result.status),
        "error=" + String(result.error && (result.error.message || result.error) || ""),
        result.stdout || "",
        result.stderr || ""
      ].join("\n").trim();

      if (detail) {
        logger("MathJax SVG：npm 安装失败，已改用 CDN。详细信息见开发者日志。");
        try {
          fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
          fs.appendFileSync(
            path.join(ROOT, "logs", "pdf_generation_dev_log.txt"),
            "\n[MathJax npm install failed]\n" + detail + "\n",
            "utf8"
          );
        } catch (_) {}
      }

      return false;
    }

    return canResolvePackage("mathjax");
  } catch (err) {
    logger("MathJax SVG：npm 安装异常，已改用 CDN。");
    try {
      fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
      fs.appendFileSync(
        path.join(ROOT, "logs", "pdf_generation_dev_log.txt"),
        "\n[MathJax npm install exception]\n" + String(err && (err.stack || err.message) || err) + "\n",
        "utf8"
      );
    } catch (_) {}
    return false;
  }
}


function readMathJaxRuntimeConfig() {
  try {
    if (!fs.existsSync(MATHJAX_RUNTIME_CONFIG_FILE)) return null;
    const cfg = JSON.parse(fs.readFileSync(MATHJAX_RUNTIME_CONFIG_FILE, "utf8"));

    if (cfg && cfg.source === "local" && cfg.scriptPath && fs.existsSync(cfg.scriptPath)) {
      return {
        source: "local",
        scriptPath: cfg.scriptPath,
        scriptSrc: pathToFileUrl(cfg.scriptPath)
      };
    }

    if (cfg && cfg.source === "cdn" && cfg.scriptSrc) {
      return {
        source: "cdn",
        scriptPath: "",
        scriptSrc: cfg.scriptSrc
      };
    }
  } catch (_) {}

  return null;
}

function saveMathJaxRuntimeConfig(config) {
  try {
    fs.writeFileSync(
      MATHJAX_RUNTIME_CONFIG_FILE,
      JSON.stringify(
        {
          ...config,
          updatedAt: new Date().toISOString()
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (_) {}
}

function resolveLocalMathJaxScriptPath() {
  try {
    return require.resolve("mathjax/es5/tex-svg.js", { paths: [ROOT] });
  } catch (_) {
    return "";
  }
}

function checkMathJaxRuntime(logger = log) {
  if (mathJaxRuntimeChecked) {
    logger("MathJax SVG：已就绪（" + mathJaxRuntimeSource + "）");
    return mathJaxRuntimeOk;
  }

  mathJaxRuntimeChecked = true;
  logger("检测 MathJax SVG 公式渲染...");

  const cached = readMathJaxRuntimeConfig();
  if (cached && cached.source === "local") {
    mathJaxScriptSrc = cached.scriptSrc;
    mathJaxRuntimeSource = "本地";
    mathJaxRuntimeOk = true;
    logger("MathJax SVG：本地缓存检测成功");
    return true;
  }

  if (cached && cached.source === "cdn") {
    mathJaxScriptSrc = cached.scriptSrc;
    mathJaxRuntimeSource = "CDN";
    mathJaxRuntimeOk = false;
    logger("MathJax SVG：使用已保存的 CDN 方案");
    return false;
  }

  const existingScriptPath = resolveLocalMathJaxScriptPath();
  if (existingScriptPath && fs.existsSync(existingScriptPath)) {
    mathJaxScriptSrc = pathToFileUrl(existingScriptPath);
    mathJaxRuntimeSource = "本地";
    mathJaxRuntimeOk = true;
    saveMathJaxRuntimeConfig({
      source: "local",
      scriptPath: existingScriptPath,
      scriptSrc: mathJaxScriptSrc
    });
    logger("MathJax SVG：本地加载成功");
    return true;
  }

  const installed = ensureMathJaxPackage(logger);
  if (installed) {
    const installedScriptPath = resolveLocalMathJaxScriptPath();

    if (installedScriptPath && fs.existsSync(installedScriptPath)) {
      mathJaxScriptSrc = pathToFileUrl(installedScriptPath);
      mathJaxRuntimeSource = "本地";
      mathJaxRuntimeOk = true;
      saveMathJaxRuntimeConfig({
        source: "local",
        scriptPath: installedScriptPath,
        scriptSrc: mathJaxScriptSrc
      });
      logger("MathJax SVG：安装并加载成功");
      return true;
    }
  }

  mathJaxScriptSrc = MATHJAX_CDN_SRC;
  mathJaxRuntimeSource = "CDN";
  mathJaxRuntimeOk = false;
  saveMathJaxRuntimeConfig({
    source: "cdn",
    scriptPath: "",
    scriptSrc: mathJaxScriptSrc
  });
  logger("MathJax SVG：本地不可用，已保存 CDN 方案");
  return false;
}

function getMathJaxScriptSrc() {
  if (!mathJaxRuntimeChecked) {
    checkMathJaxRuntime();
  }

  return mathJaxScriptSrc || MATHJAX_CDN_SRC;
}

function isFormulaLike(expr) {
  const s = String(expr || "").trim();
  if (!s) return false;
  if (s.length > 2500) return false;

  return (
    /\\[a-zA-Z]+/.test(s) ||
    /[=^_]/.test(s) ||
    /\b(f|g|h|z|u|v|x|y|r|t|s)\s*\(/.test(s) ||
    /\b(sin|cos|tan|ln|log|exp)\b/.test(s)
  );
}

function renderMathBlock(expr) {
  const latex = escapeHtml(String(expr || "").trim());
  return `<div class="math-block">\\[${latex}\\]</div>`;
}

function renderMathInline(expr) {
  const latex = escapeHtml(String(expr || "").trim());
  return `<span class="math-inline">\\(${latex}\\)</span>`;
}

function protectMath(text) {
  let source = String(text || "");
  const blocks = [];
  const inlines = [];

  function putBlock(expr) {
    const index = blocks.push(String(expr || "").trim()) - 1;
    return `\n\n@@MATH_BLOCK_${index}@@\n\n`;
  }

  function putInline(expr) {
    const index = inlines.push(String(expr || "").trim()) - 1;
    return `@@MATH_INLINE_${index}@@`;
  }

  // 标准块级公式：\[...\] 和 $$...$$
  source = source.replace(/\\\[([\s\S]*?)\\\]/g, (_m, expr) => putBlock(expr));
  source = source.replace(/\$\$([\s\S]*?)\$\$/g, (_m, expr) => putBlock(expr));

  // 标准行内公式：\(...\)
  source = source.replace(/\\\(([\s\S]*?)\\\)/g, (_m, expr) => putInline(expr));

  // 兼容已经变成独立 [ ... ] 的公式块。
  source = source.replace(/(^|\n)\s*\[\s*\n?([\s\S]*?)\n?\s*\]\s*(?=\n|$)/g, (_m, prefix, expr) => {
    if (!isFormulaLike(expr)) return _m;
    return `${prefix}${putBlock(expr)}`;
  });

  return { source, blocks, inlines };
}

function restoreMath(html, math) {
  let out = String(html || "");

  out = out.replace(/<p>\s*@@MATH_BLOCK_(\d+)@@\s*<\/p>/g, (_m, index) => {
    return renderMathBlock(math.blocks[Number(index)] || "");
  });

  out = out.replace(/@@MATH_BLOCK_(\d+)@@/g, (_m, index) => {
    return renderMathBlock(math.blocks[Number(index)] || "");
  });

  out = out.replace(/@@MATH_INLINE_(\d+)@@/g, (_m, index) => {
    return renderMathInline(math.inlines[Number(index)] || "");
  });

  return out;
}

function mathJaxHeadHtml() {
  const scriptSrc = getMathJaxScriptSrc();

  return `
<script>
window.MathJax = {
  tex: {
    inlineMath: [['\\\\(', '\\\\)']],
    displayMath: [['\\\\[', '\\\\]'], ['$$', '$$']],
    processEscapes: true
  },
  svg: {
    fontCache: 'local',
    scale: 1
  },
  options: {
    skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
  },
  startup: {
    typeset: true
  }
};
</script>
<script id="MathJax-script" defer src="${escapeHtml(scriptSrc)}"></script>
`;
}

async function waitForMathJax(page, logger = log) {
  let before = { mathNodes: 0, containers: 0 };

  try {
    before = await page.evaluate(() => ({
      mathNodes: document.querySelectorAll(".math-block, .math-inline").length,
      containers: document.querySelectorAll("mjx-container").length
    }));
  } catch (_) {}

  if (!before.mathNodes) return { ok: true, mathNodes: 0, containers: 0 };

  try {
    await page.waitForFunction(
      () => !!window.MathJax,
      { timeout: 45000 }
    );
  } catch (_) {}

  try {
    await page.evaluate(async () => {
      if (window.MathJax && window.MathJax.startup && window.MathJax.startup.promise) {
        await window.MathJax.startup.promise;
      }
      if (window.MathJax && window.MathJax.typesetPromise) {
        await window.MathJax.typesetPromise();
      }
    });
  } catch (_) {}

  try {
    await page.waitForFunction(
      () => {
        const mathNodes = document.querySelectorAll(".math-block, .math-inline").length;
        const containers = document.querySelectorAll("mjx-container").length;
        return mathNodes === 0 || containers > 0;
      },
      { timeout: 45000 }
    );
  } catch (_) {}

  await new Promise(resolve => setTimeout(resolve, 500));

  let result = { mathNodes: before.mathNodes, containers: 0, ok: false };
  try {
    result = await page.evaluate(() => {
      const mathNodes = document.querySelectorAll(".math-block, .math-inline").length;
      const containers = document.querySelectorAll("mjx-container").length;
      return {
        mathNodes,
        containers,
        ok: mathNodes === 0 || containers > 0
      };
    });
  } catch (_) {}

  if (result.ok) {
    logger("MathJax SVG：渲染成功，公式数量：" + result.mathNodes);
  } else {
    logger("MathJax SVG：渲染失败，公式仍可能显示为 LaTeX 文本");
  }

  return result;
}

function sanitizeMessageText(text) {
  return String(text || "")
    // 去掉 ChatGPT 内部引用 token，避免 PDF 出现一串看不懂的标记。
    .replace(/[^]+/g, "")
    // 去掉 artifact/writing 包装标记，只保留里面正常文本。
    .replace(/:::writing\{[^}]*\}/g, "")
    .replace(/:::/g, "")
    .trim();
}

function contentText(content) {
  if (!content) return "";
  if (typeof content === "string") return sanitizeMessageText(content);
  if (content.text) return sanitizeMessageText(content.text);

  function textFromPart(part) {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";

    // 附件对象不要直接输出 file_id，后面单独用附件卡片渲染。
    if (part.file_id || part.fileId || part.asset_pointer || part.name || part.filename || part.file_name) {
      return part.text ? String(part.text || "") : "";
    }

    if (part.text) return String(part.text || "");
    if (part.content && typeof part.content === "string") return part.content;
    if (part.value && typeof part.value === "string") return part.value;

    return "";
  }

  if (Array.isArray(content.parts)) {
    return sanitizeMessageText(content.parts.map(textFromPart).filter(Boolean).join("\n"));
  }

  if (Array.isArray(content.content)) {
    return sanitizeMessageText(content.content.map(textFromPart).filter(Boolean).join("\n"));
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

  if (contentType && !["text", "multimodal_text"].includes(contentType)) return true;
  return false;
}

function isImageLike(name, mimeType) {
  const n = String(name || "").toLowerCase();
  const m = String(mimeType || "").toLowerCase();
  return m.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif|bmp|svg)$/i.test(n);
}

function normalizeAttachment(raw) {
  if (!raw || typeof raw !== "object") return null;

  const fileId = raw.file_id || raw.fileId || raw.id || raw.fileID || "";
  const name = raw.name || raw.file_name || raw.filename || raw.display_name || raw.title || "";
  const mimeType = raw.mime_type || raw.mimeType || raw.content_type || raw.contentType || raw.type || "";

  if (!fileId && !name) return null;

  return {
    fileId: String(fileId || ""),
    name: String(name || ""),
    mimeType: String(mimeType || ""),
    isImage: isImageLike(name, mimeType)
  };
}

function collectAttachmentsFromMessage(msg) {
  const list = [];
  const seen = new Set();

  function push(record) {
    if (!record) return;
    const key = (record.fileId || "") + "|" + (record.name || "");
    if (seen.has(key)) return;
    seen.add(key);
    list.push(record);
  }

  const metaAttachments = Array.isArray(msg.metadata?.attachments) ? msg.metadata.attachments : [];
  for (const a of metaAttachments) push(normalizeAttachment(a));

  const parts = Array.isArray(msg.content?.parts) ? msg.content.parts : [];
  for (const part of parts) {
    if (part && typeof part === "object") push(normalizeAttachment(part));
  }

  return list;
}

function loadAssetsManifest(jsonPath) {
  const candidates = [
    path.join(path.dirname(jsonPath), "assets_manifest.json"),
    path.join(CAPTURE_DIR, "assets_manifest.json")
  ];

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(p, "utf8"));
      manifest.__path = p;
      return manifest;
    } catch (_) {}
  }

  return { filesById: {}, filesByName: {}, allSavedImages: [] };
}

function findAssetForAttachment(att, manifest) {
  if (!att || !manifest) return null;
  const byId = manifest.filesById || {};
  const byName = manifest.filesByName || {};

  // 关键修复：有 file_id 的附件必须按 file_id 精确匹配。
  // 不能再 fallback 到 image.png 这种重复文件名，否则会把同一张图重复插到多个附件里。
  if (att.fileId) return byId[att.fileId] || null;

  if (att.name && byName[att.name]) return byName[att.name];

  return null;
}

function mimeFromExt(filePath) {
  const ext = String(path.extname(filePath || "") || "").toLowerCase();

  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".avif") return "image/avif";
  if (ext === ".heic") return "image/heic";
  if (ext === ".heif") return "image/heif";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  if (ext === ".ico") return "image/x-icon";

  return "application/octet-stream";
}

function assetSrc(asset) {
  if (!asset) return "";

  const localPath = asset.localPath && fs.existsSync(asset.localPath)
    ? asset.localPath
    : "";

  if (localPath) {
    try {
      const mime = asset.mimeType || mimeFromExt(localPath);
      const base64 = fs.readFileSync(localPath).toString("base64");
      return `data:${mime};base64,${base64}`;
    } catch (_) {}
  }

  // 兜底：如果本地图片不存在，才退回 file://。
  // 正常导出的 HTML 会优先用 data URL，这样单独打开/分享 HTML 时图片不会丢。
  if (asset.fileUrl) return asset.fileUrl;

  return "";
}

function renderMarkdownish(text) {
  const value = String(text || "");
  const math = protectMath(value);

  if (md) {
    const rendered = md.render(math.source);
    return `<div class="markdown">${restoreMath(rendered, math)}</div>`;
  }

  let html = escapeHtml(math.source);

  // 简单处理代码块，避免全部挤成一坨。不是完整 Markdown 解析器，但够稳定。
  html = html.replace(/```([\s\S]*?)```/g, (_m, code) => {
    return `<pre class="code-block"><code>${code}</code></pre>`;
  });

  html = html
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>");

  return `<div class="markdown"><p>${restoreMath(html, math)}</p></div>`;
}

function attachmentIdentity(att, manifest) {
  const asset = findAssetForAttachment(att, manifest);

  if (asset) {
    return [
      "asset",
      asset.localPath || "",
      asset.fileUrl || "",
      asset.relativeToCaptureDir || "",
      asset.bytes || ""
    ].join("|");
  }

  return [
    "att",
    att.fileId || "",
    att.name || "",
    att.mimeType || ""
  ].join("|");
}

function renderAttachment(att, manifest) {
  const asset = findAssetForAttachment(att, manifest);
  const name = att.name || "未命名附件";

  if (att.isImage && asset) {
    const src = assetSrc(asset);

    if (src) {
      const isScreenshot = String(asset.source || "").includes("screenshot");

      return `
        <div class="media-list">
          <div class="file-chip image-chip ${isScreenshot ? "screenshot-fallback" : ""}">
            ${isScreenshot ? `<div class="image-note">原图未能直接下载，已使用消息截图兜底。</div>` : ""}
            <img src="${escapeHtml(src)}" alt="${escapeHtml(name)}" />
          </div>
        </div>`;
    }
  }

  if (att.isImage) {
    return `
      <div class="media-list">
        <div class="file-chip image-missing">
          <small>图片未捕获：${escapeHtml(name)}</small>
        </div>
      </div>`;
  }

  return `
    <div class="media-list">
      <div class="file-chip">
        附件：${escapeHtml(name)}
      </div>
    </div>`;
}

function buildMessages(data, manifest) {
  const branch = getCurrentBranch(data);
  const messages = [];

  for (const node of branch) {
    const msg = node.message;
    if (!msg) continue;

    const role = msg.author?.role || "unknown";
    if (!["user", "assistant"].includes(role)) continue;
    if (msg.metadata?.is_visually_hidden_from_conversation) continue;
    if (looksInternalToolMessage(msg)) continue;

    const text = contentText(msg.content).trim();
    const attachments = collectAttachmentsFromMessage(msg);
    if (!text && attachments.length === 0) continue;

    messages.push({
      role,
      text,
      attachments,
      createTime: msg.create_time || 0
    });
  }

  return messages;
}


function cleanDisplayNameForPdf(value) {
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

function readConfiguredDisplayNameForPdf() {
  const fromEnv = cleanDisplayNameForPdf(process.env.CHATGPT_EXPORT_USER_NAME || process.env.PDF_USER_NAME || "");
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
      const name = cleanDisplayNameForPdf(raw);

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

function getExportUserName(manifest) {
  // 自动猜用户名不稳定，可能抓到项目名、GPT 名或升级按钮。
  // PDF 里只使用用户手动设置的名字；未设置时显示“用户”。
  const configured = readConfiguredDisplayNameForPdf();
  return configured || "用户";
}

function formatExportTimeOnly() {
  return new Date().toLocaleString("zh-CN");
}

function buildHtml(data, messages, manifest) {
  const title = data.title || "ChatGPT 对话记录";
  const generatedAt = formatExportTimeOnly();
  const exportUserName = getExportUserName(manifest);

  const body = messages.map(message => {
    const roleName = message.role === "user" ? exportUserName : "ChatGPT";
    const roleClass = message.role === "user" ? "user" : "assistant";
    const textHtml = message.text ? renderMarkdownish(message.text) : "";

    const seenAttachments = new Set();
    const uniqueAttachments = [];

    for (const att of message.attachments || []) {
      const key = attachmentIdentity(att, manifest);
      if (seenAttachments.has(key)) continue;
      seenAttachments.add(key);
      uniqueAttachments.push(att);
    }

    const attachmentsHtml = uniqueAttachments.map(a => renderAttachment(a, manifest)).join("\n");

    return `
      <article class="message ${roleClass}">
        <div class="message-card">
          <div class="role">${escapeHtml(roleName)}</div>
          <div class="content">
            ${textHtml}
            ${attachmentsHtml}
          </div>
        </div>
      </article>`;
  }).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
${mathJaxHeadHtml()}
<style>
  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    padding: 36px 30px 72px;
    background: #ffffff;
    color: #111827;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
    font-size: 16px;
    line-height: 1.75;
  }

  .page {
    max-width: 880px;
    margin: 0 auto;
  }

  .title {
    font-size: 26px;
    font-weight: 800;
    margin: 0 0 28px;
    padding-bottom: 14px;
    border-bottom: 1px solid #e5e7eb;
  }

  .meta {
    margin: -12px 0 28px;
    color: #6b7280;
    font-size: 13px;
  }

  .message {
    margin: 0 0 20px;
    padding: 0;
    border-bottom: 0;
    page-break-inside: auto;
    display: flex;
    width: 100%;
  }

  .message.assistant {
    justify-content: flex-start;
  }

  .message.user {
    justify-content: flex-end;
    margin-bottom: 28px;
  }

  .message-card {
    page-break-inside: auto;
  }

  .message.assistant .message-card {
    width: 100%;
  }

  .message.user .message-card {
    width: auto;
    max-width: 100%;
  }

  .role {
    display: none;
  }

  .content {
    overflow-wrap: anywhere;
  }

  .message.assistant .content {
    border: 0;
    background: transparent;
    box-shadow: none;
    padding: 0;
    border-radius: 0;
  }

  .message.user .content {
    display: inline-block;
    border: 0;
    background: #f3f4f6;
    box-shadow: none;
    padding: 14px 18px;
    border-radius: 24px;
    border-top-right-radius: 10px;
    color: #111827;
    text-align: left;
  }

  .message.user .content p:last-child {
    margin-bottom: 0;
  }

  .content p {
    margin: 0 0 1em;
  }

  .content h1,
  .content h2,
  .content h3,
  .content h4 {
    line-height: 1.35;
    margin: 1.35em 0 0.65em;
    page-break-after: avoid;
  }

  .content h1 {
    font-size: 1.72em;
  }

  .content h2 {
    font-size: 1.42em;
    border-top: 1px solid #e5e7eb;
    padding-top: 0.85em;
  }

  .content h2:first-child,
  .content h3:first-child,
  .content p:first-child {
    margin-top: 0;
  }

  .content p:last-child,
  .content ul:last-child,
  .content ol:last-child,
  .content blockquote:last-child {
    margin-bottom: 0;
  }

  .content h3 {
    font-size: 1.2em;
  }

  .content ul,
  .content ol {
    padding-left: 1.5em;
    margin-top: 0.4em;
    margin-bottom: 1em;
  }

  .content li {
    margin: 0.2em 0;
  }

  .content blockquote {
    margin: 1em 0;
    padding-left: 1em;
    border-left: 4px solid #d1d5db;
    color: #374151;
  }

  .content hr {
    border: 0;
    border-top: 1px solid #e5e7eb;
    margin: 1.2em 0;
  }

  .message.assistant .content {
    font-size: 18px;
    line-height: 1.82;
  }

  .message.user .content {
    font-size: 17px;
    line-height: 1.6;
  }

  .message.assistant + .message.user {
    margin-top: 10px;
  }

  .message.user + .message.assistant {
    margin-top: 18px;
  }

  pre,
  .code-block {
    white-space: pre-wrap;
    word-break: break-word;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 12px 14px;
    overflow: hidden;
    page-break-inside: avoid;
  }

  code {
    font-family: Consolas, Monaco, "Courier New", monospace;
    font-size: 0.92em;
  }

  :not(pre) > code {
    background: #f3f4f6;
    padding: 0.12em 0.35em;
    border-radius: 4px;
  }

  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
  }

  th,
  td {
    border: 1px solid #d1d5db;
    padding: 6px 8px;
    vertical-align: top;
  }

  img {
    max-width: 100%;
  }

  .math-block {
    display: block;
    margin: 1.05em auto 1.25em;
    padding: 0;
    overflow-x: auto;
    overflow-y: hidden;
    text-align: center;
    page-break-inside: avoid;
  }

  .math-block mjx-container[jax="SVG"] {
    margin: 0 !important;
    font-size: 112% !important;
  }

  .math-inline mjx-container[jax="SVG"] {
    font-size: 104% !important;
  }

  .math-inline {
    white-space: nowrap;
  }

  .content p + .math-block,
  .math-block + p {
    margin-top: 1.05em;
  }

  .media-list {
    margin-top: 12px;
  }

  .file-chip {
    margin: 8px 0;
    padding: 8px 10px;
    border: 1px dashed #d1d5db;
    border-radius: 8px;
    background: #f9fafb;
    font-size: 14px;
    color: #374151;
  }

  .file-chip-title {
    font-weight: 700;
    margin-bottom: 8px;
  }

  .file-chip small {
    color: #6b7280;
  }

  .image-chip {
    page-break-inside: avoid;
  }

  .image-chip img {
    display: block;
    max-width: 100%;
    max-height: 720px;
    margin-top: 8px;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
    object-fit: contain;
  }

  .image-note {
    margin-bottom: 8px;
    font-size: 13px;
    color: #6b7280;
  }

  .screenshot-fallback img {
    border-style: dashed;
  }

  @page {
    size: A4;
    margin: 14mm 16mm;
  }

  @media print {
    body {
      padding: 0;
    }

    .page {
      max-width: none;
    }

    .message.assistant .message-card {
      width: 100%;
    }

    .message.user .message-card {
      width: auto;
      max-width: 100%;
    }

    .message.user .content,
    .message.assistant .content {
      box-shadow: none;
    }

    .image-chip img {
      max-height: 680px;
    }
  }
</style>
</head>
<body>
  <main class="page">
    <h1 class="title">${escapeHtml(title)}</h1>
    <div class="meta">${escapeHtml(generatedAt)}</div>
    ${body}
  </main>
</body>
</html>`;
}

async function ensurePuppeteer() {
  if (puppeteer) return puppeteer;
  try {
    puppeteer = require("puppeteer-core");
    return puppeteer;
  } catch (e) {
    throw new Error("找不到 puppeteer-core，请先运行 npm install。原始错误：" + e.message);
  }
}

function findChrome() {
  const candidates = [
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  return null;
}

async function htmlToPdf(htmlPath, pdfPath, logger = log) {
  const pp = await ensurePuppeteer();
  const chrome = findChrome();
  if (!chrome) throw new Error("找不到 Google Chrome，无法生成 PDF。");

  const browser = await pp.launch({
    executablePath: chrome,
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check"]
  });

  try {
    const page = await browser.newPage();
    await page.goto(pathToFileUrl(htmlPath), { waitUntil: "networkidle0", timeout: 120000 });
    await waitForMathJax(page, logger);
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", right: "12mm", bottom: "14mm", left: "12mm" }
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

function resolveOutputDir(argvOutputDir) {
  if (argvOutputDir) return path.resolve(argvOutputDir);

  const candidates = [
    "pdf_output_dir.txt",
    "output_dir.txt",
    "output_path.txt",
    "selected_output_dir.txt"
  ].map(x => path.join(ROOT, x));

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const v = fs.readFileSync(p, "utf8").trim();
    if (v) return v;
  }

  const jsonCandidates = ["config.json", "output_config.json", "pdf_output_config.json"].map(x => path.join(ROOT, x));
  for (const p of jsonCandidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      const v = cfg.outputDir || cfg.output_dir || cfg.pdfOutputDir || cfg.pdf_output_dir;
      if (v) return v;
    } catch (_) {}
  }

  return DEFAULT_OUTPUT_DIR;
}

async function convertJsonToPdf(options = {}) {
  const logger = typeof options.logger === "function" ? options.logger : log;

  const jsonPath = path.resolve(options.jsonPath || DEFAULT_JSON_PATH);
  const outputDir = path.resolve(resolveOutputDir(options.outputDir));
  const pdfDir = path.resolve(options.pdfDir || path.join(outputDir, "PDF"));
  const htmlDir = path.resolve(options.htmlDir || path.join(outputDir, "HTML"));

  logger("读取文件：" + jsonPath);
  logger("输出根目录：" + outputDir);
  logger("PDF 输出目录：" + pdfDir);
  logger("HTML 输出目录：" + htmlDir);

  checkMathJaxRuntime(logger);

  fs.mkdirSync(pdfDir, { recursive: true });
  fs.mkdirSync(htmlDir, { recursive: true });

  const data = readConversation(jsonPath);
  const manifest = loadAssetsManifest(jsonPath);
  const messages = buildMessages(data, manifest);

  logger("标题：" + (data.title || "ChatGPT对话"));
  logger("消息数：" + messages.length);

  const title = safeFilename(data.title || "ChatGPT对话", "ChatGPT对话");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "_");
  const base = `${title}_${stamp}`;
  const htmlPath = path.join(htmlDir, base + ".html");
  const pdfPath = path.join(pdfDir, base + ".pdf");

  logger("生成 HTML：" + htmlPath);
  const html = buildHtml(data, messages, manifest);
  fs.writeFileSync(htmlPath, html, "utf8");

  logger("生成 PDF：" + pdfPath);
  await htmlToPdf(htmlPath, pdfPath, logger);

  logger("完成：" + pdfPath);
  return { htmlPath, pdfPath, messageCount: messages.length, pdfDir, htmlDir, outputDir };
}

async function main() {
  const jsonPath = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : DEFAULT_JSON_PATH;
  const outputDir = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined;
  await convertJsonToPdf({ jsonPath, outputDir });
}

if (require.main === module) {
  main().catch(err => {
    console.error("PDF 生成失败：");
    console.error(err.stack || err.message || String(err));
    process.exit(1);
  });
}

module.exports = convertJsonToPdf;
module.exports.convertJsonToPdf = convertJsonToPdf;
module.exports.main = main;
module.exports.buildHtml = buildHtml;
