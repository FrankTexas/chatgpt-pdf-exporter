Electron GUI starter for ChatGPT PDF Exporter

Copy these files into chatgpt-pdf-exporter-node:

- gui/main.js
- gui/preload.js
- gui/index.html
- gui/renderer.js
- gui/styles.css
- START_GUI.bat

How to run:

1. Open chatgpt-pdf-exporter-node
2. Double-click START_GUI.bat

Or run in PowerShell:

npm install --save-dev electron
npx electron .\gui\main.js

MVP behavior:

- The GUI starts your existing run_fresh_export_select_page.js
- Logs are displayed inside the window
- When the old script asks for page number / r, type it in the GUI input box and click Send
- This is a first GUI wrapper, not a full refactor yet
