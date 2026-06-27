const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const ROOT = __dirname;
const DEFAULT_JSON = path.join(ROOT, "captures", "conversation_json.txt");
const DEFAULT_OUTPUT = path.join(ROOT, "output");
const OUTPUT_TEXT_FILE = path.join(ROOT, "pdf_output_dir.txt");
const OUTPUT_JSON_FILE = path.join(ROOT, "pdf_output_config.json");
const LOG_DIR = path.join(ROOT, "logs");
const PDF_DEV_LOG_FILE = path.join(LOG_DIR, "pdf_generation_dev_log.txt");

function log(...args) {
  console.log(args.join(" "));
}

function warn(...args) {
  console.log("⚠️ ", args.join(" "));
}

function ok(...args) {
  console.log("✅", args.join(" "));
}

function ensureDevLog() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function resetDevLog() {
  ensureDevLog();
  fs.writeFileSync(PDF_DEV_LOG_FILE, "", "utf8");
}

function devLog(...args) {
  ensureDevLog();
  fs.appendFileSync(PDF_DEV_LOG_FILE, args.join(" ") + "\n", "utf8");
}


function readTextIfExists(p) {
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  } catch (_) {}
  return "";
}

function stripBom(s) {
  return String(s || "").replace(/^\uFEFF/, "");
}

function stripOuterQuotes(s) {
  let v = stripBom(s).trim();

  while (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }

  return v;
}

function expandEnvVars(s) {
  let v = String(s || "");

  v = v.replace(/%([^%]+)%/g, (_, name) => {
    return process.env[name] || process.env[name.toUpperCase()] || process.env[name.toLowerCase()] || "";
  });

  if (v === "~") {
    return process.env.USERPROFILE || process.env.HOME || v;
  }

  if (v.startsWith("~\\") || v.startsWith("~/")) {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    if (home) return path.join(home, v.slice(2));
  }

  return v;
}

function normalizeOutputDir(input) {
  let v = stripOuterQuotes(input);
  if (!v) return "";

  // 支持 file:///C:/Users/... 这种形式。
  if (/^file:\/\//i.test(v)) {
    try {
      v = decodeURIComponent(new URL(v).pathname);
      if (process.platform === "win32" && /^\/[a-zA-Z]:\//.test(v)) {
        v = v.slice(1);
      }
    } catch (_) {}
  }

  v = expandEnvVars(v);

  // 兼容用户从资源管理器复制的路径，去掉结尾空格和多余斜杠。
  v = v.trim();

  if (!v) return "";

  return path.resolve(v);
}

function saveOutputDir(dir) {
  const normalized = normalizeOutputDir(dir);
  if (!normalized) return "";

  fs.writeFileSync(OUTPUT_TEXT_FILE, normalized + "\n", "utf8");
  fs.writeFileSync(
    OUTPUT_JSON_FILE,
    JSON.stringify({ outputDir: normalized, updatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );

  return normalized;
}

function readSavedOutputDir() {
  const textFiles = [
    "pdf_output_dir.txt",
    "output_dir.txt",
    "output_path.txt",
    "selected_output_dir.txt"
  ];

  for (const f of textFiles) {
    const v = readTextIfExists(path.join(ROOT, f));
    const normalized = normalizeOutputDir(v);
    if (normalized) return normalized;
  }

  const jsonFiles = [
    "pdf_output_config.json",
    "config.json",
    "output_config.json",
    "pdf_output_config.json"
  ];

  for (const f of jsonFiles) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;

    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      const v = cfg.outputDir || cfg.output_dir || cfg.pdfOutputDir || cfg.pdf_output_dir;
      const normalized = normalizeOutputDir(v);
      if (normalized) return normalized;
    } catch (_) {}
  }

  return "";
}

function getArgValue(names) {
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    for (const name of names) {
      if (a === name && args[i + 1]) return args[i + 1];
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
    }
  }

  return "";
}

function hasArg(name) {
  return process.argv.slice(2).includes(name);
}

function powershellEncode(command) {
  return Buffer.from(command, "utf16le").toString("base64");
}

function pickOutputDirViaPowerShell(initialDir) {
  if (process.platform !== "win32") return "";

  const safeInitial = String(initialDir || DEFAULT_OUTPUT).replace(/'/g, "''");

  const ps = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "请选择 PDF 保存文件夹"
$dialog.ShowNewFolderButton = $true
$initial = '${safeInitial}'
if ($initial -and (Test-Path -LiteralPath $initial)) {
  $dialog.SelectedPath = $initial
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;

  const exe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

  try {
    const r = childProcess.spawnSync(
      exe,
      [
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        powershellEncode(ps)
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        windowsHide: false,
        timeout: 5 * 60 * 1000
      }
    );

    const out = stripOuterQuotes((r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "");
    return normalizeOutputDir(out);
  } catch (_) {
    return "";
  }
}

function resolveOutputDir(options = {}) {
  const forcePicker = !!options.forcePicker;
  const allowPicker = options.allowPicker !== false;

  const cliValue = getArgValue(["--output", "--output-dir", "--out"]);
  const cliDir = normalizeOutputDir(cliValue);
  if (cliDir) return { dir: cliDir, source: "command line" };

  const envValue = process.env.PDF_OUTPUT_DIR || process.env.CHATGPT_PDF_OUTPUT_DIR || "";
  const envDir = normalizeOutputDir(envValue);
  if (envDir) return { dir: envDir, source: "environment variable" };

  const savedDir = readSavedOutputDir();
  const defaultDir = DEFAULT_OUTPUT;

  if (allowPicker && process.platform === "win32" && (forcePicker || !savedDir)) {
    log("");
    log("请选择 PDF 保存文件夹...");
    log("如果取消，将使用默认 output 文件夹。");

    const picked = pickOutputDirViaPowerShell(savedDir || defaultDir);

    if (picked) {
      const saved = saveOutputDir(picked);
      return { dir: saved, source: "folder picker" };
    }

    warn("你取消了文件夹选择。");
  }

  if (savedDir) return { dir: savedDir, source: "saved config" };

  return { dir: defaultDir, source: "default" };
}

async function chooseOutputOnly() {
  log("========================================");
  log("修改 PDF 保存位置");
  log("========================================");

  const current = readSavedOutputDir() || DEFAULT_OUTPUT;

  log("");
  log("当前保存位置：");
  log(current);

  const picked = pickOutputDirViaPowerShell(current);

  if (!picked) {
    warn("未选择文件夹，保存位置没有变化。");
    return;
  }

  const saved = saveOutputDir(picked);
  fs.mkdirSync(saved, { recursive: true });

  ok("PDF 保存位置已更新：");
  log(saved);
  log("");
  log("配置文件：");
  log(OUTPUT_TEXT_FILE);
}

async function main() {
  if (hasArg("--choose-output-only") || hasArg("--set-output")) {
    await chooseOutputOnly();
    return;
  }

  resetDevLog();
  devLog("========================================");
  devLog("JSON To PDF - developer log");
  devLog("========================================");
  devLog("时间：" + new Date().toISOString());
  devLog("项目目录：" + ROOT);
  devLog("JSON 文件：" + DEFAULT_JSON);

  if (!fs.existsSync(DEFAULT_JSON)) {
    throw new Error("找不到 conversation_json.txt：" + DEFAULT_JSON);
  }

  const resultDir = resolveOutputDir({
    allowPicker: process.env.CHATGPT_PDF_OUTPUT_PICKER !== "0"
  });

  const outputDir = normalizeOutputDir(resultDir.dir);
  const pdfDir = path.join(outputDir, "PDF");
  const htmlDir = path.join(outputDir, "HTML");

  fs.mkdirSync(pdfDir, { recursive: true });
  fs.mkdirSync(htmlDir, { recursive: true });

  devLog("输出根目录：" + outputDir);
  devLog("PDF 输出目录：" + pdfDir);
  devLog("HTML 输出目录：" + htmlDir);
  devLog("输出来源：" + resultDir.source);
  devLog("");

  log("正在生成文件...");

  const convertJsonToPdf = require("./json_to_pdf.js");
  const result = await convertJsonToPdf({
    jsonPath: DEFAULT_JSON,
    outputDir,
    pdfDir,
    htmlDir,
    logger: (...args) => devLog(...args)
  });

  ok("生成完成");
  log("PDF：" + result.pdfPath);
  log("网页：" + result.htmlPath);
  log("开发者日志：" + PDF_DEV_LOG_FILE);

  devLog("");
  devLog("生成完成：");
  devLog("PDF：" + result.pdfPath);
  devLog("HTML：" + result.htmlPath);
}

main().catch(err => {
  const msg = err.stack || err.message || String(err);
  try {
    devLog("");
    devLog("PDF 生成失败：");
    devLog(msg);
  } catch (_) {}

  console.error("");
  console.error("PDF 生成失败，详情见开发者日志：");
  console.error(PDF_DEV_LOG_FILE);
  process.exit(1);
});
