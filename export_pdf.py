"""
连接你已打开的 Chrome，导出 ChatGPT 聊天记录为 PDF。
特点：
1. 不截图
2. 尽量保留 ChatGPT 原页面样式
3. 自动从顶部滚到底
4. 不再因为“几步没新增消息”就提前停止
"""

from playwright.sync_api import sync_playwright

CDP_URL = "http://127.0.0.1:9222"

MAX_STEPS = 500
WAIT_MS = 700
NO_MOVE_LIMIT = 6

INCLUDE_USER_MESSAGES = True


INIT_JS = """
() => {
    window.__pdfExportItems = [];
    window.__pdfSeenKeys = {};
    window.__pdfScroller = null;
}
"""


SETUP_SCROLLER_JS = """
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


SCROLL_TOP_JS = """
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


SCROLL_DOWN_JS = """
() => {
    const el = window.__pdfScroller || document.scrollingElement || document.documentElement;

    const before = el.scrollTop;
    const step = Math.max(500, el.clientHeight * 0.72);

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


COLLECT_JS = """
() => {
    window.__pdfExportItems = window.__pdfExportItems || [];
    window.__pdfSeenKeys = window.__pdfSeenKeys || {};

    function getMessageNodes() {
        const articles = Array.from(
            document.querySelectorAll('article[data-testid^="conversation-turn"]')
        );

        if (articles.length > 0) return articles;

        const roles = Array.from(
            document.querySelectorAll("[data-message-author-role]")
        );

        const nodes = [];
        const seen = new Set();

        for (const role of roles) {
            const box =
                role.closest("article") ||
                role.closest('[class*="group"]') ||
                role.parentElement;

            if (!box || seen.has(box)) continue;

            seen.add(box);
            nodes.push(box);
        }

        return nodes;
    }

    function getRole(node) {
        const roleNode = node.querySelector("[data-message-author-role]");
        if (!roleNode) return "";
        return roleNode.getAttribute("data-message-author-role") || "";
    }

    function getKey(node, role, text) {
        const msgId = node.querySelector("[data-message-id]")?.getAttribute("data-message-id");
        if (msgId) return "id:" + msgId;

        const testId = node.getAttribute("data-testid");
        if (testId) return "tid:" + testId;

        return "txt:" + role + ":" + text.slice(0, 800);
    }

    let added = 0;

    const nodes = getMessageNodes();

    for (const node of nodes) {
        const role = getRole(node);
        const text = (node.innerText || "").trim();

        if (!role || !text) continue;

        const key = getKey(node, role, text);

        if (window.__pdfSeenKeys[key]) continue;

        window.__pdfSeenKeys[key] = true;

        window.__pdfExportItems.push({
            key,
            role,
            text,
            html: node.outerHTML
        });

        added += 1;
    }

    return {
        total: window.__pdfExportItems.length,
        added
    };
}
"""


PREPARE_PRINT_JS = """
(options) => {
    document.getElementById("pdf-chat-export")?.remove();
    document.getElementById("pdf-export-style")?.remove();

    const includeUser = options && options.includeUser;
    const items = window.__pdfExportItems || [];

    const filtered = items.filter(item => {
        if (includeUser) return true;
        return item.role !== "user";
    });

    if (filtered.length === 0) {
        return {
            ok: false,
            error: "没有找到可导出的聊天内容。"
        };
    }

    const box = document.createElement("main");
    box.id = "pdf-chat-export";

    for (const item of filtered) {
        const wrap = document.createElement("div");
        wrap.innerHTML = item.html;

        while (wrap.firstChild) {
            box.appendChild(wrap.firstChild);
        }
    }

    const style = document.createElement("style");
    style.id = "pdf-export-style";
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
            max-width: 880px !important;
            margin: 0 auto !important;
            padding: 36px 32px 70px !important;
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

        #pdf-chat-export article {
            max-width: 820px !important;
            margin-left: auto !important;
            margin-right: auto !important;
            padding-left: 0 !important;
            padding-right: 0 !important;
            page-break-inside: auto !important;
        }

        #pdf-chat-export [data-message-author-role="assistant"],
        #pdf-chat-export .markdown,
        #pdf-chat-export [class*="markdown"],
        #pdf-chat-export .prose,
        #pdf-chat-export [class*="prose"] {
            font-size: 17px !important;
            line-height: 1.76 !important;
            color: #111827 !important;
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

        #pdf-chat-export :is(button, textarea, form, [data-testid="copy-turn-action-button"]) {
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

    return {
        ok: true,
        count: filtered.length,
        height: box.scrollHeight
    };
}
"""


CLEANUP_JS = """
() => {
    document.getElementById("pdf-chat-export")?.remove();
    document.getElementById("pdf-export-style")?.remove();
    delete window.__pdfExportItems;
    delete window.__pdfSeenKeys;
    delete window.__pdfScroller;
}
"""


def collect_all_messages(page) -> int:
    page.evaluate(INIT_JS)

    scroller_info = page.evaluate(SETUP_SCROLLER_JS)
    print("滚动区域：", scroller_info)

    page.evaluate(SCROLL_TOP_JS)
    page.wait_for_timeout(1600)

    no_move_count = 0
    last_scroll_top = -1

    for step in range(1, MAX_STEPS + 1):
        info = page.evaluate(COLLECT_JS)
        print(f"步骤 {step}/{MAX_STEPS}，已收集 {info['total']} 条，新增 {info['added']} 条")

        result = page.evaluate(SCROLL_DOWN_JS)
        page.wait_for_timeout(WAIT_MS)

        current_top = int(result["scrollTop"])

        if result["atBottom"]:
            page.evaluate(COLLECT_JS)
            print("已经到底。")
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
    output = input("请输入 PDF 文件名，例如 chatgpt.pdf：").strip()

    if not output.endswith(".pdf"):
        output += ".pdf"

    print()
    print("请确认：")
    print("1. 已运行 start_chrome.bat")
    print("2. Chrome 里已打开 ChatGPT 对话页面")
    print("3. 页面内容已经正常显示")
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
        page.wait_for_timeout(1500)

        try:
            print("开始收集聊天记录...")
            total = collect_all_messages(page)

            if total <= 0:
                print("没有收集到聊天记录，请确认打开的是具体 ChatGPT 对话页面。")
                return

            print(f"共收集到 {total} 条消息。")

            print("正在准备接近原页面样式的打印内容...")
            info = page.evaluate(
                PREPARE_PRINT_JS,
                {"includeUser": INCLUDE_USER_MESSAGES}
            )

            if not info.get("ok"):
                print("准备失败：", info.get("error"))
                return

            print(f"准备完成，共 {info['count']} 条，内容高度约 {info['height']} 像素。")

            page.wait_for_timeout(1000)
            page.emulate_media(media="screen")

            print("正在生成 PDF...")
            page.pdf(
                path=output,
                format="A4",
                print_background=True,
                prefer_css_page_size=True
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