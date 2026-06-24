"""
连接你已打开的 Chrome，导出 ChatGPT 聊天记录为 PDF。

v2 修正版重点：
1. 收集纯文字消息，也收集用户发送的纯图片消息。
2. 不再把包含图片的 button 隐藏掉；ChatGPT 用户图片经常包在 button 里。
3. 尽量固定 img / srcset / background-image，避免打印时图片丢失。
4. 生成 PDF 前等待图片加载，并打印图片检查结果。

新增功能：
- 第一次运行时选择 PDF 输出文件夹，并写入配置文件。
- 之后在同一台电脑上运行会静默读取配置，不再询问输出文件夹。
- 如需更改输出文件夹，使用命令行参数：--change-output-dir。

使用前提：
- 先运行 start_chrome.bat，且 Chrome 里已打开具体 ChatGPT 对话页面。
- 页面里的图片本身要能正常显示。
"""

from pathlib import Path
import argparse
import json
import os
from playwright.sync_api import sync_playwright

CDP_URL = "http://127.0.0.1:9222"

MAX_STEPS = 700
WAIT_MS = 900
NO_MOVE_LIMIT = 8

INCLUDE_USER_MESSAGES = True
SAVE_DEBUG_HTML = False

APP_NAME = "chatgpt_pdf_exporter"
CONFIG_DIR = Path(os.environ.get("APPDATA", Path.home())) / APP_NAME
CONFIG_FILE = CONFIG_DIR / "config.json"


INIT_JS = r"""
() => {
    window.__pdfExportItems = [];
    window.__pdfSeenKeys = {};
    window.__pdfScroller = null;
}
"""


SETUP_SCROLLER_JS = r"""
() => {
    function isScrollable(el) {
        if (!el) return false;
        const style = getComputedStyle(el);
        return /(auto|scroll)/.test(style.overflowY)
            && el.scrollHeight > el.clientHeight + 100;
    }

    const msg = document.querySelector('[data-message-author-role]');

    if (msg) {
        let el = msg.parentElement;
        while (el && el !== document.body) {
            if (isScrollable(el)) {
                window.__pdfScroller = el;
                return {
                    found: true,
                    tag: el.tagName,
                    scrollTop: el.scrollTop,
                    scrollHeight: el.scrollHeight,
                    clientHeight: el.clientHeight
                };
            }
            el = el.parentElement;
        }
    }

    let best = document.scrollingElement || document.documentElement;
    let bestDiff = best.scrollHeight - best.clientHeight;

    for (const el of Array.from(document.querySelectorAll("*"))) {
        if (!isScrollable(el)) continue;
        const diff = el.scrollHeight - el.clientHeight;
        if (diff > bestDiff) {
            best = el;
            bestDiff = diff;
        }
    }

    window.__pdfScroller = best;

    return {
        found: true,
        tag: best.tagName,
        scrollTop: best.scrollTop,
        scrollHeight: best.scrollHeight,
        clientHeight: best.clientHeight
    };
}
"""


SCROLL_TOP_JS = r"""
() => {
    const el = window.__pdfScroller || document.scrollingElement || document.documentElement;
    el.scrollTop = 0;
    window.scrollTo(0, 0);

    return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight
    };
}
"""


SCROLL_DOWN_JS = r"""
() => {
    const el = window.__pdfScroller || document.scrollingElement || document.documentElement;

    const before = el.scrollTop;
    const step = Math.max(650, el.clientHeight * 0.68);

    el.scrollTop = Math.min(
        el.scrollTop + step,
        el.scrollHeight - el.clientHeight
    );

    const after = el.scrollTop;

    return {
        before,
        after,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 10
    };
}
"""


COLLECT_JS = r"""
() => {
    window.__pdfExportItems = window.__pdfExportItems || [];
    window.__pdfSeenKeys = window.__pdfSeenKeys || {};

    function getMessageNodes() {
        const articles = Array.from(
            document.querySelectorAll('article[data-testid^="conversation-turn"]')
        );
        if (articles.length > 0) return articles;

        const roleNodes = Array.from(
            document.querySelectorAll('[data-message-author-role]')
        );

        const nodes = [];
        const seen = new Set();

        for (const roleNode of roleNodes) {
            const box =
                roleNode.closest('article') ||
                roleNode.closest('[data-testid^="conversation-turn"]') ||
                roleNode.closest('[class*="group"]') ||
                roleNode.parentElement;

            if (!box || seen.has(box)) continue;
            seen.add(box);
            nodes.push(box);
        }

        return nodes;
    }

    function getRole(node) {
        const roleNode = node.querySelector('[data-message-author-role]');
        if (!roleNode) return '';
        return roleNode.getAttribute('data-message-author-role') || '';
    }

    function extractBackgroundUrl(backgroundImage) {
        if (!backgroundImage || backgroundImage === 'none') return '';
        const match = backgroundImage.match(/url\((['"]?)(.*?)\1\)/);
        return match ? match[2] : '';
    }

    function hasRealMedia(node) {
        if (node.querySelector('img, picture, video, canvas')) return true;

        for (const el of Array.from(node.querySelectorAll('*'))) {
            const bg = getComputedStyle(el).backgroundImage;
            const url = extractBackgroundUrl(bg);
            if (url && !url.startsWith('data:image/svg')) return true;
        }

        return false;
    }

    function mediaSignature(node) {
        const parts = [];

        for (const img of Array.from(node.querySelectorAll('img'))) {
            parts.push(img.currentSrc || img.src || img.getAttribute('src') || img.getAttribute('alt') || 'img');
            parts.push(img.getAttribute('srcset') || '');
        }

        for (const source of Array.from(node.querySelectorAll('source'))) {
            parts.push(source.srcset || source.src || 'source');
        }

        for (const el of Array.from(node.querySelectorAll('*'))) {
            const url = extractBackgroundUrl(getComputedStyle(el).backgroundImage);
            if (url && !url.startsWith('data:image/svg')) parts.push('bg:' + url);
        }

        return parts.join('|').slice(0, 1600);
    }

    function getKey(node, role, text) {
        const msgId = node.querySelector('[data-message-id]')?.getAttribute('data-message-id');
        if (msgId) return 'id:' + msgId;

        const testId = node.getAttribute('data-testid');
        if (testId) return 'tid:' + testId;

        const sig = mediaSignature(node);
        return 'txt-media:' + role + ':' + text.slice(0, 800) + ':' + sig;
    }

    function copyStableImages(srcNode, dstNode) {
        const srcImgs = Array.from(srcNode.querySelectorAll('img'));
        const dstImgs = Array.from(dstNode.querySelectorAll('img'));

        for (let i = 0; i < dstImgs.length; i++) {
            const srcImg = srcImgs[i];
            const dstImg = dstImgs[i];
            if (!srcImg || !dstImg) continue;

            const stableSrc = srcImg.currentSrc || srcImg.src || srcImg.getAttribute('src');
            const stableSrcset = srcImg.getAttribute('srcset');
            const alt = srcImg.getAttribute('alt') || '用户上传图片';

            if (stableSrc) dstImg.setAttribute('src', stableSrc);
            if (stableSrcset) dstImg.setAttribute('srcset', stableSrcset);
            dstImg.setAttribute('alt', alt);
            dstImg.setAttribute('loading', 'eager');
            dstImg.setAttribute('decoding', 'sync');
            dstImg.style.display = 'block';
            dstImg.style.maxWidth = '100%';
            dstImg.style.height = 'auto';
            dstImg.style.objectFit = 'contain';
        }
    }

    function copyBackgroundImagesAsImg(srcNode, dstNode) {
        const srcEls = [srcNode, ...Array.from(srcNode.querySelectorAll('*'))];
        const dstEls = [dstNode, ...Array.from(dstNode.querySelectorAll('*'))];

        for (let i = 0; i < Math.min(srcEls.length, dstEls.length); i++) {
            const srcEl = srcEls[i];
            const dstEl = dstEls[i];
            if (!srcEl || !dstEl) continue;

            const style = getComputedStyle(srcEl);
            const url = extractBackgroundUrl(style.backgroundImage);
            if (!url || url.startsWith('data:image/svg')) continue;

            const rect = srcEl.getBoundingClientRect();
            if (rect.width < 40 || rect.height < 40) continue;

            // 如果这个节点本来已经有 img，就不重复塞图。
            if (dstEl.querySelector && dstEl.querySelector('img')) continue;

            const img = document.createElement('img');
            img.src = url;
            img.alt = '用户上传图片';
            img.loading = 'eager';
            img.decoding = 'sync';
            img.style.display = 'block';
            img.style.maxWidth = '100%';
            img.style.width = Math.min(Math.round(rect.width), 760) + 'px';
            img.style.height = 'auto';
            img.style.objectFit = 'contain';
            img.style.borderRadius = '8px';

            dstEl.appendChild(img);
            dstEl.style.backgroundImage = 'none';
        }
    }

    function convertMediaButtonsToDiv(root) {
        for (const el of Array.from(root.querySelectorAll('button, a'))) {
            if (!el.querySelector('img, picture, video, canvas')) continue;

            const div = document.createElement('div');
            div.className = el.className || '';
            div.setAttribute('data-export-media-wrapper', 'true');
            div.style.cssText = el.style.cssText || '';
            div.style.display = 'block';
            div.style.maxWidth = '100%';
            div.style.cursor = 'default';

            while (el.firstChild) div.appendChild(el.firstChild);
            el.replaceWith(div);
        }
    }

    function cloneWithStableMedia(node) {
        const clone = node.cloneNode(true);

        copyStableImages(node, clone);
        copyBackgroundImagesAsImg(node, clone);

        const srcCanvases = Array.from(node.querySelectorAll('canvas'));
        const dstCanvases = Array.from(clone.querySelectorAll('canvas'));
        for (let i = 0; i < dstCanvases.length; i++) {
            const srcCanvas = srcCanvases[i];
            const dstCanvas = dstCanvases[i];
            if (!srcCanvas || !dstCanvas) continue;
            try {
                const img = document.createElement('img');
                img.src = srcCanvas.toDataURL('image/png');
                img.alt = '画布图片';
                img.style.maxWidth = '100%';
                img.style.height = 'auto';
                dstCanvas.replaceWith(img);
            } catch (e) {}
        }

        convertMediaButtonsToDiv(clone);
        return clone;
    }

    let added = 0;
    let mediaNodes = 0;

    const nodes = getMessageNodes();

    for (const node of nodes) {
        const role = getRole(node);
        const text = (node.innerText || '').trim();
        const hasMedia = hasRealMedia(node);

        // 关键：纯图片消息 text 可能为空，不能跳过。
        if (!role || (!text && !hasMedia)) continue;

        const key = getKey(node, role, text);
        if (window.__pdfSeenKeys[key]) continue;
        window.__pdfSeenKeys[key] = true;

        const clone = cloneWithStableMedia(node);
        const imageCount = clone.querySelectorAll('img, picture, video, canvas').length;
        mediaNodes += imageCount;

        window.__pdfExportItems.push({
            key,
            role,
            text,
            hasMedia,
            imageCount,
            html: clone.outerHTML
        });

        added += 1;
    }

    return {
        total: window.__pdfExportItems.length,
        added,
        mediaNodes
    };
}
"""


PREPARE_PRINT_JS = r"""
(options) => {
    document.getElementById('pdf-chat-export')?.remove();
    document.getElementById('pdf-export-style')?.remove();

    const includeUser = options && options.includeUser;
    const items = window.__pdfExportItems || [];

    const filtered = items.filter(item => {
        if (includeUser) return true;
        return item.role !== 'user';
    });

    if (filtered.length === 0) {
        return { ok: false, error: '没有找到可导出的聊天内容。' };
    }

    const box = document.createElement('main');
    box.id = 'pdf-chat-export';

    for (const item of filtered) {
        const wrap = document.createElement('div');
        wrap.className = 'pdf-export-turn';
        wrap.setAttribute('data-export-role', item.role || '');
        wrap.innerHTML = item.html;
        box.appendChild(wrap);
    }

    const style = document.createElement('style');
    style.id = 'pdf-export-style';
    style.textContent = `
        html,
        body {
            margin: 0 !important;
            padding: 0 !important;
            background: #ffffff !important;
            overflow: visible !important;
            height: auto !important;
            min-height: 0 !important;
        }

        body > *:not(#pdf-chat-export) {
            display: none !important;
        }

        #pdf-chat-export {
            display: block !important;
            width: 100% !important;
            max-width: 900px !important;
            margin: 0 auto !important;
            padding: 32px 32px 70px !important;
            background: #ffffff !important;
            color: #111827 !important;
            box-sizing: border-box !important;
            font-family:
                -apple-system,
                BlinkMacSystemFont,
                "Segoe UI",
                "PingFang SC",
                "Microsoft YaHei",
                "Noto Sans CJK SC",
                Arial,
                sans-serif !important;
        }

        #pdf-chat-export .pdf-export-turn {
            display: block !important;
            margin: 0 auto 22px !important;
            max-width: 840px !important;
            page-break-inside: auto !important;
            break-inside: auto !important;
        }

        #pdf-chat-export article {
            display: block !important;
            max-width: 840px !important;
            margin-left: auto !important;
            margin-right: auto !important;
            padding-left: 0 !important;
            padding-right: 0 !important;
            page-break-inside: auto !important;
            break-inside: auto !important;
        }

        #pdf-chat-export [data-message-author-role="assistant"],
        #pdf-chat-export [data-message-author-role="user"],
        #pdf-chat-export .markdown,
        #pdf-chat-export [class*="markdown"],
        #pdf-chat-export .prose,
        #pdf-chat-export [class*="prose"] {
            font-size: 17px !important;
            line-height: 1.76 !important;
            color: #111827 !important;
        }

        #pdf-chat-export img,
        #pdf-chat-export picture,
        #pdf-chat-export video,
        #pdf-chat-export canvas {
            display: block !important;
            max-width: 100% !important;
            height: auto !important;
            object-fit: contain !important;
            page-break-inside: avoid !important;
            break-inside: avoid !important;
            margin-top: 8px !important;
            margin-bottom: 8px !important;
            border-radius: 8px !important;
        }

        #pdf-chat-export [data-export-media-wrapper="true"],
        #pdf-chat-export button:has(img),
        #pdf-chat-export a:has(img),
        #pdf-chat-export button:has(picture),
        #pdf-chat-export a:has(picture) {
            display: block !important;
            max-width: 100% !important;
            background: transparent !important;
            border: 0 !important;
            padding: 0 !important;
            margin: 0 !important;
            cursor: default !important;
        }

        #pdf-chat-export .markdown p,
        #pdf-chat-export [class*="markdown"] p,
        #pdf-chat-export .prose p,
        #pdf-chat-export [class*="prose"] p {
            margin-top: 0 !important;
            margin-bottom: 1.05em !important;
        }

        #pdf-chat-export .markdown h1,
        #pdf-chat-export .markdown h2,
        #pdf-chat-export .markdown h3,
        #pdf-chat-export .markdown h4,
        #pdf-chat-export [class*="markdown"] h1,
        #pdf-chat-export [class*="markdown"] h2,
        #pdf-chat-export [class*="markdown"] h3,
        #pdf-chat-export [class*="markdown"] h4 {
            color: #111827 !important;
            font-weight: 800 !important;
            line-height: 1.35 !important;
            page-break-after: avoid !important;
        }

        #pdf-chat-export .markdown h1,
        #pdf-chat-export [class*="markdown"] h1 {
            font-size: 1.9em !important;
            margin: 1.35em 0 0.75em !important;
        }

        #pdf-chat-export .markdown h2,
        #pdf-chat-export [class*="markdown"] h2 {
            font-size: 1.48em !important;
            margin: 1.7em 0 0.75em !important;
            border-top: 1px solid #e5e7eb !important;
            padding-top: 1.05em !important;
        }

        #pdf-chat-export .markdown h3,
        #pdf-chat-export [class*="markdown"] h3 {
            font-size: 1.22em !important;
            margin: 1.35em 0 0.65em !important;
        }

        #pdf-chat-export strong {
            font-weight: 800 !important;
            color: #111827 !important;
        }

        #pdf-chat-export ul,
        #pdf-chat-export ol {
            margin-top: 0.45em !important;
            margin-bottom: 1em !important;
            padding-left: 1.55em !important;
        }

        #pdf-chat-export li {
            margin: 0.22em 0 !important;
        }

        #pdf-chat-export blockquote {
            margin: 1.15em 0 !important;
            padding: 0.15em 0 0.15em 1em !important;
            border-left: 4px solid #d1d5db !important;
            color: #111827 !important;
            font-weight: 700 !important;
            background: transparent !important;
        }

        #pdf-chat-export hr {
            border: none !important;
            border-top: 1px solid #e5e7eb !important;
            margin: 2em 0 !important;
        }

        #pdf-chat-export pre,
        #pdf-chat-export pre *,
        #pdf-chat-export code,
        #pdf-chat-export code * {
            background: #ffffff !important;
            color: #111827 !important;
            box-shadow: none !important;
            text-shadow: none !important;
        }

        #pdf-chat-export pre {
            padding: 12px 14px !important;
            border-radius: 6px !important;
            border: 1px solid #e5e7eb !important;
            overflow-x: auto !important;
            font-size: 14px !important;
            line-height: 1.6 !important;
            page-break-inside: avoid !important;
            white-space: pre-wrap !important;
        }

        #pdf-chat-export code {
            font-family: Consolas, Monaco, "Courier New", monospace !important;
        }

        #pdf-chat-export [class*="bg-black"],
        #pdf-chat-export [class*="bg-gray-900"],
        #pdf-chat-export [class*="bg-slate-900"],
        #pdf-chat-export [class*="bg-token-sidebar"],
        #pdf-chat-export [class*="dark"] {
            background: #ffffff !important;
            color: #111827 !important;
        }

        /* 不要隐藏全部 button，否则用户上传图片会被一起隐藏。
           只隐藏明显的交互控件；含图片的 button/a 上面已经强制显示。 */
        #pdf-chat-export textarea,
        #pdf-chat-export form,
        #pdf-chat-export [data-testid="copy-turn-action-button"],
        #pdf-chat-export [aria-label="Copy"],
        #pdf-chat-export [aria-label="复制"],
        #pdf-chat-export [aria-label="Edit"],
        #pdf-chat-export [aria-label="编辑"],
        #pdf-chat-export [aria-label="Share"],
        #pdf-chat-export [aria-label="分享"] {
            display: none !important;
        }

        @page {
            size: A4;
            margin: 14mm 16mm;
        }

        @media print {
            #pdf-chat-export {
                max-width: none !important;
                padding: 0 !important;
            }
        }
    `;

    document.head.appendChild(style);
    document.body.appendChild(box);

    for (const img of Array.from(box.querySelectorAll('img'))) {
        img.setAttribute('loading', 'eager');
        img.setAttribute('decoding', 'sync');
        img.style.display = 'block';
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
    }

    return {
        ok: true,
        count: filtered.length,
        mediaCount: box.querySelectorAll('img, picture, video, canvas').length,
        imageSrcs: Array.from(box.querySelectorAll('img')).map(img => img.currentSrc || img.src || img.getAttribute('src') || '').slice(0, 30),
        height: box.scrollHeight,
        html: '<!doctype html>\n' + document.documentElement.outerHTML
    };
}
"""


WAIT_IMAGES_JS = r"""
async () => {
    const imgs = Array.from(document.querySelectorAll('#pdf-chat-export img'));

    async function waitOne(img) {
        img.loading = 'eager';
        img.decoding = 'sync';

        if (!img.src && img.getAttribute('data-src')) {
            img.src = img.getAttribute('data-src');
        }

        try {
            if (img.decode) {
                await Promise.race([
                    img.decode().catch(() => {}),
                    new Promise(resolve => setTimeout(resolve, 4500))
                ]);
                return;
            }
        } catch (e) {}

        if (img.complete) return;

        await Promise.race([
            new Promise(resolve => {
                img.onload = resolve;
                img.onerror = resolve;
            }),
            new Promise(resolve => setTimeout(resolve, 4500))
        ]);
    }

    for (const img of imgs) {
        await waitOne(img);
    }

    return {
        count: imgs.length,
        loaded: imgs.filter(img => img.complete && img.naturalWidth > 0).length,
        failed: imgs.filter(img => img.complete && img.naturalWidth === 0).length,
        srcs: imgs.map(img => img.currentSrc || img.src || img.getAttribute('src') || '').slice(0, 20)
    };
}
"""


CLEANUP_JS = r"""
() => {
    document.getElementById('pdf-chat-export')?.remove();
    document.getElementById('pdf-export-style')?.remove();
    delete window.__pdfExportItems;
    delete window.__pdfSeenKeys;
    delete window.__pdfScroller;
}
"""


def get_default_output_dir() -> Path:
    """优先使用桌面；没有桌面时使用当前运行目录。"""
    desktop = Path.home() / "Desktop"
    if desktop.exists():
        return desktop
    return Path.cwd()


def load_output_dir() -> Path | None:
    try:
        if not CONFIG_FILE.exists():
            return None
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        folder = data.get("output_dir")
        if not folder:
            return None
        path = Path(folder).expanduser()
        if path.exists() and path.is_dir():
            return path
        return None
    except Exception:
        return None


def save_output_dir(folder: Path) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(
        json.dumps({"output_dir": str(folder)}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def choose_folder_by_dialog(initial_dir: Path) -> Path | None:
    """弹出 Windows 文件夹选择窗口；失败时返回 None。"""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        folder = filedialog.askdirectory(
            title="请选择 PDF 输出文件夹",
            initialdir=str(initial_dir),
            mustexist=True,
        )
        root.destroy()

        if folder:
            return Path(folder)
        return None
    except Exception:
        return None


def choose_folder_by_input(initial_dir: Path) -> Path | None:
    folder_text = input(f"请输入输出文件夹路径，直接回车使用默认：{initial_dir} ：").strip().strip('"')
    if not folder_text:
        return initial_dir
    return Path(folder_text).expanduser()


def ask_and_save_output_dir(initial_dir: Path, first_run: bool = False) -> Path:
    if first_run:
        print("第一次运行，需要先选择 PDF 输出文件夹。")
    else:
        print("正在更改 PDF 输出文件夹。")

    folder = choose_folder_by_dialog(initial_dir)
    if folder is None:
        print("没有从窗口中选择文件夹，将改用命令行输入。")
        folder = choose_folder_by_input(initial_dir)

    if folder is None:
        folder = initial_dir

    folder = folder.expanduser().resolve()
    folder.mkdir(parents=True, exist_ok=True)
    save_output_dir(folder)
    print(f"已设置输出文件夹：{folder}")
    print(f"配置文件位置：{CONFIG_FILE}")
    return folder


def resolve_output_dir(force_change: bool = False) -> Path:
    """
    输出文件夹处理逻辑：
    - 首次运行：弹窗选择并保存到配置文件。
    - 后续运行：静默读取配置文件，不再询问。
    - 需要更改：运行脚本时加 --change-output-dir。
    - 配置里的文件夹不存在：重新选择。
    """
    saved = load_output_dir()

    if force_change:
        return ask_and_save_output_dir(saved or get_default_output_dir(), first_run=False)

    if saved is not None:
        return saved

    return ask_and_save_output_dir(get_default_output_dir(), first_run=True)


def parse_args():
    parser = argparse.ArgumentParser(
        description="导出当前 Chrome 中打开的 ChatGPT 对话为 PDF。"
    )
    parser.add_argument(
        "--change-output-dir",
        "--set-output-dir",
        action="store_true",
        dest="change_output_dir",
        help="重新选择并保存 PDF 输出文件夹。",
    )
    parser.add_argument(
        "--show-config",
        action="store_true",
        help="显示配置文件位置和当前输出文件夹，然后退出。",
    )
    return parser.parse_args()


def build_output_path(output_dir: Path, output_name: str) -> Path:
    if not output_name:
        output_name = "chatgpt.pdf"

    output_path = Path(output_name).expanduser()

    # 如果用户直接输入了完整路径，就尊重完整路径；否则放到已设置的输出文件夹里。
    if output_path.is_absolute() or output_path.parent != Path("."):
        if output_path.suffix.lower() != ".pdf":
            output_path = output_path.with_suffix(".pdf")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        return output_path

    if output_path.suffix.lower() != ".pdf":
        output_path = output_path.with_suffix(".pdf")

    return output_dir / output_path.name


def collect_all_messages(page) -> int:
    page.evaluate(INIT_JS)

    scroller_info = page.evaluate(SETUP_SCROLLER_JS)
    print("滚动区域：", scroller_info)

    page.evaluate(SCROLL_TOP_JS)
    page.wait_for_timeout(1800)

    no_move_count = 0
    last_scroll_top = -1

    for step in range(1, MAX_STEPS + 1):
        info = page.evaluate(COLLECT_JS)
        print(
            f"步骤 {step}/{MAX_STEPS}，已收集 {info['total']} 条，"
            f"新增 {info['added']} 条，本步媒体元素 {info.get('mediaNodes', 0)} 个"
        )

        result = page.evaluate(SCROLL_DOWN_JS)
        page.wait_for_timeout(WAIT_MS)

        current_top = int(result["scrollTop"])

        if result["atBottom"]:
            final = page.evaluate(COLLECT_JS)
            print(f"已经到底，最终收集 {final['total']} 条。")
            break

        if current_top == last_scroll_top:
            no_move_count += 1
        else:
            no_move_count = 0

        last_scroll_top = current_top

        if no_move_count >= NO_MOVE_LIMIT:
            print("连续多次滚动位置没有变化，停止。")
            break

    final_info = page.evaluate(COLLECT_JS)
    return final_info["total"]


def main():
    args = parse_args()

    if args.show_config:
        saved = load_output_dir()
        print(f"配置文件位置：{CONFIG_FILE}")
        print(f"当前输出文件夹：{saved if saved else '尚未设置'}")
        return

    output_dir = resolve_output_dir(force_change=args.change_output_dir)
    output_name = input("请输入 PDF 文件名，例如 chatgpt.pdf：").strip()
    output_path = build_output_path(output_dir, output_name)
    output = str(output_path)
    print(f"本次 PDF 将保存到：{output_path}")

    print()
    print("请确认：")
    print("1. 已运行 start_chrome.bat")
    print("2. Chrome 里已打开具体 ChatGPT 对话页面")
    print("3. 页面内容已经正常显示，尤其是用户发出的图片已经能在页面里看见")
    print("4. 导出过程中不要切换标签页")
    print()

    input("准备好后按 Enter 开始导出...")

    with sync_playwright() as p:
        try:
            print("正在连接 Chrome...")
            browser = p.chromium.connect_over_cdp(CDP_URL)
        except Exception as e:
            print("连接 Chrome 失败，请先运行 start_chrome.bat。")
            print(e)
            return

        if not browser.contexts or not browser.contexts[0].pages:
            print("Chrome 里没有打开的页面。")
            return

        context = browser.contexts[0]
        pages = context.pages

        print()
        print("当前打开的页面：")
        for i, page in enumerate(pages):
            print(f"{i}: {page.title()} - {page.url}")

        index_text = input("请输入要导出的页面编号，直接回车默认选最后一个：").strip()

        if index_text == "":
            index = len(pages) - 1
        else:
            index = int(index_text)

        if index < 0 or index >= len(pages):
            print(f"页面编号错误，只能输入 0 到 {len(pages) - 1}")
            return

        page = pages[index]
        page.bring_to_front()
        page.wait_for_timeout(1800)

        try:
            print("开始收集聊天记录...")
            total = collect_all_messages(page)

            if total <= 0:
                print("没有收集到聊天记录，请确认打开的是具体 ChatGPT 对话页面。")
                return

            print(f"共收集到 {total} 条消息。")

            print("正在准备打印内容...")
            info = page.evaluate(PREPARE_PRINT_JS, {"includeUser": INCLUDE_USER_MESSAGES})

            if not info.get("ok"):
                print("准备失败：", info.get("error"))
                return

            print(
                f"准备完成，共 {info['count']} 条，"
                f"媒体元素 {info.get('mediaCount', 0)} 个，"
                f"内容高度约 {info['height']} 像素。"
            )

            if SAVE_DEBUG_HTML:
                debug_path = Path(output).with_suffix(".debug.html")
                try:
                    debug_path.write_text(info.get("html", ""), encoding="utf-8")
                    print(f"已保存调试 HTML：{debug_path}")
                except Exception as e:
                    print("调试 HTML 保存失败：", e)

            image_info = page.evaluate(WAIT_IMAGES_JS)
            print(
                f"图片加载检查：共 {image_info['count']} 张，"
                f"已加载 {image_info['loaded']} 张，"
                f"失败/空白 {image_info['failed']} 张。"
            )

            if image_info["count"] == 0:
                print("警告：导出内容中没有检测到图片。若原页面有图片，通常说明图片不是标准 img，需要继续适配 DOM。")

            page.wait_for_timeout(1200)
            page.emulate_media(media="screen")

            print("正在生成 PDF...")
            page.pdf(
                path=output,
                format="A4",
                print_background=True,
                prefer_css_page_size=True,
            )

            print(f"PDF 已生成：{output}")

        finally:
            try:
                page.evaluate(CLEANUP_JS)
                print("页面已恢复。")
            except Exception:
                pass

            browser.close()


if __name__ == "__main__":
    main()
