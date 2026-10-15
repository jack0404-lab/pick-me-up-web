/* =========================================================
 * scoring.js — 추천 계산 로직 (화면과 분리된 순수 함수)
 * 명세서(2트랙 스코어링) 기준으로 통일한 버전
 * ========================================================= */

const MARKS = ["◎", "○", "▲", "△", "복병"];                 // 정보지 평점 종류
const STYLES = ["선행", "선입", "추입"];                      // 주행 습성
const TAGS = ["종반G3F우수", "단독선행", "기수상향", "거리적성", "감량잇점", "게이트잇점"];
const MARK_SCORE = { "◎": 35, "○": 26, "▲": 18, "복병": 15, "△": 12 }; // 평점 가중치

// 문자열·숫자 어떤 값이 와도 숫자로 바꿈 (못 바꾸면 기본값)
function toNum(v, d = 0) {
  if (v === null || v === undefined) return d;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : d;
}

// AI 판독·저장 데이터가 어떤 모양이든 앱이 쓰는 형태로 정리 (버그 1 수정)
function normalizeHorse(raw = {}) {
  let mark = String(raw.mark ?? "").trim();
  if (mark === "★") mark = "복병";                            // ★ 표기도 복병으로 인정
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  return {
    num: Math.round(toNum(raw.num, 0)),
    name: String(raw.name ?? "").trim().slice(0, 20),
    winOdds: toNum(raw.winOdds, 0),                           // 0 = 아직 모름
    placeOdds: toNum(raw.placeOdds, 0),
    mark: MARKS.includes(mark) ? mark : "△",
    style: STYLES.includes(raw.style) ? raw.style : "선입",
    tags: [...new Set(tags.filter(t => TAGS.includes(t)))],   // 허용 태그만, 중복 제거
    jockey: String(raw.jockey ?? "").slice(0, 10),            // 출전표 API에서 채움
    weight: toNum(raw.weight, 0)                              // 부담중량
  };
}

// 두 마번 조합 키: 항상 작은 번호가 앞 ("3-7")
function pairKey(a, b) {
  return `${Math.min(a, b)}-${Math.max(a, b)}`;
}

// 마번 중복 찾기 (버그 3 수정용)
function findDuplicateNums(horses) {
  const seen = new Set(), dup = new Set();
  horses.forEach(h => { if (seen.has(h.num)) dup.add(h.num); seen.add(h.num); });
  return [...dup];
}

// 마필별 점수 계산 — 명세서 식 그대로
function scoreHorse(h) {
  const has = t => h.tags.includes(t);
  const stability =
    (MARK_SCORE[h.mark] ?? 10) +                              // 평점 점수
    (h.winOdds > 0 ? (100 / h.winOdds) * 0.65 : 0) +          // 배당 확률 가중치
    h.tags.length * 6;                                        // 태그 개당 +6

  const dark =
    (h.winOdds >= 6.0 ? 25 : 0) +                             // 명세: 단승 6.0배 이상 (기존 코드 5.5 → 수정)
    (h.placeOdds >= 2.2 ? 12 : 0) +
    (has("단독선행") ? 20 : 0) +                               // 명세: 배당 조건 없이 가산 (기존 7.0배 조건 제거)
    (has("종반G3F우수") ? 18 : 0) +
    (has("감량잇점") || has("기수상향") ? 14 : 0) +
    (h.mark === "복병" || h.mark === "▲" ? 12 : 0);

  return { stability, dark };
}

// 복승·복연승 추정 배당 (배당판 실제 값이 없을 때만 사용)
const estQ = (a, b) => Math.max(1.2, Math.round(a.winOdds * b.winOdds * 0.42 * 10) / 10);
const estQP = (a, b) => Math.max(1.1, Math.round(a.placeOdds * b.placeOdds * 0.85 * 10) / 10);

/**
 * 추천 계산
 * @param horses   정리된 마필 배열
 * @param opts     { min: 2.0, actualQ: {"3-7": 5.2}, actualQP: {...} }
 * @returns        { picks: [...], baseline: [...], axis, darkHorse, scored }
 *                 조건을 만족하는 후보가 없으면 해당 pick 의 nums 가 빈 배열 (버그 2 수정)
 */
function computePicks(horses, opts = {}) {
  const min = opts.min ?? 2.0;
  const actualQ = opts.actualQ || {};
  const actualQP = opts.actualQP || {};

  // 마번이 있고 단승 배당이 입력된 말만 계산 대상
  const valid = horses.filter(h => h.num > 0 && h.winOdds > 0);
  const scored = valid.map(h => ({ ...h, ...scoreHorse(h) }));
  const byStab = [...scored].sort((a, b) => b.stability - a.stability);
  const byDark = [...scored].sort((a, b) => b.dark - a.dark);

  // 모든 2두 조합 + 배당 (실제 값 우선, 없으면 추정)
  const pairs = [];
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const a = scored[i], b = scored[j], key = pairKey(a.num, b.num);
      pairs.push({
        a, b, key,
        q: actualQ[key] ?? estQ(a, b), qEst: actualQ[key] === undefined,
        qp: actualQP[key] ?? estQP(a, b), qpEst: actualQP[key] === undefined,
        stab: a.stability + b.stability
      });
    }
  }
  const nums = p => [Math.min(p.a.num, p.b.num), Math.max(p.a.num, p.b.num)];
  const empty = (id, track, type) => ({ id, track, type, nums: [], odds: 0, est: false });

  // ---- 트랙 1: 안정형 (min 배 이상만) ----
  const cWin = byStab.find(h => h.winOdds >= min);
  const cPlace = byStab.find(h => h.placeOdds >= min);
  const cQP = pairs.filter(p => p.qp >= min).sort((x, y) => y.stab - x.stab)[0];
  const cQ = pairs.filter(p => p.q >= min).sort((x, y) => y.stab - x.stab)[0];

  // ---- 트랙 2: 공격형 (복병마 필수 포함) ----
  const darkHorse = byDark.find(h => h.winOdds >= 6.0) || null;   // 핵심 복병마
  const hPlace = byDark.find(h => h.placeOdds >= 2.4);
  const axis = darkHorse ? byStab.find(h => h.num !== darkHorse.num) : byStab[0]; // 복병 제외 안정도 1위
  const darkPair = darkHorse && axis ? pairs.find(p => p.key === pairKey(darkHorse.num, axis.num)) : null;

  const picks = [
    cWin ? { id: "c_win", track: "안정형", type: "단승", nums: [cWin.num], odds: cWin.winOdds, est: false } : empty("c_win", "안정형", "단승"),
    cPlace ? { id: "c_place", track: "안정형", type: "연승", nums: [cPlace.num], odds: cPlace.placeOdds, est: false } : empty("c_place", "안정형", "연승"),
    cQP ? { id: "c_qp", track: "안정형", type: "복연승", nums: nums(cQP), odds: cQP.qp, est: cQP.qpEst } : empty("c_qp", "안정형", "복연승"),
    cQ ? { id: "c_q", track: "안정형", type: "복승", nums: nums(cQ), odds: cQ.q, est: cQ.qEst } : empty("c_q", "안정형", "복승"),
    darkHorse ? { id: "h_win", track: "공격형", type: "단승", nums: [darkHorse.num], odds: darkHorse.winOdds, est: false } : empty("h_win", "공격형", "단승"),
    hPlace ? { id: "h_place", track: "공격형", type: "연승", nums: [hPlace.num], odds: hPlace.placeOdds, est: false } : empty("h_place", "공격형", "연승"),
    darkPair ? { id: "h_qp", track: "공격형", type: "복연승", nums: nums(darkPair), odds: darkPair.qp, est: darkPair.qpEst } : empty("h_qp", "공격형", "복연승"),
    darkPair ? { id: "h_q", track: "공격형", type: "복승", nums: nums(darkPair), odds: darkPair.q, est: darkPair.qEst } : empty("h_q", "공격형", "복승")
  ];

  // ---- 기준선: 단순 인기순 (추천이 이것보다 나은지 비교용) ----
  const byWinOdds = [...scored].sort((a, b) => a.winOdds - b.winOdds);
  const byPlaceOdds = [...scored].filter(h => h.placeOdds > 0).sort((a, b) => a.placeOdds - b.placeOdds);
  const fav = byWinOdds[0], fav2 = byWinOdds[1];
  const favPair = fav && fav2 ? pairs.find(p => p.key === pairKey(fav.num, fav2.num)) : null;
  const baseline = [
    fav ? { id: "b_win", track: "기준선", type: "단승", nums: [fav.num], odds: fav.winOdds, est: false } : empty("b_win", "기준선", "단승"),
    byPlaceOdds[0] ? { id: "b_place", track: "기준선", type: "연승", nums: [byPlaceOdds[0].num], odds: byPlaceOdds[0].placeOdds, est: false } : empty("b_place", "기준선", "연승"),
    favPair ? { id: "b_qp", track: "기준선", type: "복연승", nums: nums(favPair), odds: favPair.qp, est: favPair.qpEst } : empty("b_qp", "기준선", "복연승"),
    favPair ? { id: "b_q", track: "기준선", type: "복승", nums: nums(favPair), odds: favPair.q, est: favPair.qEst } : empty("b_q", "기준선", "복승")
  ];

  return { picks, baseline, axis: byStab[0] || null, darkHorse, scored };
}

/**
 * 채점: top = [1착, 2착, 3착] 마번
 * 연승·복연승 입상 범위: 출전 7두 이하 2착, 8두 이상 3착 (마사회 규정 — 확인 필요)
 */
function gradePick(pick, top, fieldSize, stake = 1000) {
  if (!pick.nums.length || !top || top.length < 2) return null;  // 추천 없음 또는 결과 없음
  const placeN = fieldSize > 0 && fieldSize <= 7 ? 2 : 3;
  const inPlace = n => top.slice(0, placeN).includes(n);
  let hit = false;
  if (pick.type === "단승") hit = pick.nums[0] === top[0];
  if (pick.type === "연승") hit = inPlace(pick.nums[0]);
  if (pick.type === "복승") hit = pick.nums.includes(top[0]) && pick.nums.includes(top[1]);
  if (pick.type === "복연승") hit = pick.nums.every(inPlace);
  return { hit, stake, payout: hit ? Math.round(stake * pick.odds) : 0 };
}

// 예산 배분: 합계가 정확히 예산과 같도록 100원 단위 조정
function allocateBudget(budget, items) {
  const live = items.filter(it => it.pick.nums.length);
  const total = live.reduce((s, it) => s + it.ratio, 0);
  if (!live.length || budget < 100) return [];
  const units = Math.floor(budget / 100);
  let used = 0;
  const out = live.map(it => {
    const u = Math.floor(units * it.ratio / total);
    used += u;
    return { ...it, amount: u * 100 };
  });
  out[0].amount += (units - used) * 100;                      // 남은 단위는 첫 항목에
  return out.map(o => ({ ...o, ret: Math.round(o.amount * o.pick.odds) }));
}

// Node 테스트용 내보내기 (앱에서는 무시됨)
if (typeof module !== "undefined") {
  module.exports = { MARKS, STYLES, TAGS, toNum, normalizeHorse, pairKey, findDuplicateNums, scoreHorse, computePicks, gradePick, allocateBudget };
}
