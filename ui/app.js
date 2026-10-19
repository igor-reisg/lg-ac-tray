"use strict";

// No app usa a ponte do Tauri; aberto direto no navegador usa dados de exemplo.
const TAURI = window.__TAURI__;
const invoke = TAURI ? TAURI.core.invoke : mockInvoke;

const $ = (id) => document.getElementById(id);
const panel = $("panel");

const MODE_LABELS = {
  COOL: "Frio", AUTO: "Auto", FAN: "Ventilar", AIR_DRY: "Desumidificar",
  HEAT: "Aquecer", ENERGY_SAVING: "Economia", AIR_CLEAN: "Purificar",
};
const MODE_ICONS = {
  COOL: '<path d="M12 2v20M4.9 7l14.2 10M19.1 7 4.9 17"/><path d="m9 4 3 2 3-2M9 20l3-2 3 2"/>',
  AUTO: '<path d="M4 19 10 5h4l6 14"/><path d="M7 13h10"/>',
  FAN: '<path d="M12 12c-3-4-1-9 2-9s3 4-2 9z"/><path d="M12 12c4-3 9-1 9 2s-4 3-9-2z"/><path d="M12 12c3 4 1 9-2 9s-3-4 2-9z"/><path d="M12 12c-4 3-9 1-9-2s4-3 9 2z"/>',
  AIR_DRY: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  HEAT: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};
const FAN_LABELS = { AUTO: "Auto", LOW: "Baixa", MID: "Média", HIGH: "Alta", NATURE: "Natural", POWER: "Turbo", SLOW: "Mínima", LOW_MID: "Baixa-média", MID_HIGH: "Média-alta" };
const DURATIONS = [[0, 30], [1, 0], [2, 0], [3, 0], [4, 0], [6, 0], [8, 0]];

let profile = null;   // perfil de recursos do aparelho
let st = null;        // último estado conhecido
let holdUntil = 0;    // ignora polls logo após um comando, para não "voltar" a UI
let tempTimer = null;
let energyPeriod = "DAILY";
let pollTimer = null;

/* ------------------------------------------------------------------ */
/* utilidades                                                          */

const get = (obj, path, dflt) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj) ?? dflt;
const fmtTemp = (t) => (t == null ? "--" : Number.isInteger(t) ? String(t) : t.toFixed(1).replace(".", ","));
const fmtDur = (h, m) => [h ? `${h}h` : "", m ? `${m}min` : ""].join(" ").trim() || "0min";
const isOn = () => get(st, "operation.airConOperationMode") === "POWER_ON";
const writable = (path) => (get(profile, `property.${path}.mode`, []) || []).includes("w");
const wValues = (path) => get(profile, `property.${path}.value.w`, []);

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 4500);
}

const PAT_URL = "https://connect-pat.lgthinq.com";

// Códigos de erro da API ThinQ Connect (mesma tabela do SDK oficial `thinqconnect`).
const TOKEN_HINT = `Gere um novo em ${PAT_URL.replace("https://", "")}.`;
const ERROR_MESSAGES = {
  "1103": `Token inválido. ${TOKEN_HINT}`,
  "1218": `Token inválido. ${TOKEN_HINT}`,
  "1302": `Token não encontrado (foi apagado ou copiado errado). ${TOKEN_HINT}`,
  "1304": "Aceite os termos de uso no app LG ThinQ do celular e tente de novo.",
  "1305": "O token não tem permissão para isso. Gere um novo marcando todas as permissões.",
  "1306": "Limite de chamadas da LG atingido. Aguarde alguns minutos.",
  "1307": "A LG não suporta este país. Confira o país da sua conta LG.",
  "1308": "Sem permissão para controlar este aparelho.",
  "1309": "A LG recusou o token. Confira se marcou todas as permissões ao criá-lo. Se ainda falhar e a sua conta LG usa login do Google, tente gerar o token numa conta criada com e-mail.",
  "1310": "País errado para esta conta LG. Confira o país nas configurações.",
  "1222": "O aparelho está offline.",
  "2205": "O aparelho está num estado que não aceita comandos agora.",
  "2207": "Comando inválido para este aparelho.",
  "2208": "O aparelho não respondeu ao comando. Tente de novo.",
  "2209": "O aparelho demorou para responder. Tente de novo.",
  "2301": "O controle remoto pela internet está desativado no aparelho.",
  "2302": "Comando não disponível no estado atual.",
  "2303": "Comando não disponível: o aparelho está com erro.",
  "2304": "Ligue o ar para usar este comando.",
  "2305": "Comando não disponível neste modo.",
};

/** O back-end devolve "<status HTTP> (<código>): <mensagem>"; mostra o texto do código real. */
function friendlyError(e) {
  const s = String(e);
  const [, status, code] = s.match(/^(\d{3}) \((\d*)\)/) || [];
  if (ERROR_MESSAGES[code]) return `${ERROR_MESSAGES[code]} (código ${code})`;
  if (status === "401") return `A LG recusou o token. ${TOKEN_HINT} (${s})`;
  return s;
}

/* ------------------------------------------------------------------ */
/* estado → tela                                                       */

function render() {
  if (!st) return;
  const on = isOn();
  panel.classList.toggle("is-on", on);

  $("room-temp").textContent = `${fmtTemp(get(st, "temperature.currentTemperature"))}°C`;

  const mode = get(st, "airConJobMode.currentJobMode");
  const target = get(st, "temperature.targetTemperature");
  const templess = mode === "FAN";
  $("target-temp").textContent = templess ? "--" : fmtTemp(target);
  $("mode-label").textContent = on ? `Ligado · ${MODE_LABELS[mode] || mode}` : "Desligado";

  const slider = $("slider");
  slider.disabled = templess;
  applyTempRange(mode);
  if (!tempTimer && target != null) slider.value = target;
  updateSliderFill();

  $("eco").checked = !!get(st, "powerSave.powerSaveEnabled");
  $("light-card").classList.toggle("hidden", !writable("display.light"));
  $("display-light").checked = get(st, "display.light") !== "OFF";

  $("mode-value").textContent = MODE_LABELS[mode] || mode || "--";
  $("mode-icon").innerHTML = MODE_ICONS[mode] || MODE_ICONS.AUTO;

  const detail = get(st, "airFlow.windStrengthDetail");
  const strength = get(st, "airFlow.windStrength");
  $("fan-value").textContent = detail === "NATURE" ? "Natural" : FAN_LABELS[strength] || strength || "--";

  const sleep = st.sleepTimer || {};
  $("sleep-value").textContent = sleep.relativeStopTimer === "SET"
    ? (sleep.relativeHourToStop != null ? fmtDur(sleep.relativeHourToStop, sleep.relativeMinuteToStop) : "Ativo")
    : "Desligado";

  const wd = st.windDirection || {};
  const swings = [];
  if (wd.rotateUpDown) swings.push("Vertical");
  if (wd.rotateLeftRight) swings.push("Horizontal");
  $("swing-value").textContent = swings.join(" + ") || "Fixo";

  const timer = st.timer || {};
  let tv = "Nenhum";
  if (timer.relativeStartTimer === "SET") tv = `Liga em ${fmtDur(timer.relativeHourToStart, timer.relativeMinuteToStart)}`;
  else if (timer.relativeStopTimer === "SET") tv = `Desliga em ${fmtDur(timer.relativeHourToStop, timer.relativeMinuteToStop)}`;
  $("timer-value").textContent = tv;

  const ok = get(st, "runState.currentState") !== "ERROR";
  setStatus(ok ? "ok" : "err", ok ? "Conectado" : "Aparelho com erro");
  drawTrayIcon();
}

function setStatus(kind, text) {
  $("status").className = `status ${kind}`;
  $("status-text").textContent = text;
  $("status").title = text;
}

const MODE_TEMP_KEY = { COOL: "coolTargetTemperature", HEAT: "heatTargetTemperature", AUTO: "autoTargetTemperature" };

/** Faixa aceita no modo: o perfil pode ter limites próprios por modo (ex.: aquecer a partir de 16 °C). */
function tempRange(mode) {
  const key = MODE_TEMP_KEY[mode];
  return (key && get(profile, `property.temperature.${key}.value.w`)) || get(profile, "property.temperature.targetTemperature.value.w");
}

function applyTempRange(mode) {
  const range = tempRange(mode);
  const s = $("slider");
  if (!range) return;
  const step = range.step ?? Number(s.step);
  if (Number(s.min) === range.min && Number(s.max) === range.max && Number(s.step) === step) return;
  s.min = range.min; s.max = range.max; s.step = step;
  $("min-label").textContent = `${range.min}°`;
  $("max-label").textContent = `${range.max}°`;
}

function updateSliderFill() {
  const s = $("slider");
  const pct = ((s.value - s.min) / (s.max - s.min)) * 100;
  s.style.setProperty("--fill", `${pct}%`);
}

/* ------------------------------------------------------------------ */
/* ícone do tray: temperatura desenhada num canvas                    */

function drawTrayIcon() {
  if (!TAURI || !st) return;
  const size = 32;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const on = isOn();
  const value = on && get(st, "airConJobMode.currentJobMode") !== "FAN"
    ? get(st, "temperature.targetTemperature")
    : get(st, "temperature.currentTemperature");
  const text = value == null ? "--" : String(Math.round(value));

  if (on) {
    g.fillStyle = "#2f7fd6";
    g.beginPath();
    g.roundRect(0, 0, size, size, 7);
    g.fill();
  }
  g.fillStyle = on ? "#ffffff" : "#d0d0d6";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${text.length > 2 ? 17 : 22}px "Segoe UI", sans-serif`;
  g.fillText(text, size / 2, size / 2 + 1);

  const rgba = Array.from(g.getImageData(0, 0, size, size).data);
  const room = fmtTemp(get(st, "temperature.currentTemperature"));
  const tooltip = on
    ? `Ar ligado · ${MODE_LABELS[get(st, "airConJobMode.currentJobMode")] || ""} ${fmtTemp(get(st, "temperature.targetTemperature"))}°C\nAmbiente ${room}°C`
    : `Ar desligado\nAmbiente ${room}°C`;
  invoke("set_tray", { rgba, width: size, height: size, tooltip }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* comunicação                                                         */

async function refresh(force = false) {
  if (!force && Date.now() < holdUntil) return;
  try {
    const s = await invoke("get_state");
    if (!force && Date.now() < holdUntil) return;
    st = s;
    render();
  } catch (e) {
    setStatus("err", friendlyError(e));
  }
}

/**
 * Aplica a mudança na tela na hora e envia o comando; se falhar, mostra o erro e relê o estado.
 * Com `quiet`, quem chamou vai tentar outra coisa: não mostra erro nem relê o estado.
 */
async function send(payload, optimistic, { quiet = false } = {}) {
  if (optimistic) { optimistic(st); render(); }
  holdUntil = Date.now() + 6000;
  try {
    await invoke("control", { payload });
    setTimeout(() => refresh(true), 2500);
  } catch (e) {
    if (!quiet) {
      toast(friendlyError(e));
      holdUntil = 0;
      refresh(true);
    }
    throw e;
  }
}

async function setTemperature(t) {
  const apply = (s) => { s.temperature.targetTemperature = t; };
  const mode = get(st, "airConJobMode.currentJobMode");
  // Alguns modelos só aceitam o alvo específico do modo atual.
  const modeKey = MODE_TEMP_KEY[mode] || "coolTargetTemperature";
  const sendModeTarget = () => send({ temperature: { [modeKey]: t, unit: "C" } }, apply).catch(() => {});
  const generic = get(profile, "property.temperature.targetTemperature.value.w");
  // Fora da faixa genérica (ex.: 16 °C no aquecer), só o alvo do modo aceita o valor.
  if (generic && (t < generic.min || t > generic.max)) return sendModeTarget();
  try {
    await send({ temperature: { targetTemperature: t, unit: "C" } }, apply, { quiet: true });
  } catch {
    await sendModeTarget();
  }
}

/* ------------------------------------------------------------------ */
/* controles                                                           */

$("btn-power").onclick = () => {
  const next = isOn() ? "POWER_OFF" : "POWER_ON";
  send({ operation: { airConOperationMode: next } }, (s) => { s.operation.airConOperationMode = next; }).catch(() => {});
};

$("eco").onchange = (e) => {
  const v = e.target.checked;
  send({ powerSave: { powerSaveEnabled: v } }, (s) => { s.powerSave = { powerSaveEnabled: v }; }).catch(() => {});
};

$("slider").oninput = () => {
  const t = Number($("slider").value);
  $("target-temp").textContent = fmtTemp(t);
  updateSliderFill();
  clearTimeout(tempTimer);
  tempTimer = setTimeout(() => { tempTimer = null; setTemperature(t); }, 700);
};

function nudge(dir) {
  const s = $("slider");
  if (s.disabled) return;
  const t = Math.min(Number(s.max), Math.max(Number(s.min), Number(s.value) + dir * Number(s.step)));
  s.value = t;
  s.oninput();
}
$("btn-minus").onclick = () => nudge(-1);
$("btn-plus").onclick = () => nudge(1);

/* ---------- menus dos tiles ---------- */

const menu = $("menu");

function openMenu(anchor, items) {
  menu.innerHTML = "";
  for (const it of items) {
    if (it.sep) { menu.appendChild(Object.assign(document.createElement("div"), { className: "sep" })); continue; }
    if (it.header) { menu.appendChild(Object.assign(document.createElement("div"), { className: "hdr", textContent: it.header })); continue; }
    const b = document.createElement("button");
    b.textContent = it.label;
    if (it.selected) b.classList.add("sel");
    b.onclick = (ev) => { ev.stopPropagation(); closeMenu(); it.action(); };
    menu.appendChild(b);
  }
  menu.classList.remove("hidden");
  const pr = panel.getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(ar.left - pr.left, pr.width - mw - 10);
  let top = ar.top - pr.top - mh - 6;
  if (top < 10) top = ar.bottom - pr.top + 6;
  menu.style.left = `${Math.max(10, left)}px`;
  menu.style.top = `${top}px`;
}
function closeMenu() { menu.classList.add("hidden"); }
document.addEventListener("click", (e) => { if (!menu.contains(e.target)) closeMenu(); });

const MENUS = {
  mode() {
    const cur = get(st, "airConJobMode.currentJobMode");
    return wValues("airConJobMode.currentJobMode").map((m) => ({
      label: MODE_LABELS[m] || m, selected: m === cur,
      action: () => send({ airConJobMode: { currentJobMode: m } }, (s) => { s.airConJobMode.currentJobMode = m; }).catch(() => {}),
    }));
  },
  fan() {
    const detail = get(st, "airFlow.windStrengthDetail");
    const cur = detail === "NATURE" ? "NATURE" : get(st, "airFlow.windStrength");
    const items = wValues("airFlow.windStrength").map((v) => ({
      label: FAN_LABELS[v] || v, selected: v === cur,
      action: () => send({ airFlow: { windStrength: v } }, (s) => { s.airFlow.windStrength = v; s.airFlow.windStrengthDetail = v; }).catch(() => {}),
    }));
    if (wValues("airFlow.windStrengthDetail").includes("NATURE")) {
      items.push({
        label: "Natural", selected: cur === "NATURE",
        action: () => send({ airFlow: { windStrengthDetail: "NATURE" } }, (s) => { s.airFlow.windStrengthDetail = "NATURE"; }).catch(() => {}),
      });
    }
    return items;
  },
  sleep() {
    const active = get(st, "sleepTimer.relativeStopTimer") === "SET";
    const items = [{ header: "Desligar o ar em" }];
    for (const [h, m] of DURATIONS) {
      items.push({
        label: fmtDur(h, m),
        action: () => {
          if (!isOn()) return toast("Ligue o ar para usar o Sleep.");
          send({ sleepTimer: { relativeHourToStop: h, relativeMinuteToStop: m } },
            (s) => { s.sleepTimer = { relativeStopTimer: "SET", relativeHourToStop: h, relativeMinuteToStop: m }; }).catch(() => {});
        },
      });
    }
    items.push({ sep: true }, {
      label: "Desligado", selected: !active,
      action: () => active && send({ sleepTimer: { relativeStopTimer: "UNSET" } }, (s) => { s.sleepTimer = { relativeStopTimer: "UNSET" }; }).catch(() => {}),
    });
    return items;
  },
  swing() {
    const wd = st.windDirection || {};
    const opts = [];
    if (writable("windDirection.rotateUpDown")) opts.push(["rotateUpDown", "Vertical"]);
    if (writable("windDirection.rotateLeftRight")) opts.push(["rotateLeftRight", "Horizontal"]);
    return [{ header: "Oscilar a aleta" }, ...opts.map(([k, label]) => ({
      label, selected: !!wd[k],
      action: () => {
        const v = !wd[k];
        send({ windDirection: { [k]: v } }, (s) => { s.windDirection = { ...s.windDirection, [k]: v }; }).catch(() => {});
      },
    }))];
  },
  timer() {
    const t = st.timer || {};
    const on = isOn();
    const kind = on ? "Stop" : "Start";
    const items = [{ header: on ? "Desligar em" : "Ligar em" }];
    for (const [h, m] of DURATIONS) {
      items.push({
        label: fmtDur(h, m),
        action: () => {
          const payload = { [`relativeHourTo${kind}`]: h, ...(m ? { [`relativeMinuteTo${kind}`]: m } : {}) };
          send({ timer: payload }, (s) => { s.timer = { ...s.timer, [`relative${kind}Timer`]: "SET", [`relativeHourTo${kind}`]: h, [`relativeMinuteTo${kind}`]: m }; }).catch(() => {});
        },
      });
    }
    for (const k of ["Start", "Stop"]) {
      if (t[`relative${k}Timer`] === "SET") {
        items.push({ sep: true }, {
          label: k === "Start" ? "Cancelar timer de ligar" : "Cancelar timer de desligar",
          action: () => send({ timer: { [`relative${k}Timer`]: "UNSET" } }, (s) => { s.timer[`relative${k}Timer`] = "UNSET"; }).catch(() => {}),
        });
      }
    }
    return items;
  },
};

document.querySelectorAll(".tile[data-menu]").forEach((tile) => {
  tile.onclick = (e) => {
    e.stopPropagation();
    if (!st || !profile) return;
    if (!menu.classList.contains("hidden") && menu.dataset.owner === tile.dataset.menu) return closeMenu();
    menu.dataset.owner = tile.dataset.menu;
    openMenu(tile, MENUS[tile.dataset.menu]());
  };
});

/* ------------------------------------------------------------------ */
/* navegação                                                           */

function show(view) {
  closeMenu();
  for (const v of ["main", "energy", "settings"]) $(`view-${v}`).classList.toggle("hidden", v !== view);
}
document.querySelectorAll("[data-back]").forEach((b) => (b.onclick = () => show("main")));
$("btn-energy").onclick = () => { show("energy"); loadEnergy(); };
$("btn-settings").onclick = () => { show("settings"); loadSettings(); };
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!menu.classList.contains("hidden")) return closeMenu();
  if (TAURI) invoke("hide_popup");
});

/* ------------------------------------------------------------------ */
/* energia                                                             */

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const ym = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}`;
const kwh = (wh) => wh / 1000;
const fmtKwh = (v) => v.toLocaleString("pt-BR", { maximumFractionDigits: v < 10 ? 1 : 0 });
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

async function loadMonthTile() {
  try {
    const now = new Date();
    const r = await invoke("energy_usage", { period: "MONTHLY", start: ym(now), end: ym(now) });
    const wh = (get(r, "result.dataList", []) || []).reduce((a, d) => a + (d.energyUsage || 0), 0);
    $("energy-value").textContent = `${fmtKwh(kwh(wh))} kWh`;
  } catch {
    $("energy-value").textContent = "Indisponível";
  }
}

async function loadEnergy() {
  document.querySelectorAll("#energy-seg button").forEach((b) => b.classList.toggle("on", b.dataset.period === energyPeriod));
  $("chart").innerHTML = "";
  $("energy-total").textContent = "--";
  const now = new Date();
  let start, end;
  if (energyPeriod === "DAILY") {
    const s = new Date(now); s.setDate(s.getDate() - 29);
    start = ymd(s); end = ymd(now);
  } else {
    const s = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    start = ym(s); end = ym(now);
  }
  try {
    const r = await invoke("energy_usage", { period: energyPeriod, start, end });
    const rows = (get(r, "result.dataList", []) || [])
      .map((d) => ({ key: d.usedDate, value: kwh(d.energyUsage || 0) }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const total = rows.reduce((a, d) => a + d.value, 0);
    $("energy-total").textContent = fmtKwh(total);
    $("energy-caption").textContent = energyPeriod === "DAILY" ? "nos últimos 30 dias" : "nos últimos 12 meses";
    drawChart(rows);
  } catch (e) {
    $("energy-caption").textContent = friendlyError(e);
  }
}
document.querySelectorAll("#energy-seg button").forEach((b) => (b.onclick = () => { energyPeriod = b.dataset.period; loadEnergy(); }));

function labelFor(key, long) {
  if (key.length === 6) return long ? `${MONTHS[+key.slice(4) - 1]} ${key.slice(0, 4)}` : MONTHS[+key.slice(4) - 1];
  return long ? `${key.slice(6)}/${key.slice(4, 6)}/${key.slice(0, 4)}` : `${+key.slice(6)}/${+key.slice(4, 6)}`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

/** Colunas de série única: sem legenda, eixo Y discreto, tooltip por coluna. */
function drawChart(rows) {
  const box = $("chart");
  const W = box.clientWidth, H = box.clientHeight;
  const m = { l: 30, r: 4, t: 8, b: 20 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = niceMax(Math.max(...rows.map((d) => d.value), 0));
  const band = iw / Math.max(rows.length, 1);
  const bw = Math.min(24, Math.max(3, band - 2));
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    svg.appendChild(e);
    return e;
  };
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, y = m.t + ih - (v / max) * ih;
    el("line", { x1: m.l, x2: W - m.r, y1: y, y2: y, class: "grid" });
    el("text", { x: m.l - 6, y: y + 3, "text-anchor": "end", class: "axis" }, fmtKwh(v));
  }
  const every = rows.length > 14 ? 7 : 1;
  rows.forEach((d, i) => {
    const x = m.l + i * band + (band - bw) / 2;
    const h = Math.max((d.value / max) * ih, d.value > 0 ? 2 : 0);
    const y = m.t + ih - h;
    const r = Math.min(4, bw / 2, h);
    if (h > 0) {
      el("path", {
        class: "bar",
        d: `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${y + h}Z`,
      });
    }
    if ((rows.length - 1 - i) % every === 0) {
      el("text", { x: x + bw / 2, y: H - 4, "text-anchor": "middle", class: "axis" }, labelFor(d.key, false));
    }
    const hit = el("rect", { x: m.l + i * band, y: m.t, width: band, height: ih, class: "hit" });
    hit.onmouseenter = () => showTip(hit, d, x + bw / 2, y);
    hit.onmouseleave = hideTip;
  });
  box.appendChild(svg);
}

function showTip(hit, d, cx, cy) {
  const tip = $("tip");
  tip.innerHTML = `<b>${fmtKwh(d.value)} kWh</b>${labelFor(d.key, true)}`;
  tip.classList.remove("hidden");
  const pr = panel.getBoundingClientRect();
  const cr = $("chart").getBoundingClientRect();
  const left = Math.min(Math.max(cr.left - pr.left + cx - tip.offsetWidth / 2, 8), pr.width - tip.offsetWidth - 8);
  tip.style.left = `${left}px`;
  tip.style.top = `${cr.top - pr.top + cy - tip.offsetHeight - 8}px`;
  svgDim(hit);
}
function hideTip() { $("tip").classList.add("hidden"); svgDim(null); }
function svgDim(hit) {
  const bars = [...document.querySelectorAll("#chart .bar")];
  bars.forEach((b) => b.classList.toggle("dim", !!hit));
  if (hit) {
    const x = Number(hit.getAttribute("x")), w = Number(hit.getAttribute("width"));
    bars.forEach((b) => {
      const bx = Number(b.getAttribute("d").slice(1).split(",")[0]);
      if (bx >= x && bx < x + w) b.classList.remove("dim");
    });
  }
}

/* ------------------------------------------------------------------ */
/* configurações                                                       */

async function loadSettings() {
  const cfg = await invoke("get_config");
  $("country").value = cfg.country || "BR";
  $("token").placeholder = cfg.hasToken ? "•••••••• (salvo — cole outro para trocar)" : "thinqpat_…";
  if (TAURI) {
    invoke("plugin:autostart|is_enabled").then((v) => ($("autostart").checked = v)).catch(() => {});
  }
  const info = $("device-info");
  info.innerHTML = "";
  const add = (k, v) => { if (v != null && v !== "") info.insertAdjacentHTML("beforeend", `<dt>${k}</dt><dd>${v}</dd>`); };
  if (profile) {
    add("Aparelho", get(profile, "alias"));
    add("Modelo", get(profile, "model"));
  }
  if (st) {
    const used = get(st, "filterInfo.usedTime");
    const life = get(st, "filterInfo.filterLifetime");
    add("Filtro: uso", used != null ? `${used} h` : null);
    if (life) add("Filtro: vida útil", `${life} h`);
  }
}

$("autostart").onchange = (e) => {
  invoke(e.target.checked ? "plugin:autostart|enable" : "plugin:autostart|disable").catch((err) => toast(String(err)));
};

$("display-light").onchange = (e) => {
  const light = e.target.checked ? "ON" : "OFF";
  send({ display: { light } }, (s) => { s.display = { light }; }).catch(() => {});
};

$("pat-link").onclick = () => {
  if (TAURI) invoke("open_pat_site").catch((err) => toast(String(err)));
  else window.open(PAT_URL, "_blank");
};

$("token-form").onsubmit = async (e) => {
  e.preventDefault();
  const token = $("token").value.trim();
  const msg = $("form-msg");
  if (!token) { msg.className = "small err"; msg.textContent = "Cole o token."; return; }
  $("btn-save").disabled = true;
  msg.className = "small"; msg.textContent = "Verificando…";
  try {
    const ac = await invoke("save_config", { token, country: $("country").value || "BR" });
    $("token").value = "";
    msg.className = "small ok";
    msg.textContent = `Conectado a "${get(ac, "deviceInfo.alias", "ar-condicionado")}".`;
    await boot();
    setTimeout(() => show("main"), 900);
  } catch (err) {
    msg.className = "small err";
    msg.textContent = friendlyError(err);
  } finally {
    $("btn-save").disabled = false;
  }
};

$("btn-quit").onclick = () => invoke("quit");

/* ------------------------------------------------------------------ */
/* inicialização                                                       */

async function boot() {
  const cfg = await invoke("get_config");
  if (!cfg.hasToken) {
    show("settings");
    loadSettings();
    setStatus("err", "Configure o token");
    return;
  }
  try {
    const dev = await invoke("get_device");
    profile = { ...dev.profile, alias: get(dev, "info.deviceInfo.alias"), model: get(dev, "info.deviceInfo.modelName") };
    applyTempRange(get(st, "airConJobMode.currentJobMode"));
    const hasEnergy = (get(dev, "energyProfile.result.property", []) || []).includes("energyUsage");
    $("btn-energy").classList.toggle("hidden", !hasEnergy);
    if (hasEnergy) loadMonthTile();
  } catch (e) {
    setStatus("err", friendlyError(e));
  }
  await refresh(true);
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 30000);
}

if (TAURI) {
  TAURI.event.listen("popup-shown", () => { refresh(); if (!$("btn-energy").classList.contains("hidden")) loadMonthTile(); });
}
boot();

/* ------------------------------------------------------------------ */
/* dados de exemplo para abrir o ui/index.html direto no navegador     */

function mockInvoke(cmd, args) {
  const mock = mockInvoke.data ||= {
    state: {
      runState: { currentState: "NORMAL" }, airConJobMode: { currentJobMode: "COOL" },
      powerSave: { powerSaveEnabled: false }, temperature: { currentTemperature: 28.5, targetTemperature: 21, unit: "C" },
      filterInfo: { filterLifetime: 0, usedTime: 720 }, airFlow: { windStrength: "HIGH", windStrengthDetail: "HIGH" },
      windDirection: { rotateUpDown: true }, operation: { airConOperationMode: "POWER_ON" },
      timer: { relativeStartTimer: "UNSET", relativeStopTimer: "UNSET" }, sleepTimer: { relativeStopTimer: "UNSET" },
      display: { light: "ON" },
    },
    profile: { property: {
      airConJobMode: { currentJobMode: { mode: ["r", "w"], value: { w: ["COOL", "AUTO", "FAN", "AIR_DRY"] } } },
      airFlow: { windStrength: { mode: ["r", "w"], value: { w: ["LOW", "MID", "HIGH", "AUTO"] } }, windStrengthDetail: { mode: ["r", "w"], value: { w: ["NATURE", "LOW", "MID", "HIGH"] } } },
      windDirection: { rotateUpDown: { mode: ["r", "w"] } },
      display: { light: { mode: ["r", "w"], value: { w: ["ON", "OFF"] } } },
      temperature: { targetTemperature: { mode: ["r", "w"], value: { w: { min: 18, max: 30, step: 0.5 } } } },
    } },
  };
  const monthly = [26458, 13450, 5950, 1675, 0, 13481, 2133, 2284, 0, 0, 6947, 6843, 1210];
  switch (cmd) {
    case "get_config": return Promise.resolve({ hasToken: true, country: "BR" });
    case "get_device": return Promise.resolve({ profile: mock.profile, info: { deviceInfo: { alias: "Ar Condicionado", modelName: "RAC_056905_WW" } }, energyProfile: { result: { property: ["energyUsage"] } } });
    case "get_state": return Promise.resolve(JSON.parse(JSON.stringify(mock.state)));
    case "control": Object.assign(mock.state, JSON.parse(JSON.stringify(st))); return Promise.resolve({});
    case "energy_usage": {
      if (args.period === "MONTHLY") {
        const list = monthly.slice(-(args.start === args.end ? 1 : 12)).map((v, i, a) => {
          const d = new Date(); d.setMonth(d.getMonth() - (a.length - 1 - i));
          return { usedDate: ym(d), energyUsage: v };
        });
        return Promise.resolve({ result: { dataList: list } });
      }
      const list = Array.from({ length: 30 }, (_, i) => {
        const d = new Date(); d.setDate(d.getDate() - (29 - i));
        return { usedDate: ymd(d), energyUsage: Math.round(Math.max(0, Math.sin(i / 3) * 3000 + 2500)) };
      });
      return Promise.resolve({ result: { dataList: list } });
    }
    default: return Promise.resolve(null);
  }
}
