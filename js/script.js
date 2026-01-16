/* ==========================
   QR Code Studio
   UPGRADES:
   ✅ Cor do QR com auto-contraste
   ✅ Gerar QR de PIX (copia e cola / EMV)
   ✅ Ler QR pela webcam (scanner)
   CORREÇÃO:
   ✅ Evita erro de null (IDs ausentes) ao bindar eventos
   ========================== */

const STORAGE_THEME_KEY = "qrstudio_theme";
const STORAGE_HISTORY_KEY = "qrstudio_history_v1";
const STORAGE_QR_COLOR_KEY = "qrstudio_qr_color_v1";

let qr = null;

// Scanner
let scannerModal = null;
let html5Qr = null;
let lastScanText = "";

function $(id) {
  return document.getElementById(id);
}

const els = {
  html: document.documentElement,

  // Theme
  btnToggleTheme: $("btnToggleTheme"),
  themeIcon: $("themeIcon"),
  themeText: $("themeText"),

  // Tabs badge
  qrTypeBadge: $("qrTypeBadge"),

  // Inputs
  inputText: $("inputText"),
  wifiSsid: $("wifiSsid"),
  wifiType: $("wifiType"),
  wifiPass: $("wifiPass"),
  waNumber: $("waNumber"),
  waMessage: $("waMessage"),
  emailTo: $("emailTo"),
  emailSubject: $("emailSubject"),
  emailBody: $("emailBody"),

  // PIX
  pixKey: $("pixKey"),
  pixAmount: $("pixAmount"),
  pixTxid: $("pixTxid"),
  pixName: $("pixName"),
  pixCity: $("pixCity"),
  pixDesc: $("pixDesc"),
  btnCopyPix: $("btnCopyPix"),

  // QR Controls
  qrColor: $("qrColor"),
  contrastStatus: $("contrastStatus"),
  qrBgStatus: $("qrBgStatus"),

  // Buttons
  btnGenerate: $("btnGenerate"),
  btnCopy: $("btnCopy"),
  btnDownload: $("btnDownload"),
  btnSaveHistory: $("btnSaveHistory"),
  btnClearAll: $("btnClearAll"),

  // Scanner
  btnOpenScanner: $("btnOpenScanner"),
  btnStopScanner: $("btnStopScanner"),
  btnUseScanned: $("btnUseScanned"),
  scanResult: $("scanResult"),
  scannerModalEl: $("scannerModal"),

  // QR
  qrCode: $("qrCode"),
  contentPreview: $("contentPreview"),

  // Alerts
  alertBox: $("alertBox"),

  // History
  historyList: $("historyList"),
  historyCount: $("historyCount"),
};

function showAlert(message, type = "info") {
  if (!els.alertBox) return;

  const icons = { info: "ℹ️", success: "✅", warning: "⚠️", danger: "❌" };
  els.alertBox.style.display = "block";
  els.alertBox.textContent = `${icons[type] || "ℹ️"} ${message}`;

  els.alertBox.style.boxShadow =
    type === "success" ? "0 14px 30px rgba(33,201,122,.18)"
    : type === "warning" ? "0 14px 30px rgba(255,193,7,.18)"
    : type === "danger"  ? "0 14px 30px rgba(220,53,69,.18)"
    : "0 14px 30px rgba(0,0,0,.18)";

  clearTimeout(showAlert._t);
  showAlert._t = setTimeout(() => {
    if (els.alertBox) els.alertBox.style.display = "none";
  }, 3500);
}

function getActiveTabId() {
  const active = document.querySelector("#qrTabs .nav-link.active");
  return active ? active.id : "tab-texto";
}

function setBadgeByTab(tabId) {
  if (!els.qrTypeBadge) return;

  const map = {
    "tab-texto": "Texto/URL",
    "tab-wifi": "Wi-Fi",
    "tab-whatsapp": "WhatsApp",
    "tab-email": "E-mail",
    "tab-pix": "PIX",
  };
  els.qrTypeBadge.textContent = map[tabId] || "Texto/URL";
}

function sanitizePhoneDigits(value) {
  return (value || "").replace(/\D/g, "");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "");
}

/* ==========================
   AUTO-CONTRASTE (QR color)
   ========================== */
function hexToRgb(hex) {
  const h = (hex || "").replace("#", "").trim();
  if (h.length !== 6) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function luminance({ r, g, b }) {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

function getQrColors() {
  const chosen = els.qrColor?.value || "#111111";
  const L = luminance(hexToRgb(chosen));

  const useDarkBg = L > 0.62;

  const colorDark = chosen;
  const colorLight = useDarkBg ? "#0B1220" : "#FFFFFF";

  if (els.contrastStatus) els.contrastStatus.textContent = "Ligado ✅";
  if (els.qrBgStatus) els.qrBgStatus.textContent = useDarkBg ? "Escuro (auto)" : "Branco (auto)";

  return { colorDark, colorLight };
}

/* ==========================
   PIX (EMV / Copia e Cola)
   ========================== */
function tlv(id, value) {
  const v = String(value ?? "");
  const len = String(v.length).padStart(2, "0");
  return `${id}${len}${v}`;
}

function crc16(payload) {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
      else crc <<= 1;
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function normalizePixText(str, maxLen) {
  let s = (str || "").trim();
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.toUpperCase();
  if (maxLen) s = s.slice(0, maxLen);
  return s;
}

function buildPixPayload() {
  const key = (els.pixKey?.value || "").trim();
  if (!key) return "";

  const name = normalizePixText(els.pixName?.value || "RECEBEDOR", 25);
  const city = normalizePixText(els.pixCity?.value || "CIDADE", 15);
  const desc = (els.pixDesc?.value || "").trim();

  let amount = (els.pixAmount?.value || "").trim();
  if (amount && /^\d+([.,]\d{1,2})?$/.test(amount)) {
    amount = amount.replace(",", ".");
    if (!amount.includes(".")) amount = `${amount}.00`;
    const [i, d] = amount.split(".");
    amount = `${i}.${(d || "00").padEnd(2, "0").slice(0, 2)}`;
  } else if (amount) {
    amount = "";
  }

  const txid = normalizePixText(els.pixTxid?.value || "***", 25) || "***";

  const gui = tlv("00", "br.gov.bcb.pix");
  const maKey = tlv("01", key);
  const maDesc = desc ? tlv("02", desc) : "";
  const merchantAccount = tlv("26", `${gui}${maKey}${maDesc}`);

  const payloadFormat = tlv("00", "01");
  const pointOfInitiation = tlv("01", "12");
  const merchantCategory = tlv("52", "0000");
  const transactionCurrency = tlv("53", "986");
  const transactionAmount = amount ? tlv("54", amount) : "";
  const countryCode = tlv("58", "BR");
  const merchantName = tlv("59", name);
  const merchantCity = tlv("60", city);
  const additionalData = tlv("62", tlv("05", txid));

  let payload =
    payloadFormat +
    pointOfInitiation +
    merchantAccount +
    merchantCategory +
    transactionCurrency +
    transactionAmount +
    countryCode +
    merchantName +
    merchantCity +
    additionalData;

  const crcField = "6304";
  const crcValue = crc16(payload + crcField);
  payload = payload + crcField + crcValue;

  return payload;
}

/* ==========================
   Conteúdo por TAB
   ========================== */
function buildContentFromActiveTab() {
  const tabId = getActiveTabId();
  setBadgeByTab(tabId);

  if (tabId === "tab-texto") {
    const v = (els.inputText?.value || "").trim();
    return { type: "Texto/URL", content: v };
  }

  if (tabId === "tab-wifi") {
    const ssid = (els.wifiSsid?.value || "").trim();
    const type = els.wifiType?.value || "WPA";
    const pass = (els.wifiPass?.value || "").trim();

    if (!ssid) return { type: "Wi-Fi", content: "" };

    const safePass = type === "nopass" ? "" : pass;
    return { type: "Wi-Fi", content: `WIFI:T:${type};S:${ssid};P:${safePass};;` };
  }

  if (tabId === "tab-whatsapp") {
    const number = sanitizePhoneDigits(els.waNumber?.value);
    const msg = (els.waMessage?.value || "").trim();
    if (!number) return { type: "WhatsApp", content: "" };

    const encoded = encodeURIComponent(msg);
    const payload = msg ? `https://wa.me/55${number}?text=${encoded}` : `https://wa.me/55${number}`;
    return { type: "WhatsApp", content: payload };
  }

  if (tabId === "tab-email") {
    const to = (els.emailTo?.value || "").trim();
    const subject = (els.emailSubject?.value || "").trim();
    const body = (els.emailBody?.value || "").trim();
    if (!to) return { type: "E-mail", content: "" };

    const params = new URLSearchParams();
    if (subject) params.set("subject", subject);
    if (body) params.set("body", body);

    return { type: "E-mail", content: params.toString() ? `mailto:${to}?${params.toString()}` : `mailto:${to}` };
  }

  if (tabId === "tab-pix") {
    return { type: "PIX", content: buildPixPayload() };
  }

  return { type: "Texto/URL", content: (els.inputText?.value || "").trim() };
}

/* ==========================
   QR Render (com cores)
   ========================== */
function renderQRCode(content) {
  if (!els.qrCode) return;

  const colors = getQrColors();

  // recria para aplicar cor corretamente
  els.qrCode.innerHTML = "";
  qr = new QRCode(els.qrCode, {
    text: content || " ",
    width: 200,
    height: 200,
    correctLevel: QRCode.CorrectLevel.M,
    colorDark: colors.colorDark,
    colorLight: colors.colorLight,
  });
}

function updatePreview() {
  const { content } = buildContentFromActiveTab();

  if (els.contentPreview) {
    els.contentPreview.textContent = content ? content : "—";
  }

  renderQRCode(content || " ");
}

function copyToClipboard(text) {
  return navigator.clipboard.writeText(text);
}

function getQRImageDataUrl() {
  if (!els.qrCode) return null;

  const img = els.qrCode.querySelector("img");
  if (img && img.src) return img.src;

  const canvas = els.qrCode.querySelector("canvas");
  if (canvas) return canvas.toDataURL("image/png");

  return null;
}

function downloadPNG() {
  const dataUrl = getQRImageDataUrl();
  if (!dataUrl) {
    showAlert("Não consegui encontrar a imagem do QR para baixar.", "danger");
    return;
  }

  const { type } = buildContentFromActiveTab();
  const filename = `qrcode-${type.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}.png`;

  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  showAlert("QR Code baixado em PNG ✅", "success");
}

/* ==========================
   Histórico
   ========================== */
function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(items) {
  localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(items));
}

function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(str) {
  return (str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderHistory() {
  if (!els.historyList || !els.historyCount) return;

  const items = loadHistory();
  els.historyCount.textContent = `${items.length} item(s)`;

  if (items.length === 0) {
    els.historyList.innerHTML = `
      <div class="app-muted small">
        Nenhum QR salvo ainda. Clique em <b>Salvar no Histórico</b> 😉
      </div>
    `;
    return;
  }

  els.historyList.innerHTML = items.map((item) => `
    <div class="app-history-item" data-id="${item.id}">
      <div class="app-history-head">
        <div class="app-history-type">${item.type}</div>
        <div class="app-history-date">${formatDate(item.createdAt)}</div>
      </div>
      <div class="app-history-content">${escapeHtml(item.content)}</div>
      <div class="app-history-actions">
        <button class="btn btn-sm btn-outline-light app-btn-soft" data-action="regen">Regerar</button>
        <button class="btn btn-sm btn-outline-light app-btn-soft" data-action="copy">Copiar</button>
        <button class="btn btn-sm btn-outline-danger" data-action="delete">Excluir</button>
      </div>
    </div>
  `).join("");
}

function addToHistory() {
  const { type, content } = buildContentFromActiveTab();
  if (!content || content.trim() === "") {
    showAlert("Preencha os campos antes de salvar no histórico.", "warning");
    return;
  }

  if (type === "E-mail") {
    const to = (els.emailTo?.value || "").trim();
    if (to && !isValidEmail(to)) {
      showAlert("E-mail inválido. Ajuste o campo 'Para'.", "warning");
      return;
    }
  }

  if (type === "WhatsApp") {
    const number = sanitizePhoneDigits(els.waNumber?.value);
    if (number && number.length < 10) {
      showAlert("Número WhatsApp inválido. Use DDD + número (somente dígitos).", "warning");
      return;
    }
  }

  if (type === "PIX") {
    if (!(els.pixKey?.value || "").trim()) {
      showAlert("Informe a chave PIX antes de salvar.", "warning");
      return;
    }
    const rawAmount = (els.pixAmount?.value || "").trim();
    if (rawAmount && !/^\d+([.,]\d{1,2})?$/.test(rawAmount)) {
      showAlert("Valor PIX inválido. Ex: 10.00", "warning");
      return;
    }
  }

  const items = loadHistory();
  items.unshift({
    id: crypto.randomUUID(),
    type,
    content,
    createdAt: Date.now(),
  });

  saveHistory(items.slice(0, 30));
  renderHistory();
  showAlert("Salvo no histórico ✅", "success");
}

function clearAllHistory() {
  localStorage.removeItem(STORAGE_HISTORY_KEY);
  renderHistory();
  showAlert("Histórico limpo ✅", "success");
}

/* ==========================
   Tema (Claro/Escuro)
   ========================== */
function applyTheme(theme) {
  els.html.setAttribute("data-theme", theme);

  const isDark = theme === "dark";
  if (els.themeIcon) els.themeIcon.textContent = isDark ? "🌙" : "☀️";
  if (els.themeText) els.themeText.textContent = isDark ? "Escuro" : "Claro";

  if (els.btnToggleTheme) {
    if (isDark) {
      els.btnToggleTheme.classList.remove("btn-dark");
      els.btnToggleTheme.classList.add("btn-light");
    } else {
      els.btnToggleTheme.classList.remove("btn-light");
      els.btnToggleTheme.classList.add("btn-dark");
    }
  }

  localStorage.setItem(STORAGE_THEME_KEY, theme);
}

function toggleTheme() {
  const current = els.html.getAttribute("data-theme") || "dark";
  applyTheme(current === "dark" ? "light" : "dark");
}

/* ==========================
   Scanner Webcam
   ========================== */
async function startScanner() {
  // Se não tem modal/scanner no HTML, não faz nada
  if (!$("qr-reader")) return;

  try {
    if (!html5Qr) html5Qr = new Html5Qrcode("qr-reader");

    const devices = await Html5Qrcode.getCameras();
    if (!devices || devices.length === 0) {
      showAlert("Nenhuma câmera encontrada.", "danger");
      return;
    }

    const preferred = devices.find(d => /back|traseira|rear/i.test(d.label)) || devices[0];

    await html5Qr.start(
      { deviceId: { exact: preferred.id } },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decodedText) => {
        lastScanText = decodedText;
        if (els.scanResult) els.scanResult.textContent = decodedText;
      }
    );

    showAlert("Scanner iniciado ✅", "success");
  } catch {
    showAlert("Permissão de câmera negada ou erro ao iniciar.", "danger");
  }
}

async function stopScanner() {
  try {
    if (html5Qr) {
      // stop pode falhar se não estiver rodando, então deixamos em try/catch
      await html5Qr.stop().catch(() => {});
      await html5Qr.clear().catch(() => {});
    }
  } catch {
    // ignora
  }
}

function openScannerModal() {
  // pega o modal no momento do clique (agora ele já existe no DOM)
  const modalEl = $("scannerModal");

  if (!modalEl) {
    showAlert("Modal do scanner não encontrado no HTML (scannerModal).", "warning");
    return;
  }

  if (!scannerModal) scannerModal = new bootstrap.Modal(modalEl);

  if (els.scanResult) els.scanResult.textContent = "—";
  lastScanText = "";
  scannerModal.show();
}

function useScanned() {
  if (!lastScanText) {
    showAlert("Nenhum QR lido ainda. Aponte a câmera para um QR.", "warning");
    return;
  }

  const tabTexto = $("tab-texto");
  if (tabTexto) tabTexto.click();

  if (els.inputText) els.inputText.value = lastScanText;

  updatePreview();
  showAlert("Conteúdo do scanner aplicado ✅", "success");

  if (scannerModal) scannerModal.hide();
}

/* ==========================
   Eventos
   ========================== */
function bindLivePreview() {
  const inputs = [
    els.inputText, els.wifiSsid, els.wifiType, els.wifiPass,
    els.waNumber, els.waMessage, els.emailTo, els.emailSubject, els.emailBody,
    els.pixKey, els.pixAmount, els.pixTxid, els.pixName, els.pixCity, els.pixDesc,
    els.qrColor,
  ].filter(Boolean);

  inputs.forEach((el) => {
    el.addEventListener("input", updatePreview);
    el.addEventListener("change", updatePreview);
  });

  document.querySelectorAll("#qrTabs .nav-link").forEach((btn) => {
    btn.addEventListener("shown.bs.tab", updatePreview);
  });
}

function bindButtons() {
  // ✅ Cada um só é bindado se existir
  els.btnToggleTheme?.addEventListener("click", toggleTheme);

  els.btnGenerate?.addEventListener("click", () => {
    const { content } = buildContentFromActiveTab();
    if (!content || content.trim() === "") {
      showAlert("Preencha os campos antes de gerar o QR.", "warning");
      updatePreview();
      return;
    }
    updatePreview();
    showAlert("QR gerado ✅", "success");
  });

  els.btnCopy?.addEventListener("click", async () => {
    const { content } = buildContentFromActiveTab();
    if (!content || content.trim() === "") {
      showAlert("Nada para copiar. Preencha os campos.", "warning");
      return;
    }
    try {
      await copyToClipboard(content);
      showAlert("Conteúdo copiado 📋", "success");
    } catch {
      showAlert("Não consegui copiar. Seu navegador pode bloquear essa ação.", "danger");
    }
  });

  els.btnDownload?.addEventListener("click", () => {
    const { content } = buildContentFromActiveTab();
    if (!content || content.trim() === "") {
      showAlert("Gere um QR antes de baixar.", "warning");
      return;
    }
    updatePreview();
    downloadPNG();
  });

  els.btnSaveHistory?.addEventListener("click", addToHistory);
  els.btnClearAll?.addEventListener("click", clearAllHistory);

  els.btnCopyPix?.addEventListener("click", async () => {
    const payload = buildPixPayload();
    if (!payload) {
      showAlert("Informe a chave PIX para copiar.", "warning");
      return;
    }
    try {
      await copyToClipboard(payload);
      showAlert("PIX (copia e cola) copiado 📋💸", "success");
    } catch {
      showAlert("Não consegui copiar. Seu navegador pode bloquear essa ação.", "danger");
    }
  });

  // Scanner
  els.btnOpenScanner?.addEventListener("click", openScannerModal);
  els.btnStopScanner?.addEventListener("click", async () => {
    await stopScanner();
    showAlert("Scanner parado.", "info");
  });
  els.btnUseScanned?.addEventListener("click", useScanned);

  // Eventos do modal (se existir)
  const modalEl = $("scannerModal");
  if (modalEl) {
    modalEl.addEventListener("shown.bs.modal", startScanner);
    modalEl.addEventListener("hidden.bs.modal", stopScanner);
  }
}

function bindHistoryActions() {
  if (!els.historyList) return;

  els.historyList.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;

    const action = btn.getAttribute("data-action");
    const itemEl = btn.closest(".app-history-item");
    if (!itemEl) return;

    const id = itemEl.getAttribute("data-id");
    const items = loadHistory();
    const item = items.find((x) => x.id === id);
    if (!item) return;

    if (action === "regen") {
      $("tab-texto")?.click();
      if (els.inputText) els.inputText.value = item.content;
      updatePreview();
      showAlert("QR regerado a partir do histórico ✅", "success");
    }

    if (action === "copy") {
      try {
        await copyToClipboard(item.content);
        showAlert("Copiado do histórico 📋", "success");
      } catch {
        showAlert("Não consegui copiar. Seu navegador pode bloquear essa ação.", "danger");
      }
    }

    if (action === "delete") {
      const filtered = items.filter((x) => x.id !== id);
      saveHistory(filtered);
      renderHistory();
      showAlert("Item removido do histórico 🗑️", "success");
    }
  });
}

/* ==========================
   Init
   ========================== */
function init() {
  // Tema salvo
  const savedTheme = localStorage.getItem(STORAGE_THEME_KEY) || "dark";
  applyTheme(savedTheme);

  // cor do QR salva
  const savedQrColor = localStorage.getItem(STORAGE_QR_COLOR_KEY);
  if (savedQrColor && els.qrColor) els.qrColor.value = savedQrColor;

  els.qrColor?.addEventListener("change", () => {
    localStorage.setItem(STORAGE_QR_COLOR_KEY, els.qrColor.value);
    updatePreview();
  });

  updatePreview();
  bindLivePreview();
  bindButtons();
  bindHistoryActions();
  renderHistory();
}

document.addEventListener("DOMContentLoaded", init);
