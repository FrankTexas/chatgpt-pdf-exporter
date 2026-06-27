# ChatGPT PDF Exporter

一个用于将 ChatGPT 对话导出为 **PDF + HTML 网页备份** 的本地小工具。

当前推荐使用 **Node.js 版本**。旧版 Python 方案可以作为备用保留。


###  Node.js 版本需要的环境

```text
Windows 10 / Windows 11
Google Chrome
Node.js 18 或更高版本
npm
```

推荐安装 Node.js LTS 版本。安装 Node.js 时不要取消 npm 选项。

---

## 一、使用

进入：

```txt
chatgpt-pdf-exporter-node
```

双击：

```txt
01_双击开始导出PDF.bat
```

正常流程：

```txt
1. 工具会检查 Node.js / npm / 依赖
2. 自动连接或启动调试版 Chrome
3. 在 Chrome 里打开你要导出的 ChatGPT 对话
4. 回到窗口，输入对应页面编号
5. 工具自动抓取对话内容和图片附件
6. 自动生成 PDF 和 HTML
7. 结束后可以选择继续导出，或退出程序
```

---

## 二、输出文件保存位置

第一次导出时，如果没有保存过输出目录，会让你选择 PDF 保存位置。

后续会自动使用上次选择的位置。

想重新修改保存位置，双击：

```txt
02_修改PDF保存位置.bat
```

导出完成后，文件会分开放置：

```txt
你选择的输出目录/
├─ PDF/
│  └─ 对话标题_时间.pdf
└─ HTML/
   └─ 对话标题_时间.html
```

例如：

```txt
C:\Users\...\Desktop\聊天记录\PDF\主代码分析_20260627_054244.pdf
C:\Users\...\Desktop\聊天记录\HTML\主代码分析_20260627_054244.html
```

## 三、导出完成后继续或退出

导出完成后会出现：

```txt
下一步：
1. 继续导出其他 ChatGPT 对话
0. 退出程序并关闭窗口

请选择 1 / 0（直接回车退出并关闭窗口）：
```

输入：

```txt
1
```

继续导出其他对话。

输入：

```txt
0
```

或者直接回车，退出程序。

如果是从资源管理器里双击 `.bat` 启动，正常退出后窗口会自动关闭。  
如果是在 Cursor / PowerShell 已有终端里运行，脚本只能退出程序，不能关闭你已经打开的终端窗口。

---

## 四、刷新页面列表

选择页面时，如果新打开的 ChatGPT 页面还没显示，可以输入：

```txt
r
```

刷新页面列表。

刷新时会显示明显提示：

```txt
正在刷新页面列表...
请稍等，刷新完成后会重新显示当前 Chrome 页面。
```

刷新完成后会显示刷新次数和时间。

---

## 五、设置 PDF 里的用户名

如果 PDF 里用户名称不对，双击：

```txt
03_设定用户名.bat
```

输入你想显示的名字。

设置会保存到：

```txt
pdf_user_name.txt
```

之后生成 PDF 时会优先使用这个名字。

如果不设置，默认显示：

```txt
用户
```

---

## 六、用户端日志和开发者日志

普通用户窗口会尽量保持简洁，只显示关键进度，例如：

```txt
开始生成 PDF...
正在生成文件...
✅ 生成完成
PDF：...\PDF\xxx.pdf
网页：...\HTML\xxx.html
开发者日志：...\logs\pdf_generation_dev_log.txt
```

详细生成过程会写入开发者日志：

```txt
logs/pdf_generation_dev_log.txt
```

主程序完整运行日志在：

```txt
logs/fresh_export_select_log.txt
```

如果用户反馈问题，优先让用户发这两个日志：

```txt
logs/fresh_export_select_log.txt
logs/pdf_generation_dev_log.txt
```

---

## 七、图片附件支持

当前版本会尽量导出 ChatGPT 对话里的图片附件。

已经支持：

```txt
jpg / jpeg / png / webp / gif / bmp / svg / avif / heic / heif / tif / tiff / ico
```

图片抓取逻辑包括：

```txt
1. Network 图片资源捕获
2. DOM 图片兜底
3. 对应消息内拉取 img/link 附件
4. file_id 后端接口补抓
5. 小图附件精确 file_id 匹配
6. 消息截图兜底
```

如果图片没有完全读出，排查时需要这些文件：

```txt
captures/conversation_json.txt
captures/assets_manifest.json
captures/page_images_debug.json
captures/assets/
logs/fresh_export_select_log.txt
```

建议打包命令：

```powershell
Compress-Archive -Path ".\captures\assets_manifest.json", ".\captures\page_images_debug.json", ".\captures\conversation_json.txt", ".\captures\assets", ".\logs\fresh_export_select_log.txt" -DestinationPath ".\debug_export.zip" -Force
```

---




## 八、保留的第一版方案：Python / Playwright 版本

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


## 九、文件说明

### Node.js 版本文件

| 文件 / 目录 | 作用 |
|---|---|
| `01_双击开始导出PDF.bat` | 普通用户启动入口，双击后开始导出 |
| `02_修改输出路径工具.bat` | 修改 PDF / HTML 保存位置 |
| `03_设定用户名.bat` | 设置 PDF 里显示的用户名称 |
| `04_START_GUI.bat` | GUI 版本启动器，当前属于开发测试入口 |
| `run_fresh_export_select_page.js` | 主程序，负责连接 Chrome、选择页面、抓取 conversation JSON、抓图片附件 |
| `run_json_to_pdf_pick_output.js` | 负责读取/选择输出目录，并调用 PDF 转换逻辑 |
| `json_to_pdf.js` | 将聊天 JSON 转成 HTML 和 PDF 的核心代码 |
| `set_pdf_user_name.js` | 保存 PDF 用户名配置的脚本 |
| `package.json` | Node.js 依赖说明 |
| `package-lock.json` | 锁定依赖版本，保证安装更稳定 |
| `.gitattributes` | 固定 `.bat` 文件 CRLF 换行，避免 GitHub 下载后乱码 |
| `.gitignore` | Git 忽略规则，避免提交运行缓存 |
| `node_modules/` | npm 安装出来的依赖目录 |
| `logs/` | 运行日志目录，排查问题用 |
| `output/` | 默认输出目录，保存生成结果 |
| `pdf_output_dir.txt` | 已保存的输出目录路径 |
| `pdf_output_config.json` | 已保存的输出目录配置 |
| `electron_Gui_starter/` | 早期 GUI 启动包备份目录 |
| `Gui/` | GUI 相关文件目录，当前属于测试功能 |

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

## 十、常见问题

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



## 十一、免责声明

本项目仅用于个人学习、研究和聊天记录备份。

请不要将本工具用于违反网站服务条款、侵犯他人隐私或批量抓取数据等用途。

使用者应自行承担使用本工具产生的相关责任。
