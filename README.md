# ChatGPT PDF Exporter 使用说明

## 一、项目简介

ChatGPT PDF Exporter 是一个用于将 ChatGPT 聊天记录导出为 PDF 的 Windows 小工具。

本项目目前保留两套方案：

```text
方案 A：Node.js 版本，当前推荐，适合普通用户一键导出
方案 B：Python / Playwright 版本，第一版方案，保留给开发者和备用使用
```

普通用户建议使用 Node.js 版本；如果你之前已经在用 Python 版本，也可以继续保留。

---

## 二、推荐给普通用户的使用方式：Node.js 版本

### 1. 普通用户应该点哪个？

普通用户只需要双击：

```text
双击开始导出PDF.bat
```

这个启动器会自动完成：

```text
检查 Node.js
检查 npm
检查依赖
首次运行自动安装依赖
启动或连接 Chrome
列出当前 Chrome 页面
让用户选择 ChatGPT 对话
抓取 conversation JSON
生成 PDF
```

### 2. 修改 PDF 保存位置

如果想修改 PDF 输出目录，双击：

```text
修改PDF保存位置.bat
```

程序会记住新的输出路径。

### 3. Node.js 版本需要的环境

```text
Windows 10 / Windows 11
Google Chrome
Node.js 18 或更高版本
npm
```

推荐安装 Node.js LTS 版本。安装 Node.js 时不要取消 npm 选项。

---

## 三、保留的第一版方案：Python / Playwright 版本

Python 版本是项目第一版方案，可以继续保留，适合开发者调试或作为备用导出方式。

### 1. Python 版本入口文件

```text
export_pdf.py
start_chrome.bat
requirements.txt
```

### 2. Python 版本需要的环境

```text
Windows 10 / Windows 11
Python 3.10 或更高版本
Google Chrome
Playwright
```

### 3. 安装 Python 依赖

在项目根目录打开 PowerShell，执行：

```powershell
pip install -r requirements.txt
```

如果项目依赖 Playwright，还需要执行：

```powershell
python -m playwright install chromium
```

### 4. Python 版本运行方式

先双击启动调试 Chrome：

```text
start_chrome.bat
```

然后在打开的 Chrome 中登录 ChatGPT，并打开需要导出的对话页面。

接着在 PowerShell 中运行：

```powershell
python export_pdf.py
```

或者：

```powershell
py export_pdf.py
```

---


## 四、文件说明

### Node.js 版本文件

| 文件 / 目录 | 作用 |
|---|---|
| `双击开始导出PDF.bat` | 普通用户启动入口，双击它开始导出 |
| `修改PDF保存位置.bat` | 修改 PDF 输出目录 |
| `run_fresh_export_select_page.js` | 主程序，负责连接 Chrome、选择页面、抓取 conversation JSON |
| `run_json_to_pdf_pick_output.js` | 负责选择/读取输出目录并调用 PDF 转换逻辑 |
| `json_to_pdf.js` | 将聊天 JSON 转成 PDF 的核心代码 |
| `package.json` | Node.js 依赖说明 |
| `package-lock.json` | 锁定依赖版本，保证安装更稳定 |
| `node_modules/` | npm 安装出来的依赖目录，不建议上传 GitHub |

### Python 版本文件

| 文件 / 目录 | 作用 |
|---|---|
| `export_pdf.py` | Python 第一版导出主程序 |
| `start_chrome.bat` | 启动带调试端口的 Chrome |
| `requirements.txt` | Python 依赖列表 |
| `chatgpt_export_pdf_user_images_silent_config.py` | Python 版本的增强/配置脚本 |

### 运行生成的目录

| 文件 / 目录 | 作用 |
|---|---|
| `captures/` | 保存抓到的 ChatGPT 原始 JSON |
| `logs/` | 保存运行日志 |
| `output/` | 保存生成的 PDF / HTML |
| `chrome-profile-debug/` | Node.js 版本调试 Chrome 的用户数据目录 |
| `chrome_data/` | Python 版本可能使用的 Chrome 用户数据目录 |
---

## 五、常见问题

### 1. 普通用户应该用哪个版本？

推荐使用 Node.js 版本，双击：

```text
双击开始导出PDF.bat
```

Python 版本主要作为第一版方案保留，适合开发者调试或备用。

---

### 2. 为什么要保留 Python 版本？

保留 Python 版本有几个好处：

```text
方便对比两套实现
方便回退
方便调试
保留第一版开发记录
避免 Node.js 版本异常时完全没备用方案
```

---

### 3. Node.js 版本提示 Cannot find module 'puppeteer-core' 怎么办？

说明依赖没有安装成功。

进入 Node.js 项目目录：

```powershell
cd chatgpt-pdf-exporter-node
```

然后执行：

```powershell
npm install
```

再重新双击：

```text
双击开始导出PDF.bat
```

---

### 4. Python 版本提示 No module named playwright 怎么办？

说明 Python 依赖没有安装。

在项目根目录执行：

```powershell
pip install -r requirements.txt
python -m playwright install chromium
```

---

### 5. bat 文件中文变成 ????? 怎么办？

这是编码问题。

推荐做法是：bat 文件尽量使用英文提示，中文说明写在 README 中。

如果一定要在 bat 里写中文，请确保：

```text
文件编码：UTF-8
换行格式：CRLF
控制台编码：65001
```

在 Cursor / VS Code 右下角检查：

```text
UTF-8   CRLF   Batch
```

---

### 6. 双击 bat 闪退怎么办？

bat 文件中需要在出错位置和结尾保留：

```bat
pause
```

这样出错时窗口不会直接关闭，方便截图排查。

---



## 六、免责声明

本项目仅用于个人学习、研究和聊天记录备份。

请不要将本工具用于违反网站服务条款、侵犯他人隐私或批量抓取数据等用途。

使用者应自行承担使用本工具产生的相关责任。
