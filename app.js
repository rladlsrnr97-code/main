// UI 글루. 처리 로직은 pipeline.js, 규격은 specs.js.
import { SPECS, BY_KEY, PAPERS, capacity, mmToPx } from "./specs.js";
import { loadModels, analyze, compose, makeSheet } from "./pipeline.js";

const $ = (id) => document.getElementById(id);
const BG_PRESETS = [["흰색", "#ffffff"], ["연파랑", "#c8d8ea"], ["회색", "#d9d9d9"], ["크림", "#f2ece0"]];

const state = {
  an: null, file: null, busy: false,
  selected: new Set(["jp-zairyu"]),
  preview: "jp-zairyu",
  bg: "#ffffff",
};

// ---------------------------------------------------------------- 렌더링
function buildSpecs() {
  $("specs").innerHTML = "";
  for (const s of SPECS) {
    const el = document.createElement("div");
    el.className = "spec" + (state.selected.has(s.key) ? " on" : "");
    el.innerHTML = `<span class="mark">${state.selected.has(s.key) ? "✓" : ""}</span>
      <span><b>${s.label}</b><small>${s.w}×${s.h}mm · 얼굴 ${s.head}mm · ${s.months}개월${
      s.official === false ? " · 관례값" : ""}</small></span>`;
    el.onclick = () => {
      state.selected.has(s.key) ? state.selected.delete(s.key) : state.selected.add(s.key);
      if (!state.selected.has(state.preview)) state.preview = [...state.selected][0] || s.key;
      buildSpecs(); buildTabs(); updatePaperHint(); render();
    };
    $("specs").appendChild(el);
  }
  const n = state.selected.size;
  $("badge").textContent = n ? `규격 ${n}종` : "규격 미선택";
  $("btnSave").disabled = $("btnSaveAll").disabled = !(state.an && n);
}

function buildTabs() {
  const t = $("tabs");
  t.innerHTML = "";
  for (const key of state.selected) {
    const b = document.createElement("button");
    b.className = "tab" + (key === state.preview ? " on" : "");
    b.textContent = key;
    b.onclick = () => { state.preview = key; buildTabs(); render(); };
    t.appendChild(b);
  }
}

function buildSwatches() {
  const w = $("swatches");
  w.innerHTML = "";
  for (const [name, hex] of BG_PRESETS) {
    const d = document.createElement("div");
    d.className = "sw" + (state.bg === hex ? " on" : "");
    d.style.background = hex;
    d.title = name;
    d.onclick = () => { state.bg = hex; buildSwatches(); render(); };
    w.appendChild(d);
  }
  const pick = document.createElement("input");
  pick.type = "color"; pick.value = state.bg;
  pick.className = "sw"; pick.style.padding = "0"; pick.title = "직접 고르기";
  pick.oninput = () => { state.bg = pick.value; buildSwatches(); render(); };
  w.appendChild(pick);
}

function buildPapers() {
  const sel = $("paper");
  sel.innerHTML = "";
  for (const [k, p] of Object.entries(PAPERS)) {
    const o = document.createElement("option");
    o.value = k; o.textContent = p.label;
    sel.appendChild(o);
  }
  sel.value = "L";
}

function updatePaperHint() {
  const on = $("sheet").checked;
  $("paperRow").hidden = !on;
  if (!on) {
    $("paperHint").textContent = "사진 파일만 저장합니다. 인쇄해서 잘라 쓸 때만 켜세요.";
    return;
  }
  const key = $("paper").value;
  const p = PAPERS[key];
  const parts = [...state.selected].slice(0, 3).map((k) => {
    const s = BY_KEY[k];
    return `${s.label.replace(/^(일본|한국) /, "")} ${capacity(s.w, s.h, key)}장`;
  });
  $("paperHint").textContent = `${p.w}×${p.h}mm 한 장에 ` + (parts.join(" · ") || "—");
}

function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), ms);
}

function stageMessage(msg) {
  $("stageMsg").textContent = msg;
  $("stageMsg").hidden = false;
  $("preview").hidden = true;
}

// ---------------------------------------------------------------- 미리보기
function render() {
  if (!state.an || !state.selected.size) return;
  const spec = BY_KEY[state.preview];
  if (!spec) return;
  const { canvas, W, H, warnings } = compose(state.an, spec, {
    bg: state.bg, gray: $("gray").checked,
  });
  const pv = $("preview");
  pv.width = W; pv.height = H;
  pv.getContext("2d").drawImage(canvas, 0, 0);
  pv.hidden = false;
  $("stageMsg").hidden = true;

  $("info").textContent =
    `${spec.label}  ·  ${spec.w}×${spec.h}mm  ·  얼굴 ${spec.head}mm  ·  ${W}×${H}px  ·  유효 ${spec.months}개월`;
  const w = $("warn");
  if (warnings.length) { w.textContent = "⚠ " + warnings.join("  /  "); w.hidden = false; }
  else w.hidden = true;
  state._last = { canvas, spec };
}

// ---------------------------------------------------------------- 처리
async function run(file) {
  if (state.busy) return;
  state.busy = true;
  $("btnSave").disabled = $("btnSaveAll").disabled = true;
  state.file = file;
  $("dropTitle").textContent = file.name;
  $("drop").classList.add("has");

  try {
    stageMessage("준비 중...");
    await loadModels(stageMessage);
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const t0 = performance.now();
    state.an = await analyze(bmp, {
      retouchStrength: +$("retouch").value / 100,
      shoulderStrength: +$("shoulder").value / 100,
      onProgress: stageMessage,
    });
    const ms = Math.round(performance.now() - t0);
    const bits = [`${(ms / 1000).toFixed(1)}초`, `기울기 ${state.an.rollApplied >= 0 ? "+" : ""}${state.an.rollApplied.toFixed(1)}도`];
    if (state.an.tilt) bits.push(`어깨 ${state.an.tilt > 0 ? "+" : ""}${Math.round(state.an.tilt)}px ${state.an.fixed ? "보정" : "차이 미미"}`);
    toast("분석 완료 · " + bits.join(" · "));
    render();
  } catch (e) {
    console.error(e);
    stageMessage("처리 실패: " + (e.message || e));
    state.an = null;
  } finally {
    state.busy = false;
    buildSpecs();
  }
}

let reanalyzeTimer = null;
function scheduleReanalyze() {
  clearTimeout(reanalyzeTimer);
  if (state.file) reanalyzeTimer = setTimeout(() => run(state.file), 500);
}

// ---------------------------------------------------------------- 저장
function download(canvas, name) {
  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, "image/jpeg", 0.95);
}

function baseName() {
  return (state.file?.name || "photo").replace(/\.[^.]+$/, "");
}

function saveOne(key) {
  const spec = BY_KEY[key];
  const { canvas } = compose(state.an, spec, { bg: state.bg, gray: $("gray").checked });
  download(canvas, `${baseName()}_${key}.jpg`);
  if ($("sheet").checked) {
    const s = makeSheet(canvas, spec, $("paper").value, PAPERS);
    if (s) download(s.canvas, `${baseName()}_${key}_sheet_${$("paper").value}.jpg`);
  }
}

// ---------------------------------------------------------------- 이벤트
function init() {
  buildSpecs(); buildTabs(); buildSwatches(); buildPapers(); updatePaperHint();

  $("btnPick").onclick = () => { $("file").removeAttribute("capture"); $("file").click(); };
  $("btnCam").onclick = () => { $("file").setAttribute("capture", "user"); $("file").click(); };
  $("drop").onclick = () => $("btnPick").click();
  $("file").onchange = (e) => e.target.files[0] && run(e.target.files[0]);

  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) run(f);
  });

  $("retouch").oninput = (e) => { $("retouchOut").textContent = e.target.value + "%"; scheduleReanalyze(); };
  $("shoulder").oninput = (e) => { $("shoulderOut").textContent = e.target.value + "%"; scheduleReanalyze(); };
  $("gray").onchange = render;
  $("sheet").onchange = updatePaperHint;
  $("paper").onchange = updatePaperHint;
  $("btnClear").onclick = () => { state.selected.clear(); buildSpecs(); buildTabs(); updatePaperHint(); };

  $("btnSave").onclick = () => { saveOne(state.preview); toast("저장했습니다"); };
  $("btnSaveAll").onclick = () => {
    [...state.selected].forEach((k, i) => setTimeout(() => saveOne(k), i * 350));
    toast(`${state.selected.size}종 저장 중...`);
  };

  // 개발용: 콘솔에서 window.__loadTest('sample.jpg') 로 테스트
  window.__loadTest = async (url) => {
    const r = await fetch(url);
    const b = await r.blob();
    await run(new File([b], url.split("/").pop(), { type: b.type }));
    return { ok: !!state.an, ...(state.an ? { headPx: Math.round(state.an.headPx), roll: state.an.rollApplied, tilt: Math.round(state.an.tilt) } : {}) };
  };
}

init();
