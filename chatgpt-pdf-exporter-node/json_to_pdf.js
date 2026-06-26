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

function contentText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.text) return String(content.text);

  if (Array.isArray(content.parts)) {
    return content.parts.map(part => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        // 附件对象不要直接输出 file_id，后面单独用附件卡片渲染。
        if (part.file_id || part.fileId || part.asset_pointer || part.name || part.filename || part.file_name) return "";
        if (part.text) return part.text;
      }
      return "";
    }).filter(Boolean).join("\n");
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

  if (att.fileId && byId[att.fileId]) return byId[att.fileId];
  if (att.name && byName[att.name]) return byName[att.name];

  return null;
}

function assetSrc(asset) {
  if (!asset) return "";
  if (asset.fileUrl) return asset.fileUrl;
  if (asset.localPath && fs.existsSync(asset.localPath)) return pathToFileUrl(asset.localPath);
  return "";
}

function renderMarkdownish(text) {
  const value = String(text || "");

  if (md) {
    return `<div class="markdown">${md.render(value)}</div>`;
  }

  let html = escapeHtml(value);

  // 简单处理代码块，避免全部挤成一坨。不是完整 Markdown 解析器，但够稳定。
  html = html.replace(/```([\s\S]*?)```/g, (_m, code) => {
    return `<pre class="code-block"><code>${code}</code></pre>`;
  });

  html = html
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>");

  return `<div class="markdown"><p>${html}</p></div>`;
}

function renderAttachment(att, manifest) {
  const asset = findAssetForAttachment(att, manifest);
  const name = att.name || "未命名附件";

  if (att.isImage && asset) {
    const src = assetSrc(asset);
    if (src) {
      return `
        <div class="media-list">
          <div class="file-chip image-chip">
            <img src="${escapeHtml(src)}" alt="${escapeHtml(name)}" />
          </div>
        </div>`;
    }
  }

  if (att.isImage) {
    return `
      <div class="media-list">
        <div class="file-chip image-missing">
          <small>图片未能嵌入，只保留附件记录。</small>
          ${att.fileId ? `<br><small>${escapeHtml(att.fileId)}</small>` : ""}
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
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return "";

  const planPatterns = [
    /免费版升级.*$/i,
    /升级.*$/i,
    /free\s*plan\s*upgrade.*$/i,
    /free\s*upgrade.*$/i,
    /upgrade\s*plan.*$/i,
    /plus\s*upgrade.*$/i,
    /go\s*upgrade.*$/i,
    /pro\s*upgrade.*$/i,
    /team\s*upgrade.*$/i,
    /enterprise\s*upgrade.*$/i,
    /免费版.*$/i,
    /free\s*plan.*$/i,
    /plus\s*plan.*$/i,
    /go\s*plan.*$/i,
    /pro\s*plan.*$/i,
    /team\s*plan.*$/i,
    /enterprise\s*plan.*$/i
  ];

  for (const r of planPatterns) {
    s = s.replace(r, "").trim();
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
      const name = cleanDisplayNameForPdf(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
      if (name) return name;
    } catch (_) {}
  }

  return "";
}

function getExportUserName(manifest) {
  const configured = readConfiguredDisplayNameForPdf();
  if (configured) return configured;

  const name = cleanDisplayNameForPdf(
    manifest?.userDisplayName ||
    manifest?.exportMetadata?.userDisplayName ||
    ""
  );

  return name || "用户";
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
    const attachmentsHtml = message.attachments.map(a => renderAttachment(a, manifest)).join("\n");

    return `
      <article class="message ${roleClass}">
        <div class="role">${escapeHtml(roleName)}</div>
        <div class="content">
          ${textHtml}
          ${attachmentsHtml}
        </div>
      </article>`;
  }).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
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
    margin: 0 0 28px;
    padding: 0 0 26px;
    border-bottom: 1px solid #e5e7eb;
    page-break-inside: auto;
  }

  .role {
    font-weight: 800;
    font-size: 15px;
    margin-bottom: 10px;
    color: #374151;
  }

  .message.user .role {
    color: #111827;
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

async function htmlToPdf(htmlPath, pdfPath) {
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
  const jsonPath = path.resolve(options.jsonPath || DEFAULT_JSON_PATH);
  const outputDir = path.resolve(resolveOutputDir(options.outputDir));

  log("读取文件：" + jsonPath);
  log("输出文件夹：" + outputDir);

  fs.mkdirSync(outputDir, { recursive: true });

  const data = readConversation(jsonPath);
  const manifest = loadAssetsManifest(jsonPath);
  const messages = buildMessages(data, manifest);

  const title = safeFilename(data.title || "ChatGPT对话", "ChatGPT对话");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "_");
  const base = `${title}_${stamp}`;
  const htmlPath = path.join(outputDir, base + ".html");
  const pdfPath = path.join(outputDir, base + ".pdf");

  log("生成 HTML：" + htmlPath);
  const html = buildHtml(data, messages, manifest);
  fs.writeFileSync(htmlPath, html, "utf8");

  log("生成 PDF：" + pdfPath);
  await htmlToPdf(htmlPath, pdfPath);

  log("完成：" + pdfPath);
  return { htmlPath, pdfPath, messageCount: messages.length };
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
