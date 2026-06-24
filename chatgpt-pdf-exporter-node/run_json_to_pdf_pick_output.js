const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");

const ROOT = process.cwd();
const DEFAULT_OUTPUT = path.join(ROOT, "output");
const CONFIG_DIR = path.join(process.env.APPDATA || os.homedir(), "chatgpt_pdf_exporter_node");
const CONFIG_FILE = path.join(CONFIG_DIR, "selected_output_dir.json");

function log(msg) {
  console.log(msg);
}

function chooseFolder(defaultDir) {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "请选择 PDF 输出文件夹"
$dialog.ShowNewFolderButton = $true
$default = $env:CHATGPT_PDF_DEFAULT_DIR
if ($default -and (Test-Path $default)) {
  $dialog.SelectedPath = $default
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Write($dialog.SelectedPath)
}
`;

  try {
    return childProcess.execFileSync(
      "powershell.exe",
      ["-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CHATGPT_PDF_DEFAULT_DIR: defaultDir,
        },
      }
    ).trim();
  } catch {
    return "";
  }
}

function getSavedOutputDir() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return "";
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (cfg.outputDir && fs.existsSync(cfg.outputDir)) return cfg.outputDir;
  } catch {}
  return "";
}

function saveOutputDir(dir) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ outputDir: dir, updatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function getOutputDir() {
  const forceChange = process.argv.includes("--change-output-dir");

  const saved = getSavedOutputDir();

  if (!forceChange && saved) {
    return saved;
  }

  log("请选择 PDF 输出文件夹...");

  const selected = chooseFolder(saved || DEFAULT_OUTPUT);

  const finalDir = selected || saved || DEFAULT_OUTPUT;

  fs.mkdirSync(finalDir, { recursive: true });
  saveOutputDir(finalDir);

  return finalDir;
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(name => /\.(pdf|html)$/i.test(name))
    .map(name => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { name, full, mtimeMs: stat.mtimeMs };
    });
}

function moveNewFiles(fromDir, toDir, startedAt) {
  if (!fs.existsSync(fromDir)) return [];

  const moved = [];

  const files = listFiles(fromDir).filter(f => f.mtimeMs >= startedAt - 3000);

  for (const f of files) {
    const target = path.join(toDir, f.name);

    if (path.resolve(f.full).toLowerCase() === path.resolve(target).toLowerCase()) {
      moved.push(target);
      continue;
    }

    fs.mkdirSync(toDir, { recursive: true });

    let finalTarget = target;
    if (fs.existsSync(finalTarget)) {
      const ext = path.extname(f.name);
      const base = path.basename(f.name, ext);
      finalTarget = path.join(toDir, `${base}_${Date.now()}${ext}`);
    }

    fs.renameSync(f.full, finalTarget);
    moved.push(finalTarget);
  }

  return moved;
}

async function main() {
  log("========================================");
  log("JSON To PDF - 选择输出位置版");
  log("========================================");
  log("");

  if (!fs.existsSync(path.join(ROOT, "captures", "conversation_json.txt"))) {
    log("❌ 找不到 captures\\conversation_json.txt");
    log("请先运行 RUN_ALL_CAPTURE_CHECK.bat 抓取聊天 JSON。");
    process.exit(1);
  }

  if (!fs.existsSync(path.join(ROOT, "json_to_pdf.js"))) {
    log("❌ 找不到 json_to_pdf.js");
    process.exit(1);
  }

  const outputDir = getOutputDir();

  log("输出文件夹：");
  log(outputDir);
  log("");

  const startedAt = Date.now();

  log("开始生成 PDF...");
  log("");

  const result = childProcess.spawnSync(
    "node",
    [path.join(ROOT, "json_to_pdf.js")],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        CHATGPT_PDF_OUTPUT_DIR: outputDir,
      },
      shell: false,
    }
  );

  if (result.status !== 0) {
    log("");
    log("❌ json_to_pdf.js 运行失败。");
    process.exit(result.status || 1);
  }

  log("");
  log("开始整理输出文件...");

  const moved = moveNewFiles(DEFAULT_OUTPUT, outputDir, startedAt);

  if (moved.length > 0) {
    log("");
    log("✅ 已输出到：");
    for (const f of moved) {
      log(f);
    }
  } else {
    log("");
    log("⚠️ 没在默认 output 目录发现新 PDF/HTML。");
    log("如果文件已经出现在你选择的目录，可以忽略这条提示。");
    log("你也可以检查默认目录：");
    log(DEFAULT_OUTPUT);
  }

  log("");
  log("SUCCESS");
}

main().catch(err => {
  console.error("");
  console.error("FAILED");
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
