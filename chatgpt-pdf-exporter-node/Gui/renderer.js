const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const openOutputBtn = document.getElementById("openOutputBtn");
const sendBtn = document.getElementById("sendBtn");
const inputBox = document.getElementById("inputBox");
const clearBtn = document.getElementById("clearBtn");
const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");

function appendLog(text) {
  logEl.textContent += text;
  logEl.scrollTop = logEl.scrollHeight;
}

function setRunning(isRunning) {
  startBtn.disabled = isRunning;
  stopBtn.disabled = !isRunning;
  sendBtn.disabled = !isRunning;
  statusEl.textContent = isRunning ? "运行中" : "未运行";
  statusEl.className = isRunning ? "status running" : "status";
}

startBtn.addEventListener("click", async () => {
  const result = await window.exporterAPI.start();
  if (!result.ok) {
    appendLog("\n[ERROR] " + result.message + "\n");
  }
});

stopBtn.addEventListener("click", async () => {
  await window.exporterAPI.stop();
});

openOutputBtn.addEventListener("click", async () => {
  await window.exporterAPI.openOutput();
});

sendBtn.addEventListener("click", async () => {
  const value = inputBox.value.trim();
  if (!value) return;

  appendLog("\n> " + value + "\n");
  const result = await window.exporterAPI.sendInput(value);
  if (!result.ok) {
    appendLog("\n[ERROR] " + result.message + "\n");
  }
  inputBox.value = "";
  inputBox.focus();
});

inputBox.addEventListener("keydown", async (event) => {
  if (event.key === "Enter" && !sendBtn.disabled) {
    sendBtn.click();
  }
});

clearBtn.addEventListener("click", () => {
  logEl.textContent = "";
});

window.exporterAPI.onLog((text) => {
  appendLog(text);
});

window.exporterAPI.onStatus((status) => {
  setRunning(status === "running");
});

setRunning(false);
