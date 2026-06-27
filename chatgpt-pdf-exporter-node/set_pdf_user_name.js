const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = __dirname;
const OUT = path.join(ROOT, "pdf_user_name.txt");

function cleanName(value) {
  let s = String(value || "")
    .replace(/\uFEFF/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const cutTokens = [
    "免费版升级",
    "免费版",
    "升级",
    "Free plan Upgrade",
    "Free Plan Upgrade",
    "free plan upgrade",
    "Free plan",
    "free plan",
    "Upgrade",
    "upgrade"
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
    "sign out",
    "chatgpt",
    "openai"
  ];

  if (!s) return "";
  if (badContains.some(k => lower.includes(k))) return "";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "";
  if (s.length > 40) return "";

  return s;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log("========================================");
console.log("Set PDF User Name");
console.log("========================================");
console.log("");
console.log("This name will replace the role label '用户' in exported PDF.");
console.log("Leave empty to clear the custom name.");
console.log("");

rl.question("PDF user name: ", answer => {
  const name = cleanName(answer);

  if (!String(answer || "").trim()) {
    try {
      if (fs.existsSync(OUT)) fs.rmSync(OUT, { force: true });
    } catch (_) {}

    console.log("");
    console.log("Custom PDF user name cleared. PDF will use default label.");
    rl.close();
    return;
  }

  if (!name) {
    console.log("");
    console.log("[ERROR] Invalid name. Please avoid menu/button labels or email addresses.");
    rl.close();
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(OUT, name + "\n", "utf8");

  console.log("");
  console.log("Saved:");
  console.log(OUT);
  console.log("");
  console.log("PDF user name: " + name);

  rl.close();
});
