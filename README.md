# ChatGPT PDF Exporter 使用说明

## 一、项目简介

ChatGPT PDF Exporter 是一个用于导出 ChatGPT 聊天记录为 PDF 的小工具。

它可以连接到已经打开的 Chrome 浏览器，自动读取当前 ChatGPT 对话页面中的聊天内容，并将其导出为 PDF 文件。

本工具适合用于：

* 保存 ChatGPT 聊天记录
* 备份重要问答内容
* 将网页对话整理成 PDF 文档
* 便于后续查看、归档和分享

---

## 二、主要功能

本工具目前支持以下功能：

1. 连接已经打开的 Chrome 浏览器
2. 自动识别 ChatGPT 对话页面
3. 自动从页面顶部滚动到底部
4. 收集完整聊天记录
5. 尽量保留 ChatGPT 原页面的排版样式
6. 支持导出为 PDF 文件
7. 支持用户手动选择要导出的浏览器页面

---

## 三、项目文件说明

项目主要文件如下：

```text
python-web-export-tool/
├─ export_pdf.py
├─ start_chrome.bat
├─ requirements.txt
├─ README.md
└─ .gitignore
```

各文件作用如下：

| 文件名                | 作用                          |
| ------------------ | --------------------------- |
| `export_pdf.py`    | 主程序，用于连接 Chrome 并导出 PDF     |
| `start_chrome.bat` | 启动带调试端口的 Chrome 浏览器         |
| `requirements.txt` | Python 依赖库列表                |
| `README.md`        | 项目说明文档                      |
| `.gitignore`       | Git 忽略规则文件，防止上传缓存、PDF、打包文件等 |

---

## 四、运行环境要求

使用本工具前，需要电脑中已经安装：

* Windows 系统
* Python 3.10 或更高版本
* Google Chrome 浏览器

建议使用 Windows 10 或 Windows 11。

---

## 五、安装依赖

第一次运行前，需要先安装 Python 依赖。

打开 PowerShell 或命令提示符，进入项目目录：

```powershell
cd "你的项目目录"
```

例如：

```powershell
cd "E:\Uesr\Lens\00002"
```

然后执行：

```powershell
pip install -r requirements.txt
```

本项目目前主要依赖：

```text
playwright
```

安装依赖后，还需要安装 Playwright 浏览器组件：

```powershell
python -m playwright install chromium
```

---

## 六、启动 Chrome 调试模式

本工具不能直接读取普通 Chrome 页面，需要先启动一个带调试端口的 Chrome。

双击运行：

```text
start_chrome.bat
```

运行后会打开一个新的 Chrome 浏览器窗口。

请在这个 Chrome 窗口中：

1. 登录 ChatGPT
2. 打开需要导出的聊天页面
3. 确认页面内容已经正常显示

注意：导出过程中不要关闭这个 Chrome 浏览器。

---

## 七、运行导出程序

确认 ChatGPT 页面已经打开后，在项目目录中运行：

```powershell
python export_pdf.py
```

程序会提示：

```text
请输入 PDF 文件名，例如 chatgpt.pdf：
```

输入你想保存的 PDF 文件名，例如：

```text
chatgpt.pdf
```

如果没有写 `.pdf` 后缀，程序会自动补上。

然后程序会列出当前 Chrome 中打开的页面，例如：

```text
当前打开的页面：
0: ChatGPT - https://chatgpt.com/...
1: 其他页面 - https://...
```

输入要导出的页面编号。

如果直接按回车，默认选择最后一个页面。

---

## 八、使用流程总结

完整使用流程如下：

```text
1. 双击 start_chrome.bat
2. 在打开的 Chrome 中登录 ChatGPT
3. 打开需要导出的聊天页面
4. 运行 python export_pdf.py
5. 输入 PDF 文件名
6. 选择要导出的页面编号
7. 等待程序自动生成 PDF
```

---

## 九、打包为 EXE 可执行文件

如果想让别人不安装 Python 也能运行，可以使用 PyInstaller 打包。

先安装 PyInstaller：

```powershell
pip install pyinstaller
```

然后在项目目录中执行：

```powershell
python -m PyInstaller --clean --onefile --console --name chatgpt_pdf_exporter --collect-all playwright export_pdf.py
```

打包完成后，生成的 EXE 文件位于：

```text
dist/chatgpt_pdf_exporter.exe
```

使用 EXE 版本时，需要把下面两个文件放在同一个文件夹中：

```text
chatgpt_pdf_exporter.exe
start_chrome.bat
```

别人使用时：

```text
1. 双击 start_chrome.bat
2. 在 Chrome 中打开 ChatGPT 对话
3. 双击 chatgpt_pdf_exporter.exe
4. 按提示导出 PDF
```

---

## 十、GitHub 托管建议

建议上传到 GitHub 的文件：

```text
export_pdf.py
start_chrome.bat
requirements.txt
README.md
.gitignore
```

不建议上传的文件：

```text
build/
dist/
my_browser_data/
chrome_data/
__pycache__/
*.pdf
*.exe
*.spec
```

原因：

* `build/` 是打包临时文件
* `dist/` 是打包输出目录
* `my_browser_data/` 和 `chrome_data/` 可能包含浏览器缓存、Cookie 或登录信息
* `*.pdf` 是导出的结果文件
* `*.exe` 是打包后的程序
* `*.spec` 是 PyInstaller 自动生成的配置文件

---

## 十一、推荐的 .gitignore 内容

建议创建 `.gitignore` 文件，内容如下：

```gitignore
build/
dist/

my_browser_data/
chrome_data/

__pycache__/
*.pyc

*.pdf
*.exe
*.spec

.vscode/
```

这样可以避免把缓存、导出结果、浏览器数据和打包文件上传到 GitHub。

---

## 十二、常见问题

### 1. 提示找不到 `export_pdf.py`

说明当前终端不在项目目录。

先进入项目目录：

```powershell
cd "你的项目目录"
```

然后再运行：

```powershell
python export_pdf.py
```

---

### 2. 提示 `No module named 'playwright'`

说明没有安装依赖。

执行：

```powershell
pip install -r requirements.txt
```

或者：

```powershell
pip install playwright
```

然后执行：

```powershell
python -m playwright install chromium
```

---

### 3. 提示连接 Chrome 失败

请确认已经先运行：

```text
start_chrome.bat
```

并且 Chrome 没有被关闭。

---

### 4. PDF 中出现黑色代码块

这是因为程序尽量保留了 ChatGPT 原网页样式，代码块会按照网页样式显示。

如果希望改成白底黑字，需要修改 `export_pdf.py` 中的打印样式 CSS。

---

### 5. pip 下载依赖失败

如果使用代理，可以先在 PowerShell 中设置代理：

```powershell
$proxy="http://127.0.0.1:10808"
$env:HTTP_PROXY=$proxy
$env:HTTPS_PROXY=$proxy
```

然后再执行：

```powershell
pip install -r requirements.txt
```

---

## 十三、注意事项

1. 导出过程中不要关闭 Chrome。
2. 导出过程中不要切换正在导出的 ChatGPT 标签页。
3. 不要把浏览器数据目录上传到 GitHub。
4. 不要把包含个人隐私的 PDF 上传到公开仓库。
5. 如果要分享 EXE，建议通过 GitHub Releases 发布。
6. 本工具仅用于个人学习和数据备份。

---

## 十四、版本说明

当前版本为初始可用版本，主要功能是：

* 连接 Chrome
* 读取 ChatGPT 页面
* 收集聊天记录
* 导出 PDF

后续可以继续增加：

* 自定义 PDF 保存路径
* 图形化界面
* 一键启动和导出
* 自动选择 ChatGPT 页面
* 导出 Markdown 或 Word 文档
## 当前推荐使用方式

本项目目前推荐使用 Node.js 版本进行导出。

### 一键选择窗口并导出

双击运行：

```text
RUN_FRESH_EXPORT_SELECT.bat
```

程序会自动检查运行环境，并列出当前 Chrome 中打开的页面。用户只需要输入需要导出的 ChatGPT 对话页面编号，程序会自动完成：

```text
选择窗口
抓取最新 conversation JSON
检查 JSON 是否有效
生成 PDF 和 HTML
输出到指定文件夹
```

### 修改 PDF 输出目录

如需更改 PDF 保存位置，双击运行：

```text
CHANGE_PDF_OUTPUT_DIR.bat
```

选择新的输出文件夹后，程序会记住该路径。

### 不要上传的本地数据

以下目录和文件只用于本地运行，不能上传到 GitHub：

```text
chrome_data/
chrome-profile/
chrome-profile-debug/
captures/
logs/
output/
node_modules/
_old_files/
*.pdf
*.html
```

其中 `chrome-profile`、`chrome-profile-debug`、`chrome_data` 可能包含浏览器缓存、Cookie 和登录状态；`captures` 可能包含完整 ChatGPT 对话 JSON；`output` 中包含导出的 PDF 和 HTML。

---

## 十五、免责声明

本项目仅用于个人学习、研究和聊天记录备份。

请不要将本工具用于违反网站服务条款、侵犯他人隐私或批量抓取数据等用途。

使用者应自行承担使用本工具产生的相关责任。
