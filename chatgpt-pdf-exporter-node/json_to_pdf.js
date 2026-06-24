const fs = require("fs");
const path = require("path");
const sanitize = require("sanitize-filename");
const MarkdownIt = require("markdown-it");
const puppeteer = require("puppeteer-core");

const ROOT = process.cwd();
const INPUT = path.join(ROOT, "captures", "conversation_json.txt");
const OUTPUT_DIR = path.join(ROOT, "output");

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

function log(msg) {
  console.log(msg);
}

function ok(msg) {
  console.log("✅ " + msg);
}

function fail(msg) {
  console.log("❌ " + msg);
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function extractTextAndMedia(content, msg) {
  const result = {
    text: "",
    media: []
  };

  if (!content) return result;

  if (typeof content === "string") {
    result.text = content;
    return result;
  }

  if (content.text) {
    result.text += content.text;
  }

  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (typeof part === "string") {
        result.text += part;
        continue;
      }

      if (!part || typeof part !== "object") continue;

      if (part.text) {
        result.text += part.text;
      }

      const raw = JSON.stringify(part);
      const fileMatch = raw.match(/file_[a-zA-Z0-9]+/);
      const fileId = fileMatch ? fileMatch[0] : "";
      const name = part.name || part.file_name || part.filename || fileId || "";

      if (fileId || name) {
        const isImage =
          String(part.mime_type || "").startsWith("image/") ||
          String(part.content_type || "").startsWith("image/") ||
          String(name).match(/\.(png|jpe?g|webp|gif)$/i);

        result.media.push({
          type: isImage ? "image" : "file",
          fileId,
          name: name || fileId || "附件"
        });
      }
    }
  }

  const attachments = msg.metadata?.attachments || [];

  for (const a of attachments) {
    const raw = JSON.stringify(a);
    const fileMatch = raw.match(/file_[a-zA-Z0-9]+/);
    const fileId = a.file_id || a.id || (fileMatch ? fileMatch[0] : "");
    const name = a.name || a.file_name || a.filename || fileId || "附件";
    const mime = a.mime_type || a.mimeType || a.content_type || "";

    const isImage =
      String(mime).startsWith("image/") ||
      String(name).match(/\.(png|jpe?g|webp|gif)$/i);

    result.media.push({
      type: isImage ? "image" : "file",
      fileId,
      name
    });
  }

  return result;
}

function extractMessages(data) {
  const branch = getCurrentBranch(data);
  const messages = [];

  for (const node of branch) {
    const msg = node.message;
    if (!msg) continue;

    if (msg.metadata?.is_visually_hidden_from_conversation) {
      continue;
    }

    if (looksInternalToolMessage(msg)) {
      continue;
    }

    const role = msg.author?.role || "";

    if (!["user", "assistant"].includes(role)) {
      continue;
    }

    const extracted = extractTextAndMedia(msg.content, msg);
    const text = String(extracted.text || "").trim();

    const seen = new Set();
    const media = [];

    for (const item of extracted.media) {
      const key = item.type + ":" + item.fileId + ":" + item.name;
      if (seen.has(key)) continue;
      seen.add(key);
      media.push(item);
    }

    if (!text && media.length === 0) continue;

    messages.push({
      role,
      text,
      media
    });
  }

  return messages;
}

function renderMedia(media) {
  if (!media || media.length === 0) return "";

  return `
    <div class="media-list">
      ${media.map(item => {
        if (item.type === "image") {
          return `
            <div class="file-chip image-missing">
              图片/附件记录：${escapeHtml(item.name || item.fileId || "图片")}
              ${item.fileId ? `<br><small>${escapeHtml(item.fileId)}</small>` : ""}
            </div>
          `;
        }

        return `
          <div class="file-chip">
            附件：${escapeHtml(item.name || item.fileId || "文件")}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderMessage(message) {
  const roleName = message.role === "user" ? "用户" : "ChatGPT";
  const roleClass = message.role === "user" ? "user" : "assistant";

  const body = [
    message.text ? `<div class="markdown">${md.render(message.text)}</div>` : "",
    renderMedia(message.media)
  ].join("");

  return `
    <article class="message ${roleClass}">
      <div class="role">${roleName}</div>
      <div class="content">${body}</div>
    </article>
  `;
}

function buildHtml(title, messages) {
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

  pre {
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

  .file-chip small {
    color: #6b7280;
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
  }
</style>
</head>
<body>
  <main class="page">
    <h1 class="title">${escapeHtml(title)}</h1>
    <div class="meta">由 captures\\conversation_json.txt 生成</div>
    ${messages.map(renderMessage).join("\n")}
  </main>
</body>
</html>`;
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

async function main() {
  log("读取文件：");
  log(INPUT);
  log("");

  if (!fs.existsSync(INPUT)) {
    fail("找不到 captures\\conversation_json.txt");
    log("");
    log("请先双击 RUN_ALL_CAPTURE_CHECK.bat 抓取聊天 JSON。");
    process.exit(1);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const raw = fs.readFileSync(INPUT, "utf8");
  const jsonText = extractJsonText(raw);

  const data = JSON.parse(jsonText);

  if (!data.mapping) {
    throw new Error("conversation_json.txt 中没有 mapping，不能生成 PDF。");
  }

  const title = data.title || "ChatGPT 对话记录";
  const messages = extractMessages(data);

  log("标题：" + title);
  log("可导出消息数：" + messages.length);

  if (messages.length <= 0) {
    throw new Error("没有可导出的 user / assistant 消息。");
  }

  const safeTitle = sanitize(title).slice(0, 80) || "chatgpt";
  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/, "");

  const baseName = safeTitle + "_" + timestamp;

  const htmlPath = path.join(OUTPUT_DIR, baseName + ".html");
  const pdfPath = path.join(OUTPUT_DIR, baseName + ".pdf");

  const html = buildHtml(title, messages);

  fs.writeFileSync(htmlPath, html, "utf8");

  ok("HTML 已生成：");
  log(htmlPath);

  const chrome = findChrome();

  if (!chrome) {
    throw new Error("找不到 Chrome，无法生成 PDF。");
  }

  log("");
  log("正在生成 PDF...");

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox"
    ]
  });

  const page = await browser.newPage();

  await page.setContent(html, {
    waitUntil: "networkidle0"
  });

  await page.pdf({
    path: pdfPath,
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true
  });

  await browser.close();

  ok("PDF 已生成：");
  log(pdfPath);

  log("");
  log("SUCCESS");
}

main().catch(err => {
  console.error("");
  console.error("FAILED");
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
