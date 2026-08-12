// 브라우저에서 도는 처리 파이프라인.
// 데스크톱판(pipeline.py / detect.py / shoulder.py / retouch.py)을 옮긴 것으로,
// 기하 계산은 동일하다. 무거운 단계(분리·검출·보정)는 analyze()에서 한 번만 하고
// 규격별 크롭은 compose()가 가볍게 반복한다.

import { mmToPx } from "./specs.js";

const CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
// 사람을 배경/머리카락/피부/옷 등으로 나눠주는 모델. 배경이 아닌 클래스를 전부 인물로 본다.
// 머리카락이 별도 클래스라 정수리 경계가 이진 셀피 모델보다 낫다.
const SEG_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite";

// FaceLandmarker 478점 인덱스 (파이썬판과 동일)
const IDX = { CHIN: 152, FOREHEAD: 10, EYE_R: [33, 133], EYE_L: [362, 263], CHEEK_R: 234, CHEEK_L: 454 };
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const EYE_BROW_R = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
const EYE_BROW_L = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398, 336, 296, 334, 293, 300, 276, 283, 282, 295, 285];
const LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];

const MAX_DARK = 20;        // 잡티 보정 상한 (이 이상 어두우면 이목구비로 보고 건드리지 않음)
const MAX_TILT_RATIO = 0.25; // 어깨 보정 상한 (머리 길이 대비)

let _face = null, _seg = null;

export async function loadModels(onProgress = () => {}) {
  if (_face && _seg) return;
  onProgress("AI 모델 불러오는 중...");
  const { FilesetResolver, FaceLandmarker, ImageSegmenter } = await import(`${CDN}`);
  const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
  onProgress("얼굴 검출 모델...");
  _face = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
    runningMode: "IMAGE",
    numFaces: 1,
    minFaceDetectionConfidence: 0.3,
  });
  onProgress("인물 분리 모델...");
  _seg = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: SEG_MODEL, delegate: "GPU" },
    runningMode: "IMAGE",
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });
}

const canvasOf = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
};

/** 긴 변이 maxSide 를 넘지 않게 축소 (모바일 메모리/속도) */
function fit(bitmap, maxSide = 1600) {
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const c = canvasOf(Math.round(bitmap.width * k), Math.round(bitmap.height * k));
  c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
  return c;
}

// ---------------------------------------------------------------- 분리
function personAlpha(canvas) {
  const res = _seg.segment(canvas);
  const cat = res.categoryMask;
  const W = cat.width, H = cat.height;
  const data = cat.getAsUint8Array();
  // 0 = 배경. 그 외(머리카락/피부/옷/기타)는 전부 인물.
  const small = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = data[i] === 0 ? 0 : 255;
    small[i * 4] = small[i * 4 + 1] = small[i * 4 + 2] = 255;
    small[i * 4 + 3] = v;
  }
  cat.close();
  res.close?.();

  // 모델 출력(256x256)을 원본 크기로 부드럽게 확대
  const sc = canvasOf(W, H);
  sc.getContext("2d").putImageData(new ImageData(small, W, H), 0, 0);
  const out = canvasOf(canvas.width, canvas.height);
  const g = out.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(sc, 0, 0, canvas.width, canvas.height);
  return g.getImageData(0, 0, canvas.width, canvas.height);
}

/** 인물 알파를 원본 위에 적용한 RGBA ImageData */
function applyAlpha(canvas, alphaImg) {
  const g = canvas.getContext("2d");
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = alphaImg.data[i];
  return img;
}

// ---------------------------------------------------------------- 검출
function faceMetrics(canvas) {
  const r = _face.detect(canvas);
  if (!r.faceLandmarks || !r.faceLandmarks.length)
    throw new Error("얼굴을 찾지 못했습니다. 정면 사진인지, 얼굴이 너무 작지 않은지 확인해 주세요.");
  const W = canvas.width, H = canvas.height;
  const pts = r.faceLandmarks[0].map((p) => [p.x * W, p.y * H]);
  const mean = (idxs) => {
    const s = idxs.reduce((a, i) => [a[0] + pts[i][0], a[1] + pts[i][1]], [0, 0]);
    return [s[0] / idxs.length, s[1] / idxs.length];
  };
  const chin = pts[IDX.CHIN], forehead = pts[IDX.FOREHEAD];
  const eyeR = mean(IDX.EYE_R), eyeL = mean(IDX.EYE_L);
  const faceW = Math.abs(pts[IDX.CHEEK_L][0] - pts[IDX.CHEEK_R][0]);
  return {
    pts,
    chinY: chin[1],
    foreheadY: forehead[1],
    faceW,
    centerX: ((eyeR[0] + eyeL[0]) / 2) * 0.6 + chin[0] * 0.4,
    rollDeg: (Math.atan2(eyeL[1] - eyeR[1], eyeL[0] - eyeR[0]) * 180) / Math.PI,
  };
}

/** 정수리 — 얼굴 폭 1.3배 띠 안에서 전경이 처음 나타나는 행.
 *  랜드마크는 이마 헤어라인까지만 있어서 머리카락 위쪽은 마스크로만 알 수 있다. */
function headTop(alpha, W, H, f) {
  const half = Math.max(f.faceW * 0.65, 8);
  const x0 = Math.max(0, Math.round(f.centerX - half));
  const x1 = Math.min(W, Math.round(f.centerX + half));
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) if (alpha.data[(y * W + x) * 4 + 3] > 128) n++;
    if (n >= 3) return y;
  }
  return Math.max(0, f.foreheadY - (f.chinY - f.foreheadY) * 0.25);
}

// ---------------------------------------------------------------- 어깨 수평
function findShoulders(alpha, W, H, f) {
  const sample = (cx) => {
    const bw = Math.max(3, Math.round(f.faceW * 0.18));
    const x0 = Math.max(0, Math.round(cx - bw / 2)), x1 = Math.min(W, Math.round(cx + bw / 2));
    const tops = [];
    for (let x = x0; x < x1; x++) {
      for (let y = Math.ceil(f.chinY) + 1; y < H; y++) {
        if (alpha.data[(y * W + x) * 4 + 3] > 128) { tops.push(y); break; }
      }
    }
    if (tops.length < 3) return null;
    tops.sort((a, b) => a - b);
    return { y: tops[Math.floor(tops.length / 2)], x: (x0 + x1) / 2 };
  };
  // 0.78 = 목에 가까운 실제 어깨 경사. 1.15로 잡으면 팔 뻗어 찍은 셀카에서
  // 한쪽이 '치켜든 팔'에 떨어져 기울기가 크게 과대 측정된다 (데스크톱판에서 실측).
  const half = f.faceW * 0.78;
  const l = sample(f.centerX - half), r = sample(f.centerX + half);
  if (!l || !r) return null;
  return { yL: l.y, yR: r.y, xL: l.x, xR: r.x, tilt: l.y - r.y };
}

/** 낮은 쪽 어깨를 '위로만' 올린다.
 *  좌우 절반씩 나눠 밀면 높은 쪽이 크롭 밖으로 빠져 어깨가 사라져 보인다. */
function levelShoulders(img, W, H, sh, chinY, headPx, strength) {
  const cap = headPx * MAX_TILT_RATIO;
  const yHigh = Math.min(sh.yL, sh.yR);
  const uL = Math.min(Math.max((sh.yL - yHigh) * strength, 0), cap);
  const uR = Math.min(Math.max((sh.yR - yHigh) * strength, 0), cap);
  if (Math.max(uL, uR) < 1) return img;

  const span = Math.max(1, sh.xR - sh.xL);
  const y0 = chinY + headPx * 0.08;
  const y1 = Math.max(y0 + headPx * 0.12, yHigh);
  const src = img.data;
  const out = new ImageData(W, H);
  const dst = out.data;

  const shiftAt = new Float32Array(W);
  for (let x = 0; x < W; x++) shiftAt[x] = Math.max(uL + ((uR - uL) * (x - sh.xL)) / span, 0);

  for (let y = 0; y < H; y++) {
    let t = (y - y0) / Math.max(1, y1 - y0);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const wy = t * t * (3 - 2 * t);                    // smoothstep
    for (let x = 0; x < W; x++) {
      const sy = y + shiftAt[x] * wy;                  // 아래에서 끌어올린다
      const y0i = Math.min(H - 1, Math.max(0, Math.floor(sy)));
      const y1i = Math.min(H - 1, y0i + 1);
      const fr = sy - y0i;
      const a = (y0i * W + x) * 4, b = (y1i * W + x) * 4, d = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) dst[d + c] = src[a + c] * (1 - fr) + src[b + c] * fr;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 피부 보정
function skinMaskCanvas(W, H, f) {
  const c = canvasOf(W, H);
  const g = c.getContext("2d");
  const poly = (idxs, fill) => {
    g.beginPath();
    idxs.forEach((i, n) => (n ? g.lineTo(f.pts[i][0], f.pts[i][1]) : g.moveTo(f.pts[i][0], f.pts[i][1])));
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  poly(FACE_OVAL, "#fff");
  g.globalCompositeOperation = "destination-out";
  for (const grp of [EYE_BROW_R, EYE_BROW_L, LIPS]) {
    // convex hull 대신 좌표 확장 사각형으로 넉넉히 파낸다 (눈썹까지 확실히 제외)
    const xs = grp.map((i) => f.pts[i][0]), ys = grp.map((i) => f.pts[i][1]);
    const pad = f.faceW * 0.03;
    g.fillStyle = "#fff";
    g.fillRect(Math.min(...xs) - pad, Math.min(...ys) - pad,
      Math.max(...xs) - Math.min(...xs) + pad * 2, Math.max(...ys) - Math.min(...ys) + pad * 2);
  }
  g.globalCompositeOperation = "source-over";
  const blurred = canvasOf(W, H);
  const bg = blurred.getContext("2d");
  bg.filter = `blur(${Math.max(2, f.faceW * 0.02)}px)`;
  bg.drawImage(c, 0, 0);
  return bg.getImageData(0, 0, W, H);
}

function blurredCopy(img, W, H, px) {
  const c = canvasOf(W, H);
  c.getContext("2d").putImageData(img, 0, 0);
  const o = canvasOf(W, H);
  const g = o.getContext("2d");
  g.filter = `blur(${px}px)`;
  g.drawImage(c, 0, 0);
  return g.getImageData(0, 0, W, H);
}

/** 잡티/모공만. 얼굴 형태는 건드리지 않는다 (밝기만 조정 + 피부 영역 한정 스무딩). */
function retouch(img, W, H, f, strength) {
  if (strength <= 0) return img;
  const mask = skinMaskCanvas(W, H, f);
  const small = blurredCopy(img, W, H, Math.max(1, f.faceW * 0.012));
  const large = blurredCopy(img, W, H, Math.max(3, f.faceW * 0.05));
  const d = img.data, s = small.data, l = large.data, m = mask.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = (m[i + 3] / 255) * strength;
    if (k <= 0.001) continue;
    // 1) 잡티: 주변보다 '조금' 어두운 곳만 끌어올림 (상한으로 이목구비 배제)
    const lumD = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const lumL = 0.299 * l[i] + 0.587 * l[i + 1] + 0.114 * l[i + 2];
    const lift = Math.min(Math.max(lumL - lumD, 0), MAX_DARK) * k;
    // 2) 모공/질감: 약한 블러를 피부에만 섞기 (최대 75%)
    const b = k * 0.75;
    for (let c = 0; c < 3; c++) {
      d[i + c] = Math.min(255, d[i + c] * (1 - b) + s[i + c] * b + lift);
    }
  }
  return img;
}

// ---------------------------------------------------------------- 공개 API
export async function analyze(bitmap, opts = {}) {
  const { retouchStrength = 0.35, shoulderStrength = 1, onProgress = () => {} } = opts;
  onProgress("인물 분리 중...");
  const canvas = fit(bitmap);
  const W = canvas.width, H = canvas.height;
  const alpha = personAlpha(canvas);

  onProgress("얼굴 검출 중...");
  let f = faceMetrics(canvas);

  // 기울기 보정 — 이미지와 알파를 같이 회전
  let rollApplied = 0;
  if (Math.abs(f.rollDeg) > 0.4) {
    const rad = (-f.rollDeg * Math.PI) / 180;      // canvas는 시계방향(+)
    const rot = canvasOf(W, H), rg = rot.getContext("2d");
    rg.translate(W / 2, H / 2); rg.rotate(rad); rg.translate(-W / 2, -H / 2);
    rg.drawImage(canvas, 0, 0);
    const ac = canvasOf(W, H); ac.getContext("2d").putImageData(alpha, 0, 0);
    const ar = canvasOf(W, H), ag = ar.getContext("2d");
    ag.translate(W / 2, H / 2); ag.rotate(rad); ag.translate(-W / 2, -H / 2);
    ag.drawImage(ac, 0, 0);
    canvas.getContext("2d").clearRect(0, 0, W, H);
    canvas.getContext("2d").drawImage(rot, 0, 0);
    const na = ag.getImageData(0, 0, W, H);
    for (let i = 3; i < alpha.data.length; i += 4) alpha.data[i] = na.data[i];
    rollApplied = f.rollDeg;
    f = faceMetrics(canvas);
  }

  const topY = headTop(alpha, W, H, f);
  const headPx = f.chinY - topY;
  if (headPx <= 1) throw new Error("정수리/턱 위치 계산에 실패했습니다.");

  let img = applyAlpha(canvas, alpha);

  onProgress("어깨·피부 보정 중...");
  let tilt = 0, fixed = false;
  if (shoulderStrength > 0) {
    const sh = findShoulders(alpha, W, H, f);
    if (sh) {
      tilt = sh.tilt;
      const before = img;
      img = levelShoulders(img, W, H, sh, f.chinY, headPx, shoulderStrength);
      fixed = img !== before;
    }
  }
  img = retouch(img, W, H, f, retouchStrength);

  const out = canvasOf(W, H);
  out.getContext("2d").putImageData(img, 0, 0);
  return { canvas: out, topY, chinY: f.chinY, centerX: f.centerX, headPx, rollApplied, tilt, fixed, W, H };
}

/** 규격 하나로 크롭 — 가볍다. 규격을 바꿔도 analyze 를 다시 하지 않는다. */
export function compose(an, spec, { bg = "#ffffff", gray = false } = {}) {
  const W = Math.round(mmToPx(spec.w));
  const H = Math.round(mmToPx(spec.h));
  const scale = mmToPx(spec.head) / an.headPx;
  const left = an.centerX * scale - W / 2;
  const top = an.topY * scale - mmToPx(spec.top);

  const c = canvasOf(W, H);
  const g = c.getContext("2d");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);            // 원본 밖으로 나가도 배경색으로 채워진다
  g.imageSmoothingQuality = "high";
  g.drawImage(an.canvas, -left, -top, an.W * scale, an.H * scale);

  if (gray) {
    const d = g.getImageData(0, 0, W, H);
    for (let i = 0; i < d.data.length; i += 4) {
      const v = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    }
    g.putImageData(d, 0, 0);
  }

  const warnings = [];
  if (scale > 1.15) warnings.push(`원본 해상도가 부족해 ${scale.toFixed(2)}배 확대했습니다. 인쇄 화질이 떨어질 수 있습니다.`);
  if (left < 0 || left + W > an.W * scale) warnings.push("좌우가 원본 밖으로 나가 배경색으로 채워졌습니다.");
  if (top + H > an.H * scale) warnings.push("어깨 아래가 원본에 없어 배경색으로 채워졌습니다.");
  if (spec.official === false) warnings.push("법정 얼굴크기 규정이 없어 관례 비율을 적용했습니다.");
  return { canvas: c, W, H, scale, warnings };
}

/** 인화용 격자 배치 */
export function makeSheet(photo, spec, paper, PAPERS, gap = 2, margin = 3) {
  const p = PAPERS[paper];
  let best = null;
  for (const [a, b] of [[p.w, p.h], [p.h, p.w]]) {
    const cols = Math.floor((a - margin * 2 + gap) / (spec.w + gap));
    const rows = Math.floor((b - margin * 2 + gap) / (spec.h + gap));
    if (!best || cols * rows > best.cols * best.rows) best = { cols, rows, pw: a, ph: b };
  }
  if (!best || best.cols < 1 || best.rows < 1) return null;

  const SW = Math.round(mmToPx(best.pw)), SH = Math.round(mmToPx(best.ph));
  const cw = Math.round(mmToPx(spec.w)), ch = Math.round(mmToPx(spec.h));
  const c = canvasOf(SW, SH), g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, SW, SH);
  const gp = mmToPx(gap);
  const ox = (SW - (best.cols * cw + (best.cols - 1) * gp)) / 2;
  const oy = (SH - (best.rows * ch + (best.rows - 1) * gp)) / 2;
  g.strokeStyle = "#c8c8c8"; g.lineWidth = 1;
  for (let r = 0; r < best.rows; r++) {
    for (let col = 0; col < best.cols; col++) {
      const x = Math.round(ox + col * (cw + gp)), y = Math.round(oy + r * (ch + gp));
      g.drawImage(photo, x, y, cw, ch);
      g.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
    }
  }
  return { canvas: c, count: best.cols * best.rows };
}
