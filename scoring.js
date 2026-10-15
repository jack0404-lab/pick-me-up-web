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
    weight: toNum(raw.weight, 0),                             // 부담중량
    hrNo: String(raw.hrNo ?? ""),                             // 마사회 마번(고유번호) — 기록 연결용
    sheet: raw.sheet === true,                                // 정보지(사진·직접 입력) 값이 있으면 true
    auto: raw.auto === true,                                  // 공공데이터로 자동 분석된 값이면 true
    note: String(raw.note ?? "").slice(0, 80)                 // 자동 분석 근거 메모
  };
}

/* =========================================================
 * 공공데이터 과거 기록으로 정보지 대신 평점·습성·태그 산출
 * rows   : 경주기록 API 응답 항목들 (여러 경주, 여러 달)
 * fields : 필드 이름 후보 (app.js 의 KRA.fields)
 * opts   : { dist: 이번 경주 거리 }
 * 반환    : 정보지 값이 없는(sheet !== true) 말만 바뀐 새 배열 + 요약
 * ========================================================= */
function pickField(item, names) {
  for (const n of names) if (item[n] !== undefined && item[n] !== null && item[n] !== "") return item[n];
  return undefined;
}

// 구간기록 필드는 경마장마다 이름 앞부분이 달라서, 실제 값이 가장 많이 채워진 필드를 고름
function findBestKey(rows, test) {
  const counts = {};
  rows.slice(0, 400).forEach(r => Object.keys(r).forEach(k => {
    if (test(k) && toNum(r[k], 0) > 0) counts[k] = (counts[k] || 0) + 1;
  }));
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function enrichFromHistory(horses, rows, fields, opts = {}) {
  const f = fields;
  const g3fKey = findBestKey(rows, k => /g3f/i.test(k) && /time|rec/i.test(k) && !/ord/i.test(k));
  const s1fKey = findBestKey(rows, k => /s1f/i.test(k) && /ord/i.test(k));

  // 1) 기록을 말별·기수별로 정리
  const byHorse = new Map(), jockey = new Map();
  const keyOf = (no, name) => (no ? "no:" + no : "nm:" + String(name || "").trim());
  rows.forEach(r => {
    const ord = toNum(pickField(r, f.ord), 0);
    if (!ord) return;                                         // 취소·실격 등은 제외
    const run = {
      date: String(pickField(r, f.rcDate) ?? ""),
      dist: toNum(pickField(r, f.dist), 0),
      ord,
      weight: toNum(pickField(r, f.weight), 0),
      jockey: String(pickField(r, f.jkName) ?? ""),
      g3f: g3fKey ? toNum(r[g3fKey], 0) : 0,
      s1fOrd: s1fKey ? toNum(r[s1fKey], 0) : 0
    };
    const no = String(pickField(r, f.hrNo) ?? ""), name = String(pickField(r, f.hrName) ?? "");
    [keyOf(no, null), keyOf(null, name)].forEach(k => {
      if (k === "no:" || k === "nm:") return;
      if (!byHorse.has(k)) byHorse.set(k, []);
      byHorse.get(k).push(run);
    });
    if (run.jockey) {
      const j = jockey.get(run.jockey) || { rides: 0, wins: 0 };
      j.rides++; if (ord === 1) j.wins++;
      jockey.set(run.jockey, j);
    }
  });
  const winRate = name => { const j = jockey.get(name); return j && j.rides >= 5 ? j.wins / j.rides : null; };

  // 2) 말마다 최근 기록 요약
  const info = horses.map(h => {
    let runs = (h.hrNo && byHorse.get(keyOf(h.hrNo, null))) || byHorse.get(keyOf(null, h.name)) || [];
    // 같은 경주가 마번·마명 두 키로 두 번 들어간 경우 제거
    const seen = new Set();
    runs = runs.filter(r => { const k = r.date + "|" + r.dist + "|" + r.ord; if (seen.has(k)) return false; seen.add(k); return true; })
               .sort((a, b) => b.date.localeCompare(a.date));
    const last3 = runs.slice(0, 3);
    const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
    return {
      runs, last3,
      formAvg: avg(last3.map(r => r.ord)),                      // 최근 3전 평균 착순 (낮을수록 좋음)
      g3fAvg: avg(last3.map(r => r.g3f).filter(v => v > 0)),   // 최근 G3F 평균 기록 (낮을수록 빠름)
      s1fAvg: avg(last3.map(r => r.s1fOrd).filter(v => v > 0)) // 최근 S1F 통과 순위 (낮을수록 앞)
    };
  });

  // 3) 평점: 최근 성적 순위로 ◎ ○ ▲, 나머지 △
  const ranked = info.map((x, i) => ({ i, v: x.formAvg })).filter(x => x.v !== null).sort((a, b) => a.v - b.v);
  const markOf = {};
  ["◎", "○", "▲"].forEach((m, k) => { if (ranked[k]) markOf[ranked[k].i] = m; });

  // 4) G3F 상위 1/3 (최소 1두)
  const g3 = info.map((x, i) => ({ i, v: x.g3fAvg })).filter(x => x.v !== null).sort((a, b) => a.v - b.v);
  const g3Top = new Set(g3.slice(0, Math.max(1, Math.ceil(g3.length / 3))).map(x => x.i));

  // 5) 주행 습성: S1F 통과 순위 평균
  const styleOf = i => {
    const v = info[i].s1fAvg;
    if (v === null) return null;
    return v <= 2.5 ? "선행" : v <= 6 ? "선입" : "추입";
  };
  const styles = horses.map((h, i) => (h.sheet ? h.style : styleOf(i) || h.style));
  const frontCount = styles.filter(s => s === "선행").length;

  let changed = 0, withData = 0;
  const out = horses.map((h, i) => {
    const x = info[i];
    if (x.runs.length) withData++;
    if (h.sheet) return h;                                     // 정보지 값이 있는 말은 그대로
    const tags = [];
    const last = x.runs[0];
    if (x.runs.some(r => opts.dist && Math.abs(r.dist - opts.dist) <= 100 && r.ord <= 3)) tags.push("거리적성");
    if (last && h.weight > 0 && last.weight > 0 && h.weight <= last.weight - 1) tags.push("감량잇점");
    if (last && h.jockey && last.jockey && h.jockey !== last.jockey) {
      const now = winRate(h.jockey), before = winRate(last.jockey);
      if (now !== null && before !== null && now - before >= 0.05) tags.push("기수상향");
    }
    if (g3Top.has(i)) tags.push("종반G3F우수");
    if (styles[i] === "선행" && frontCount === 1) tags.push("단독선행");

    const note = x.runs.length
      ? `최근 ${x.last3.map(r => r.ord).join("-")}착` + (x.g3fAvg ? ` · G3F ${x.g3fAvg.toFixed(1)}` : "")
      : "최근 기록 없음";
    changed++;
    return normalizeHorse({ ...h, mark: markOf[i] || "△", style: styles[i], tags, auto: true, note });
  });

  return { horses: out, changed, withData, g3fKey, s1fKey, rowCount: rows.length };
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

  rankPicks(picks, scored);
  return { picks, baseline, axis: byStab[0] || null, darkHorse, scored };
}

/* =========================================================
 * 조합 우선순위
 * - 1착 확률: 배당이 말하는 시장 확률 70% + 앱 점수 비중 30% (추정, 과신 방지)
 * - 2·3착 확률: 하빌(Harville) 방식 — 1착 확률로 다음 순위 확률을 이어서 계산
 * - 안정형: 적중 추정 확률 높은 순 / 공격형: 확률 × 배당(기대 지수) 높은 순
 * ========================================================= */
function shareOf(list, valueOf) {
  const total = list.reduce((s, h) => s + Math.max(0, valueOf(h)), 0);
  const out = {};
  list.forEach(h => { out[h.num] = total > 0 ? Math.max(0, valueOf(h)) / total : 1 / list.length; });
  return out;
}

// 지정한 말들이 모두 상위 k 안에 들 확률 (하빌 방식, 상위 k 순서를 전부 나열)
function probAllInTop(q, nums, k) {
  const ids = Object.keys(q).map(Number);
  let total = 0;
  const walk = (chosen, used, prob) => {
    if (chosen.length === k) { if (nums.every(n => chosen.includes(n))) total += prob; return; }
    const rest = 1 - used;
    if (rest <= 1e-9) return;
    ids.forEach(id => {
      if (chosen.includes(id)) return;
      walk([...chosen, id], used + q[id], prob * q[id] / rest);
    });
  };
  walk([], 0, 1);
  return total;
}

function rankPicks(picks, scored) {
  if (scored.length < 2) return;
  const placeN = scored.length <= 7 ? 2 : 3;                         // 연승만 출전 두수에 따라 달라짐
  const market = shareOf(scored, h => 1 / h.winOdds);
  const stab = shareOf(scored, h => h.stability);
  const darkTotal = scored.reduce((s, h) => s + h.dark, 0);
  const dark = darkTotal > 0 ? shareOf(scored, h => h.dark) : stab;
  const blend = (a, b) => { const o = {}; Object.keys(a).forEach(k => { o[k] = 0.7 * a[k] + 0.3 * b[k]; }); return o; };
  const modelSafe = blend(market, stab), modelDark = blend(market, dark);
  const topK = { "단승": 1, "연승": placeN, "복승": 2, "복연승": 3 };   // 복연승은 항상 3착 이내

  ["안정형", "공격형"].forEach(track => {
    const model = track === "안정형" ? modelSafe : modelDark;
    const live = picks.filter(p => p.track === track && p.nums.length);
    live.forEach(p => {
      p.prob = probAllInTop(model, p.nums, topK[p.type]);                 // 적중 추정 확률
      p.ev = p.prob * p.odds;                                             // 기대 지수 (1.0 = 본전 수준)
      p.score = track === "안정형" ? p.prob : p.ev;
    });
    live.sort((a, b) => (b.score - a.score) || (b.odds - a.odds)).forEach((p, i) => { p.rank = i + 1; });   // 같으면 배당 높은 쪽 우선
  });
}

/**
 * 채점: top = [1착, 2착, 3착] 마번
 * 한국마사회법 시행규칙 제4조:
 *   연승   = 출전 8두 이상 3착 이내, 5~7두 2착 이내
 *   복승   = 1·2착 2마리 (순서 무관)
 *   복연승 = 출전 두수와 관계없이 1~3착 중 2마리
 */
function gradePick(pick, top, fieldSize, stake = 1000) {
  if (!pick.nums.length || !top || top.length < 2) return null;  // 추천 없음 또는 결과 없음
  const placeN = fieldSize > 0 && fieldSize <= 7 ? 2 : 3;
  const inPlace = n => top.slice(0, placeN).includes(n);
  let hit = false;
  if (pick.type === "단승") hit = pick.nums[0] === top[0];
  if (pick.type === "연승") hit = inPlace(pick.nums[0]);
  if (pick.type === "복승") hit = pick.nums.includes(top[0]) && pick.nums.includes(top[1]);
  if (pick.type === "복연승") hit = pick.nums.every(n => top.slice(0, 3).includes(n));   // 항상 3착 이내
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
  module.exports = { MARKS, STYLES, TAGS, toNum, normalizeHorse, pairKey, findDuplicateNums, scoreHorse, computePicks, gradePick, allocateBudget, enrichFromHistory, probAllInTop };
}
