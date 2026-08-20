/**
 * 역할 색 체계 — 한 곳에서 정의하고 모든 화면이 이걸 쓴다.
 *
 * 왜 여기 모았나: 미리보기·칠하기·진단 이미지가 각자 다른 색을 쓰고 있었다.
 * 같은 데이터인데 화면마다 색이 달라서 "빨강이 막힘인가?"를 되묻게 만들었다.
 *
 * 규칙 하나로 읽는다:
 *   **흐린 색 = 지나갈 수 있음 · 진한 색 = 막힘.**
 *   색조는 "왜" 를 말한다 (빨강 벽 · 주황 가구 · 초록 식재 · 파랑 물 · 청록 창문).
 */
export const ROLES = Object.freeze([
  { key: 'floor', ko: '실내 바닥', walk: true, rgb: [90, 230, 140], alpha: 0.20 },
  { key: 'outside', ko: '야외 지면', walk: true, rgb: [120, 205, 225], alpha: 0.20 },
  { key: 'door', ko: '문 (열림)', walk: true, rgb: [235, 225, 120], alpha: 0.26 },
  { key: 'decoration', ko: '장식', walk: true, rgb: [200, 230, 150], alpha: 0.20 },
  { key: 'wall', ko: '벽', walk: false, rgb: [240, 70, 70], alpha: 0.52 },
  { key: 'furniture', ko: '가구', walk: false, rgb: [255, 150, 40], alpha: 0.52 },
  { key: 'prop', ko: '가구', walk: false, rgb: [255, 150, 40], alpha: 0.52 },
  { key: 'plant', ko: '식재', walk: false, rgb: [40, 200, 80], alpha: 0.55 },
  { key: 'water', ko: '물', walk: false, rgb: [70, 150, 255], alpha: 0.55 },
  { key: 'window', ko: '창문', walk: false, rgb: [60, 220, 230], alpha: 0.55 },
  { key: 'blocked', ko: '막힘', walk: false, rgb: [240, 70, 70], alpha: 0.52 },
]);

const BY_KEY = new Map(ROLES.map((r) => [r.key, r]));

export function role(key) {
  return BY_KEY.get(String(key)) || BY_KEY.get('floor');
}

export function roleWalks(key) {
  return role(key).walk;
}

export function rgba(key, alphaOverride = null) {
  const r = role(key);
  const a = alphaOverride == null ? r.alpha : alphaOverride;
  return `rgba(${r.rgb[0]},${r.rgb[1]},${r.rgb[2]},${a})`;
}

/** 종류별 색 CSS — `[data-r=wall]{background:…}` 형태 */
export function roleCss(selector = 'i') {
  const seen = new Set();
  return ROLES.filter((r) => {
    if (seen.has(r.key)) return false;
    seen.add(r.key);
    return true;
  }).map((r) => `${selector}[data-r=${r.key}]{background:${rgba(r.key)}}`).join('\n');
}

/** 통행/막힘 2색 CSS — 왜 막혔는지는 안 보고 통행만 본다 */
export function binaryCss(selector = 'i') {
  const walk = ROLES.filter((r) => r.walk).map((r) => `${selector}[data-r=${r.key}]`).join(',');
  const block = ROLES.filter((r) => !r.walk).map((r) => `${selector}[data-r=${r.key}]`).join(',');
  return `${walk}{background:rgba(90,230,140,.22)}\n${block}{background:rgba(240,70,70,.50)}`;
}

/** 범례 HTML — 화면마다 같은 순서로 보여준다 */
export function legendHtml() {
  const seen = new Set();
  const items = ROLES.filter((r) => {
    const dup = seen.has(r.ko);
    seen.add(r.ko);
    return !dup;
  });
  return items.map((r) => (
    `<span class="lg"><i style="background:${rgba(r.key, Math.min(1, r.alpha * 1.8))}"></i>${r.ko}${r.walk ? '' : ' <b>막힘</b>'}</span>`
  )).join('');
}

export const LEGEND_CSS = `
.lg{display:inline-flex;align-items:center;gap:5px;margin-right:12px;font-size:12px;color:#9aa3ad}
.lg i{width:13px;height:13px;border-radius:3px;border:1px solid rgba(255,255,255,.18);display:inline-block}
.lg b{color:#f09a9a;font-weight:600}
`;
