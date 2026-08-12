// 증명사진 규격 프리셋 — 데스크톱판 specs.py 를 그대로 옮긴 것.
// 여권/비자/재류카드는 공식 기준(외교부 / 일본 외무성 / 출입국재류관리청),
// official:false 는 법정 얼굴크기 규정이 없어 사진관 관례값을 쓴 항목.

export const SPECS = [
  // ---- 한국 ----
  { key: "kr-passport", label: "한국 여권", w: 35, h: 45, head: 34, headMin: 32, headMax: 36, top: 4, months: 6,
    note: "천연색만 가능. 형태를 수정한 사진 불가" },
  { key: "kr-license", label: "한국 운전면허증·주민등록증", w: 35, h: 45, head: 34, headMin: 32, headMax: 36, top: 4, months: 6 },
  { key: "kr-id", label: "한국 반명함 (이력서·일반 증명사진)", w: 30, h: 40, head: 28, headMin: 25, headMax: 31, top: 4, months: 3, official: false },
  { key: "kr-meishi", label: "한국 명함판", w: 50, h: 70, head: 48, headMin: 43, headMax: 53, top: 7, months: 6, official: false },

  // ---- 일본 ----
  { key: "jp-passport", label: "일본 여권", w: 35, h: 45, head: 34, headMin: 32, headMax: 36, top: 4, months: 6, grayOk: true,
    note: "컬러/흑백 모두 가능. 좌우 여백 각 2mm 이상" },
  { key: "jp-mynumber", label: "일본 마이넘버카드", w: 35, h: 45, head: 34, headMin: 32, headMax: 36, top: 4, months: 6, grayOk: true },
  { key: "jp-zairyu", label: "일본 재류카드·재류자격 신청", w: 30, h: 40, head: 25, headMin: 22, headMax: 28, top: 5, months: 3,
    note: "얼굴 25mm±3, 머리 위 5mm±3. 촬영 후 3개월 이내. 2매 필요" },
  { key: "jp-resume", label: "일본 이력서·취업활동", w: 30, h: 40, head: 28, headMin: 25, headMax: 31, top: 4, months: 3, official: false },
  { key: "jp-license", label: "일본 운전면허·자격시험", w: 24, h: 30, head: 21, headMin: 19, headMax: 23, top: 3, months: 6, official: false,
    note: "자격시험은 시험마다 규격이 다르니 요강 확인" },
  { key: "jp-visa", label: "일본 비자 (대사관 서면 신청)", w: 45, h: 45, head: 27, headMin: 25, headMax: 29, top: 7, months: 6,
    note: "정사각형 규격. 신청 전 해당 공관 공지 확인" },
  { key: "jp-evisa", label: "일본 eVISA (온라인 신청)", w: 35, h: 45, head: 34, headMin: 32, headMax: 36, top: 4, months: 6 },
];

export const BY_KEY = Object.fromEntries(SPECS.map((s) => [s.key, s]));

export const DPI = 300;
export const mmToPx = (mm, dpi = DPI) => (mm / 25.4) * dpi;

// 인화지 (mm). L판은 일본 편의점 멀티카피기 사진 프린트 기본 규격.
export const PAPERS = {
  L: { label: "L판 · 일본 편의점", w: 127, h: 89 },
  "2L": { label: "2L판 · 일본 편의점", w: 178, h: 127 },
  kg: { label: "KG판 · 일본", w: 152, h: 102 },
  "4x6": { label: "4×6인치 · 한국 사진관", w: 152.4, h: 101.6 },
  "5x7": { label: "5×7인치", w: 177.8, h: 127 },
  a6: { label: "A6", w: 148, h: 105 },
};

/** 인화지 한 장에 몇 장 들어가는지 (가로/세로 둘 다 시도) */
export function capacity(wMm, hMm, paper, gap = 2, margin = 3) {
  const p = PAPERS[paper];
  if (!p) return 0;
  let best = 0;
  for (const [a, b] of [[p.w, p.h], [p.h, p.w]]) {
    const cols = Math.floor((a - margin * 2 + gap) / (wMm + gap));
    const rows = Math.floor((b - margin * 2 + gap) / (hMm + gap));
    best = Math.max(best, Math.max(cols, 0) * Math.max(rows, 0));
  }
  return best;
}
