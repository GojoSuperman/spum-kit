/**
 * 끊긴 통행 영역을 자동으로 잇는다.
 *
 * 왜 필요한가 (실측): 색 마스크에서 문 개구부가 흰색으로 안 뚫려 나오는 일이 잦다.
 * AI 가 문을 닫힌 상태로 그리거나 문틀을 벽 색으로 칠하면, 방마다 고립돼
 * 도달률이 55% 로 떨어진다 (villa7: 영역 50개, 큰 것이 2128·1354로 갈림).
 *
 * 손으로 칠해 뚫을 수도 있지만 여러 곳이라 번거롭다. 대신 **어디를 뚫을지
 * 그림 판이 알려준다** — 실제 문 자리는 바닥이 보여서 밝고, 진짜 벽은 어둡다.
 * 그래서 벽을 건널 비용을 "어두울수록 비싸게" 매기고 최소 비용 경로만 뚫는다.
 *
 * 뚫은 곳은 전부 좌표와 근거(밝기)를 남긴다 — 조용히 벽에 구멍을 내면
 * 다음 사람이 왜 그런지 모른다.
 */
import { roleWalks } from './roles.mjs';

function components(width, height, roles) {
  const label = new Int32Array(width * height).fill(-1);
  const groups = [];
  for (let i = 0; i < roles.length; i += 1) {
    if (label[i] >= 0 || !roleWalks(roles[i])) continue;
    const id = groups.length;
    const cells = [];
    const stack = [i];
    label[i] = id;
    while (stack.length) {
      const cur = stack.pop();
      cells.push(cur);
      const c = cur % width;
      const r = (cur - c) / width;
      for (const [nc, nr] of [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]) {
        if (nc < 0 || nr < 0 || nc >= width || nr >= height) continue;
        const next = nr * width + nc;
        if (label[next] >= 0 || !roleWalks(roles[next])) continue;
        label[next] = id;
        stack.push(next);
      }
    }
    groups.push({ id, cells });
  }
  groups.sort((a, b) => b.cells.length - a.cells.length);
  groups.forEach((g, index) => { for (const cell of g.cells) label[cell] = index; });
  return { label, groups };
}

/** 아주 단순한 이진 힙 — 격자 다익스트라용 */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(cost, at) {
    this.a.push([cost, at]);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p][0] <= this.a[i][0]) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  pop() {
    const top = this.a[0];
    const last = this.a.pop();
    if (this.a.length) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.a.length && this.a[l][0] < this.a[m][0]) m = l;
        if (r < this.a.length && this.a[r][0] < this.a[m][0]) m = r;
        if (m === i) break;
        [this.a[m], this.a[i]] = [this.a[i], this.a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * @param {number} width
 * @param {number} height
 * @param {string[]} roles         셀별 역할 (수정된 복사본을 돌려준다)
 * @param {number[]} brightness    셀별 밝기 0~1 (그림 판에서). 없으면 0.5 로 본다
 * @param {object} opts
 * @returns {{ roles, openings, before, after }}
 */
export function autoConnect(width, height, roles, brightness, opts = {}) {
  const minRegion = opts.minRegion ?? 12;   // 이보다 작은 조각은 무시 (가구 틈새 등)
  const maxCells = opts.maxCells ?? 5;      // 한 번에 이만큼 넘게 뚫어야 하면 포기
  // 이보다 어두운 칸은 아예 뚫지 못한다 (0 = 제한 없음). 계단·길처럼 밝은 조각은
  // 밝은 칸으로 이어지고, 어두운 담으로 둘러싸인 마당은 못 이어져 고립으로 남는다 —
  // 그런 곳에 보이지 않는 구멍을 내면 캐릭터가 벽을 통과해 다닌다 (2026-08-21 실측).
  const minBrightness = opts.minBrightness ?? 0;
  const openAs = opts.openAs ?? 'door';
  const next = [...roles];
  const openings = [];

  const before = components(width, height, next);
  if (before.groups.length === 0) return { roles: next, openings, before, after: before };

  for (let round = 0; round < 40; round += 1) {
    const { label, groups } = components(width, height, next);
    if (groups.length <= 1) break;
    const targets = groups.slice(1).filter((g) => g.cells.length >= minRegion);
    if (targets.length === 0) break;

    // 가장 큰 영역에서 전 격자로 다익스트라. 통행 칸은 0, 막힌 칸은 어두울수록 비싸다.
    const dist = new Float64Array(width * height).fill(Infinity);
    const from = new Int32Array(width * height).fill(-1);
    const heap = new Heap();
    for (const cell of groups[0].cells) { dist[cell] = 0; heap.push(0, cell); }
    while (heap.size) {
      const [d, cur] = heap.pop();
      if (d > dist[cur]) continue;
      const c = cur % width;
      const r = (cur - c) / width;
      for (const [nc, nr] of [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]) {
        if (nc < 0 || nr < 0 || nc >= width || nr >= height) continue;
        const at = nr * width + nc;
        // 통행 칸은 공짜, 막힌 칸은 1 + 어두움 벌점 (밝으면 실제 문일 가능성이 높다)
        const b = brightness ? (brightness[at] ?? 0.5) : 0.5;
        if (!roleWalks(next[at]) && b < minBrightness) continue;   // 너무 어두우면 못 뚫는다
        const step = roleWalks(next[at]) ? 0 : 1 + (1 - b) * 4;
        const nd = d + step;
        if (nd < dist[at]) { dist[at] = nd; from[at] = cur; heap.push(nd, at); }
      }
    }

    // 가장 값싸게 닿는 영역부터 연결한다
    let best = null;
    for (const g of targets) {
      for (const cell of g.cells) {
        if (dist[cell] < Infinity && (!best || dist[cell] < best.cost)) best = { cost: dist[cell], at: cell, group: g };
      }
    }
    if (!best) break;

    // 경로를 되짚어 막힌 칸만 뚫는다
    const carved = [];
    let cur = best.at;
    while (cur >= 0 && dist[cur] > 0) {
      if (!roleWalks(next[cur])) carved.push(cur);
      cur = from[cur];
    }
    if (carved.length === 0 || carved.length > maxCells) {
      // 뚫을 게 없거나 너무 두꺼우면 이 영역은 포기하고 다음 라운드에서 제외되게 표시
      openings.push({ skipped: true, size: best.group.cells.length, need: carved.length });
      // 포기한 영역을 더 건드리지 않으려면 minRegion 위로 올린다
      if (carved.length > maxCells) opts.minRegion = Math.max(minRegion, best.group.cells.length + 1);
      break;
    }
    for (const at of carved) {
      next[at] = openAs;
      openings.push({
        at,
        col: at % width,
        row: (at - (at % width)) / width,
        was: roles[at],
        brightness: brightness ? +(brightness[at] ?? 0.5).toFixed(2) : null,
        joined: best.group.cells.length,
      });
    }
  }

  const after = components(width, height, next);
  return { roles: next, openings, before, after };
}
