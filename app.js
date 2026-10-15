/* =========================================================
 * app.js — 화면 동작, 저장, 사진 판독, 공공데이터 연동
 * ========================================================= */

const APP_VERSION = "0.2.0 (개인용 검증판)";

/* ---------------------------------------------------------
 * 공공데이터 API 설정 — ★ 필드명·파라미터명은 추정값 ★
 * 설정 탭의 [연결 테스트]로 실제 응답을 확인한 뒤 틀린 이름만 고치면 됨
 * --------------------------------------------------------- */
const KRA = {
  base: "https://apis.data.go.kr/B551015",
  meetCode: { "서울": 1, "제주": 2, "부산경남": 3 },          // 추정: 명세서로 확인
  entry: { path: "/API26_2/entrySheet_2" },                   // 출전표 상세정보
  result: { path: "/API4_3/raceResult_3" },                   // 경주기록 정보
  dateParam: "rc_date",                                       // 경주일자 파라미터 (YYYYMMDD) — 추정
  monthParam: "rc_month",                                     // 경주년월 파라미터 (YYYYMM) — 추정
  historyMonths: 3,                                           // 자동 분석에 쓸 과거 기록 기간 (개월)
  fields: {                                                   // 응답 필드 후보 (앞에서부터 찾음)
    rcDate: ["rcDate", "rc_date"],
    rcNo: ["rcNo", "rc_no"],
    chulNo: ["chulNo", "chul_no", "gateNo"],
    hrName: ["hrName", "hr_name", "hrNm"],
    hrNo: ["hrNo", "hr_no"],
    jkName: ["jkName", "jk_name", "jkNm"],
    weight: ["wgBudam", "wg_budam", "budam"],
    ord: ["ord", "rank", "rcOrd"],
    dist: ["rcDist", "rc_dist"]
  }
};

/* ---------- 저장소 (폰 안의 localStorage) ---------- */
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch { toast("저장 공간이 부족합니다. 기록을 백업 후 정리하세요."); return false; }
  }
};
const K = { settings: "hpm_settings", current: "hpm_current", records: "hpm_records", agreed: "hpm_agreed" };

/* ---------- 상태 ---------- */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
let settings = Object.assign(
  { geminiKey: "", geminiModel: "gemini-3.8-flash", dataKey: "", strictMin: true, budget: 30000 },
  store.get(K.settings, {})
);
// 예전 기본 모델(2.5 Flash)이 저장돼 있으면 새 기본 모델로 자동 교체
if (!settings.geminiModel || settings.geminiModel === "gemini-2.5-flash") {
  settings.geminiModel = "gemini-3.8-flash";
  store.set(K.settings, settings);
}
let current = Object.assign(
  { meta: { date: today(), track: "서울", raceNo: 1, dist: 1200, cond: "건조" }, horses: [], actualQ: {}, actualQP: {} },
  store.get(K.current, {})
);
current.horses = (current.horses || []).map(normalizeHorse);    // 저장값도 항상 정리해서 사용
let records = store.get(K.records, []);
let lastResult = null;                                          // 마지막 추천 계산 결과
const photos = { odds: null, sheet: null };                     // 줄인 사진 (base64)

const SAMPLE = [
  { num: 1, name: "번개질주", winOdds: 1.5, placeOdds: 1.1, mark: "◎", style: "선행", tags: ["단독선행"] },
  { num: 3, name: "골든크라운", winOdds: 2.8, placeOdds: 1.4, mark: "○", style: "선입", tags: ["기수상향"] },
  { num: 5, name: "스톰러너", winOdds: 4.5, placeOdds: 2.1, mark: "▲", style: "선입", tags: ["거리적성"] },
  { num: 7, name: "다크엔젤", winOdds: 6.2, placeOdds: 2.4, mark: "△", style: "추입", tags: ["종반G3F우수"] },
  { num: 9, name: "미라클스텝", winOdds: 14.5, placeOdds: 3.8, mark: "복병", style: "추입", tags: ["종반G3F우수", "감량잇점"] },
  { num: 11, name: "와일드파이어", winOdds: 21.0, placeOdds: 5.2, mark: "복병", style: "선행", tags: ["게이트잇점"] }
];

/* ---------- 작은 도구 ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => Math.round(n).toLocaleString("ko-KR");
const saveCurrent = () => store.set(K.current, current);

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
function setStatus(id, msg, kind = "") {
  const el = $(id);
  el.className = "status" + (msg ? " show" : "") + (kind ? " " + kind : "");
  el.textContent = msg || "";
}

/* =========================================================
 * 0. 픽셀 아이콘 — 문자 격자(#=칠함)를 SVG 사각형으로 그림
 * ========================================================= */
const ICONS = {
  horse: ["................", "......#.#.......", ".....######.....", "....########....", "...###.######...", "..###########...", ".############...", ".#####..######..", ".####...######..", "..##....#######.", ".......########.", "......#########.", ".....##########.", "....###########.", "...############.", "................"],
  list:  ["..........", ".##.#####.", ".##.#####.", "..........", ".##.#####.", ".##.#####.",
          "..........", ".##.#####.", ".##.#####.", ".........."],
  gear:  ["....##....", ".#.####.#.", "..######..", ".###..###.", "####..####",
          "####..####", ".###..###.", "..######..", ".#.####.#.", "....##...."],
  ticket:["..........", ".########.", ".#......#.", "##.####.##", "##......##",
          "##.####.##", ".#......#.", ".########.", ".........."]
};
function pixelSvg(rows) {
  const w = rows[0].length, h = rows.length;
  let rects = "";
  rows.forEach((row, y) => {                                   // 가로로 이어진 칸은 사각형 하나로 합침
    for (let x = 0; x < w; x++) {
      if (row[x] !== "#") continue;
      let run = 1;
      while (row[x + run] === "#") run++;
      rects += `<rect x="${x}" y="${y}" width="${run}" height="1"/>`;
      x += run - 1;
    }
  });
  return `<svg viewBox="0 0 ${w} ${h}" fill="currentColor" aria-hidden="true">${rects}</svg>`;
}
document.querySelectorAll(".px[data-icon]").forEach(el => { el.innerHTML = pixelSvg(ICONS[el.dataset.icon]); });

/* =========================================================
 * 1. 탭 전환
 * ========================================================= */
const PANEL_TITLE = { analyze: "ANALYZE", records: "RECORDS", settings: "SETTINGS" };
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab").forEach(s => s.classList.toggle("active", s.id === "tab-" + btn.dataset.tab));
    $("panelTitle").textContent = PANEL_TITLE[btn.dataset.tab];
    if (btn.dataset.tab === "records") renderRecords();
    window.scrollTo(0, 0);
  });
});
const updateCount = () => { $("recordCount").textContent = records.length; };

/* =========================================================
 * 2. 경주 정보
 * ========================================================= */
function bindMeta() {
  const map = { raceDate: "date", track: "track", raceNo: "raceNo", raceDist: "dist", trackCond: "cond" };
  Object.entries(map).forEach(([id, key]) => {
    $(id).value = current.meta[key];
    $(id).addEventListener("change", e => {
      const v = e.target.value;
      current.meta[key] = (key === "raceNo" || key === "dist") ? toNum(v, 0) : v;
      saveCurrent();
      recalc();
    });
  });
  $("budget").value = settings.budget;
  $("budget").addEventListener("input", e => { settings.budget = toNum(e.target.value, 0); store.set(K.settings, settings); recalc(); });
}

/* =========================================================
 * 3. 출전마 목록
 * ========================================================= */
function renderHorses() {
  const dups = findDuplicateNums(current.horses);
  setStatus("dupWarning", dups.length ? `마번 ${dups.join(", ")}번이 중복되었습니다. 중복된 말은 계산에서 빠집니다.` : "", "warn");

  if (!current.horses.length) {
    $("horseList").innerHTML = `<div class="empty">출전표를 불러오거나, 사진을 읽거나, [+ 추가]로 입력하세요.</div>`;
    return;
  }
  const markOpts = h => MARKS.map(m => `<option ${h.mark === m ? "selected" : ""}>${m}</option>`).join("");
  const styleOpts = h => STYLES.map(s => `<option ${h.style === s ? "selected" : ""}>${s}</option>`).join("");

  $("horseList").innerHTML = current.horses.map((h, i) => `
    <div class="horse ${dups.includes(h.num) ? "dup" : ""}" data-i="${i}">
      <div class="horse-top">
        <input class="num" type="number" inputmode="numeric" value="${h.num || ""}" data-f="num" aria-label="마번" />
        <input class="name" type="text" value="${esc(h.name)}" placeholder="마명" data-f="name" />
        <button class="horse-del" data-act="del" aria-label="삭제">×</button>
      </div>
      ${h.jockey || h.weight || h.note ? `<div class="horse-meta">${h.auto ? `<span class="auto-badge">자동</span>` : ""}${esc([h.jockey, h.weight ? h.weight + "kg" : "", h.note].filter(Boolean).join(" · "))}</div>` : ""}
      <div class="horse-inputs">
        <label><span>단승</span><input type="number" step="0.1" inputmode="decimal" value="${h.winOdds || ""}" data-f="winOdds" /></label>
        <label><span>연승</span><input type="number" step="0.1" inputmode="decimal" value="${h.placeOdds || ""}" data-f="placeOdds" /></label>
        <label><span>평점</span><select data-f="mark">${markOpts(h)}</select></label>
        <label><span>습성</span><select data-f="style">${styleOpts(h)}</select></label>
      </div>
      <div class="tag-row">
        ${TAGS.map(t => `<button class="tag ${h.tags.includes(t) ? "on" : ""}" data-tag="${t}">${t}</button>`).join("")}
      </div>
    </div>`).join("");
}

// 입력 이벤트는 목록 전체에 한 번만 연결 (다시 그려도 유지됨)
$("horseList").addEventListener("input", e => {
  const box = e.target.closest(".horse"), f = e.target.dataset.f;
  if (!box || !f || f === "num") return;                       // 마번은 change 에서 처리
  const h = current.horses[box.dataset.i];
  h[f] = (f === "winOdds" || f === "placeOdds") ? toNum(e.target.value, 0) : e.target.value;
  if (f === "mark" || f === "style") h.sheet = true;             // 직접 고친 평점·습성은 보호
  saveCurrent();
  recalc();                                                    // 목록은 다시 그리지 않아 입력 포커스 유지
});
$("horseList").addEventListener("change", e => {
  const box = e.target.closest(".horse");
  if (!box || e.target.dataset.f !== "num") return;
  current.horses[box.dataset.i].num = Math.round(toNum(e.target.value, 0));
  saveCurrent();
  renderHorses();                                              // 중복 표시 갱신
  recalc();
});
$("horseList").addEventListener("click", e => {
  const box = e.target.closest(".horse");
  if (!box) return;
  const h = current.horses[box.dataset.i];
  if (e.target.dataset.act === "del") {
    current.horses.splice(box.dataset.i, 1);
  } else if (e.target.dataset.tag) {
    const t = e.target.dataset.tag;
    h.tags = h.tags.includes(t) ? h.tags.filter(x => x !== t) : [...h.tags, t];
    h.sheet = true;                                              // 직접 고친 태그는 보호
  } else return;
  saveCurrent();
  renderHorses();
  recalc();
});

$("btnAddHorse").onclick = () => {
  const next = current.horses.reduce((m, h) => Math.max(m, h.num), 0) + 1;
  current.horses.push(normalizeHorse({ num: next }));
  saveCurrent(); renderHorses(); recalc();
};
$("btnSample").onclick = () => {
  current.horses = SAMPLE.map(x => normalizeHorse({ ...x, sheet: true }));
  current.actualQ = {}; current.actualQP = {};
  saveCurrent(); renderHorses(); recalc();
};
$("btnClear").onclick = () => {
  if (!confirm("출전마와 입력한 배당을 모두 지울까요?")) return;
  current.horses = []; current.actualQ = {}; current.actualQP = {};
  saveCurrent(); renderHorses(); recalc();
};

/* =========================================================
 * 4. 추천 계산·표시
 * ========================================================= */
function recalc() {
  const m = current.meta;
  $("raceBadge").textContent = `${m.date} · ${m.track} ${m.raceNo}경주 · ${m.dist}m · ${m.cond}`;
  const min = settings.strictMin ? 2.0 : 1.5;
  $("minLabel").textContent = min.toFixed(1);

  // 중복 마번은 계산에서 제외
  const dups = findDuplicateNums(current.horses);
  const usable = current.horses.filter(h => !dups.includes(h.num));
  lastResult = computePicks(usable, { min, actualQ: current.actualQ, actualQP: current.actualQP });

  renderBriefing(lastResult);
  renderBets("safeGrid", lastResult.picks.filter(p => p.track === "안정형"));
  renderBets("darkGrid", lastResult.picks.filter(p => p.track === "공격형"));
  renderStakes(lastResult);
}

function renderBriefing(r) {
  const s = r.scored;
  if (s.length < 2) {
    $("briefing").innerHTML = `<li>단승 배당이 입력된 말이 2두 이상이면 분석이 시작됩니다.</li>`;
    return;
  }
  const front = s.filter(h => h.style === "선행").map(h => h.num);
  const pace = front.length === 1
    ? `<b>단독 선행 예상</b>: ${front[0]}번이 앞에서 주도할 가능성이 높습니다.`
    : front.length >= 3
      ? `<b>선행 경합 예상</b>: ${front.join(", ")}번이 앞을 다투면 종반이 좋은 선입·추입마가 유리할 수 있습니다.`
      : `<b>표준 페이스 예상</b>: 선행마가 ${front.length}두로 전개 변수가 크지 않습니다.`;
  const ax = r.axis;
  const axis = ax.winOdds < 2.0
    ? `<b>안정도 1위 ${ax.num}번</b> (단승 ${ax.winOdds}배)은 2.0배 미만 저배당이라 단승·연승보다 조합의 축으로 쓰는 편이 맞습니다.`
    : `<b>안정도 1위 ${ax.num}번</b> (단승 ${ax.winOdds}배, 평점 ${ax.mark}).`;
  const dk = r.darkHorse;
  const dark = dk
    ? `<b>복병 1순위 ${dk.num}번</b> (단승 ${dk.winOdds}배): ${esc(dk.tags.join(", ") || dk.style)}.`
    : `<b>복병 후보 없음</b>: 단승 6.0배 이상인 말이 없습니다.`;
  $("briefing").innerHTML = [pace, axis, dark].map(t => `<li>${t}</li>`).join("");
}

const TYPE_DESC = { "단승": "1착", "연승": "3착 이내", "복승": "1·2착 순서무관", "복연승": "둘 다 3착 이내" };

function renderBets(gridId, picks) {
  // 순위가 있는 조합을 1순위부터, 조건 미충족 칸은 맨 뒤로
  const ordered = [...picks].sort((a, b) => (a.rank || 99) - (b.rank || 99));
  const placeN = lastResult && lastResult.scored.length <= 7 ? 2 : 3;      // 7두 이하는 2착까지 입상
  const desc = t => (t === "연승" ? `${placeN}착 이내` : t === "복연승" ? `둘 다 ${placeN}착 이내` : TYPE_DESC[t]);
  $(gridId).innerHTML = ordered.map(p => {
    if (!p.nums.length) {
      return `<div class="bet none"><div class="bet-type"><span>${p.type}</span></div>
        <div class="bet-main">조건 충족 조합 없음</div></div>`;
    }
    const isPair = p.nums.length === 2;
    const key = isPair ? pairKey(p.nums[0], p.nums[1]) : "";
    const kind = p.type === "복승" ? "q" : "qp";
    const metric = p.track === "안정형"
      ? `적중 추정 ${(p.prob * 100).toFixed(0)}%`
      : `기대 지수 ${p.ev.toFixed(2)} · 적중 ${(p.prob * 100).toFixed(0)}%`;
    return `<div class="bet ${p.rank === 1 ? "top" : ""}">
      <div class="rank-row"><span class="rank-badge">${p.rank}순위</span><span class="rank-metric">${metric}</span></div>
      <div class="bet-type"><span>${p.type} <small>${desc(p.type)}</small></span>
        <span class="bet-odds">${p.odds.toFixed(1)}배${p.est ? `<span class="est-badge">추정</span>` : ""}</span></div>
      <div class="bet-main">${p.nums.join(" - ")}번</div>
      ${isPair ? `<div class="actual-input"><span>실제 배당</span>
        <input type="number" step="0.1" inputmode="decimal" placeholder="배당판 값"
          value="${(kind === "q" ? current.actualQ : current.actualQP)[key] ?? ""}" data-key="${key}" data-kind="${kind}" /></div>` : ""}
    </div>`;
  }).join("");
}

// 배당판의 실제 복승·복연승 배당 입력 → 추정값 대신 사용
["safeGrid", "darkGrid"].forEach(id => {
  $(id).addEventListener("change", e => {
    const { key, kind } = e.target.dataset;
    if (!key) return;
    const map = kind === "q" ? current.actualQ : current.actualQP;
    const v = toNum(e.target.value, 0);
    if (v > 0) map[key] = v; else delete map[key];
    saveCurrent();
    recalc();
  });
});

function renderStakes(r) {
  const by = id => r.picks.find(p => p.id === id);
  const items = [
    { label: "안정형 복연승", pick: by("c_qp"), ratio: 0.35 },
    { label: "안정형 연승", pick: by("c_place"), ratio: 0.30 },
    { label: "공격형 복연승", pick: by("h_qp"), ratio: 0.20 },
    { label: "공격형 복승", pick: by("h_q"), ratio: 0.15 }
  ];
  const out = allocateBudget(settings.budget, items);
  $("stakeList").innerHTML = out.length
    ? out.map(o => `<div class="stake">
        <div>${o.label} <b>${o.pick.nums.join("-")}번</b><br><small>${o.pick.odds.toFixed(1)}배${o.pick.est ? " (추정)" : ""}</small></div>
        <div class="amt">${fmt(o.amount)}원<span class="ret">적중 시 약 ${fmt(o.ret)}원</span></div>
      </div>`).join("")
    : `<div class="empty">배분할 추천 조합이 없습니다.</div>`;
}

$("btnCopy").onclick = async () => {
  if (!lastResult) return;
  const m = current.meta;
  const line = p => `- ${p.track} ${p.rank ? p.rank + "순위 " : ""}${p.type}: ${p.nums.length ? p.nums.join("-") + "번 (" + p.odds.toFixed(1) + "배" + (p.est ? ", 추정" : "") + ")" : "없음"}`;
  const sorted = [...lastResult.picks].sort((a, b) => a.track.localeCompare(b.track) || (a.rank || 99) - (b.rank || 99));
  const text = `[${m.date} ${m.track} ${m.raceNo}경주 참고 조합]\n` + sorted.map(line).join("\n");
  try { await navigator.clipboard.writeText(text); toast("복사했습니다."); }
  catch { prompt("아래 내용을 길게 눌러 복사하세요.", text); }
};

/* =========================================================
 * 5. 사진 → AI 판독 (Gemini)
 * ========================================================= */
// 큰 사진을 긴 변 1600px JPEG 로 줄임 (전송 속도·비용 절약)
function shrinkImage(file, maxSide = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("사진을 열 수 없습니다.")); };
    img.src = url;
  });
}

document.querySelectorAll('.photo-box input[type="file"]').forEach(inp => {
  inp.addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const slot = e.target.dataset.slot;
    try {
      photos[slot] = await shrinkImage(file);
      const box = document.querySelector(`.photo-box[data-slot="${slot}"]`);
      box.querySelector("img").src = photos[slot];
      box.querySelector("img").hidden = false;
    } catch (err) { toast(err.message); }
    e.target.value = "";                                       // 같은 사진 다시 선택 가능하게
  });
});

const AI_PROMPT = `한국 경마 배당판 또는 경마 정보지(예상지) 사진입니다. 사진에서 읽을 수 있는 값만 아래 형식의 JSON 객체 하나로 답하세요.
{"horses":[{"num":마번,"name":"마명","winOdds":단승배당,"placeOdds":연승배당,"mark":"◎|○|▲|△|복병","style":"선행|선입|추입","tags":[]}],
 "quinella":[{"a":마번,"b":마번,"odds":복승배당}],
 "quinellaPlace":[{"a":마번,"b":마번,"odds":복연승배당}]}
규칙:
- 사진에서 읽을 수 없는 값은 null 로 둡니다. 추측해서 채우지 않습니다.
- 연승 배당이 범위(예: 1.2-1.8)로 표시되면 낮은 값을 씁니다.
- tags 는 ["종반G3F우수","단독선행","기수상향","거리적성","감량잇점","게이트잇점"] 중 정보지에 근거가 있는 것만 넣습니다.
- 복승·복연승 배당표가 보이면 quinella, quinellaPlace 에 넣고, 없으면 빈 배열입니다.`;

$("btnAnalyze").onclick = async () => {
  if (!settings.geminiKey) { setStatus("aiStatus", "설정 탭에서 Gemini API 키를 먼저 저장하세요. 키 없이도 아래 표에 직접 입력할 수 있습니다.", "warn"); return; }
  const imgs = Object.values(photos).filter(Boolean);
  if (!imgs.length) { setStatus("aiStatus", "배당판이나 정보지 사진을 1장 이상 넣어주세요.", "warn"); return; }

  const btn = $("btnAnalyze");
  btn.disabled = true;
  setStatus("aiStatus", "사진을 읽는 중입니다… (10~30초)");
  try {
    const parts = [{ text: AI_PROMPT }, ...imgs.map(d => ({ inline_data: { mime_type: "image/jpeg", data: d.split(",")[1] } }))];
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.geminiModel)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": settings.geminiKey },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json", temperature: 0 } })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || `HTTP ${resp.status}`);
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    const parsed = parseAiJson(text);
    const n = mergeAiResult(parsed);
    saveCurrent(); renderHorses(); recalc();
    setStatus("aiStatus", `${n}두를 반영했습니다. 배당·평점이 사진과 맞는지 꼭 확인하고 틀린 값은 직접 고치세요.`, "ok");
  } catch (err) {
    setStatus("aiStatus", "판독 실패: " + err.message + " — 아래 표에 직접 입력할 수 있습니다.", "warn");
  } finally {
    btn.disabled = false;
  }
};

// AI 응답에서 JSON 꺼내기 (앞뒤에 설명이 붙어도 처리)
function parseAiJson(text) {
  try { return JSON.parse(text); } catch { /* 아래로 */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* 아래로 */ } }
  throw new Error("사진에서 표를 읽지 못했습니다. 반사·흔들림 없이 다시 찍어보세요.");
}

// 판독 결과를 기존 목록에 '마번 기준'으로 합침 (사진에 없는 값은 기존 값 유지)
function mergeAiResult(obj) {
  const list = Array.isArray(obj) ? obj : (obj.horses || []);
  let count = 0;
  list.forEach(raw => {
    const num = Math.round(toNum(raw?.num, 0));
    if (!num) return;
    let h = current.horses.find(x => x.num === num);
    if (!h) { h = normalizeHorse({ num }); current.horses.push(h); }
    const fromPhoto = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null && v !== ""));
    const hasSheet = ["mark", "style"].some(k => fromPhoto[k]) || (Array.isArray(fromPhoto.tags) && fromPhoto.tags.length > 0);
    const clean = normalizeHorse({ ...h, ...fromPhoto });
    // 태그: 정보지에서 읽었으면 자동 분석 태그 대신 사용, 아니면 기존 태그에 추가
    clean.tags = [...new Set([...(hasSheet && h.auto ? [] : h.tags), ...clean.tags])];
    if (hasSheet) { clean.sheet = true; clean.auto = false; clean.note = ""; }
    Object.assign(h, clean);
    count++;
  });
  current.horses.sort((a, b) => a.num - b.num);
  const addPairs = (arr, map) => (arr || []).forEach(p => {
    const a = toNum(p?.a, 0), b = toNum(p?.b, 0), o = toNum(p?.odds, 0);
    if (a && b && a !== b && o > 0) map[pairKey(a, b)] = o;
  });
  addPairs(obj.quinella, current.actualQ);
  addPairs(obj.quinellaPlace, current.actualQP);
  return count;
}

/* =========================================================
 * 6. 공공데이터 API
 * ========================================================= */
const ymd = d => d.replaceAll("-", "");                          // 2026-10-17 → 20261017
const pick = (item, names) => { for (const n of names) if (item[n] !== undefined && item[n] !== "") return item[n]; return undefined; };

async function kraFetch(path, params) {
  if (!settings.dataKey) throw new Error("설정 탭에서 공공데이터포털 인증키를 먼저 저장하세요.");
  const qs = new URLSearchParams({ serviceKey: settings.dataKey, _type: "json", numOfRows: "500", pageNo: "1", ...params });
  const resp = await fetch(`${KRA.base}${path}?${qs}`);
  const text = await resp.text();
  if (text.trim().startsWith("<")) {                            // 키 오류 등은 XML 로 오는 경우가 있음
    const msg = (text.match(/<(returnAuthMsg|resultMsg|errMsg)>([^<]*)</) || [])[2];
    throw new Error(msg || "XML 응답 (키 또는 파라미터 확인 필요)");
  }
  const json = JSON.parse(text);
  const header = json?.response?.header;
  if (header && header.resultCode && header.resultCode !== "00") throw new Error(header.resultMsg || header.resultCode);
  let items = json?.response?.body?.items?.item ?? [];
  if (!Array.isArray(items)) items = [items];                   // 1건이면 배열이 아닐 수 있음
  return { items, raw: json };
}

// 출전표 불러오기 → 마번·마명·기수·부담중량 채우기
$("btnLoadEntry").onclick = async () => {
  const m = current.meta, btn = $("btnLoadEntry");
  btn.disabled = true;
  setStatus("entryStatus", "출전표를 불러오는 중…");
  try {
    const { items } = await kraFetch(KRA.entry.path, { meet: KRA.meetCode[m.track], [KRA.dateParam]: ymd(m.date) });
    const f = KRA.fields;
    const race = items.filter(it => {
      const d = pick(it, f.rcDate), no = pick(it, f.rcNo);
      return (d === undefined || String(d) === ymd(m.date)) && (no === undefined || toNum(no) === m.raceNo);
    });
    if (!race.length) throw new Error(`${m.date} ${m.track} ${m.raceNo}경주 출전표가 없습니다. 날짜·경주번호를 확인하세요. (받은 전체 ${items.length}건)`);

    let added = 0;
    race.forEach(it => {
      const num = Math.round(toNum(pick(it, f.chulNo), 0));
      if (!num) return;
      let h = current.horses.find(x => x.num === num);
      if (!h) { h = normalizeHorse({ num }); current.horses.push(h); added++; }
      h.name = String(pick(it, f.hrName) ?? h.name);
      h.jockey = String(pick(it, f.jkName) ?? h.jockey);
      h.weight = toNum(pick(it, f.weight), h.weight);
      h.hrNo = String(pick(it, f.hrNo) ?? h.hrNo ?? "");
    });
    const dist = toNum(pick(race[0], f.dist), 0);
    if (dist) { m.dist = dist; $("raceDist").value = dist; }
    current.horses.sort((a, b) => a.num - b.num);
    saveCurrent(); renderHorses(); recalc();
    setStatus("entryStatus", `${race.length}두 출전표를 반영했습니다 (새로 추가 ${added}두).`, "ok");
    // 정보지 값이 있는 말이 하나도 없으면 공공데이터로 자동 분석
    if (!current.horses.some(h => h.sheet)) await runAutoAnalysis();
  } catch (err) {
    setStatus("entryStatus", "불러오기 실패: " + err.message, "warn");
  } finally {
    btn.disabled = false;
  }
};

// 과거 경주기록 불러오기: 최근 1개월(날짜 없이) + 이전 달들 (앱을 켜 둔 동안 기억)
const historyCache = {};
async function loadHistory(track) {
  const meet = KRA.meetCode[track];
  const key = `${meet}|${today()}`;
  if (historyCache[key]) return historyCache[key];
  const months = [];
  const d = new Date();
  for (let i = 1; i < KRA.historyMonths; i++) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    months.push(`${m.getFullYear()}${String(m.getMonth() + 1).padStart(2, "0")}`);
  }
  const queries = [{ meet }, ...months.map(ym => ({ meet, [KRA.monthParam]: ym }))];
  const rows = [], seen = new Set(), f = KRA.fields;
  for (const q of queries) {
    for (let page = 1; page <= 6; page++) {                    // 한 번에 500건, 최대 3,000건
      const { items } = await kraFetch(KRA.result.path, { ...q, pageNo: String(page), numOfRows: "500" });
      items.forEach(it => {
        const id = [pick(it, f.rcDate), pick(it, f.rcNo), pick(it, f.chulNo), pick(it, f.hrName)].join("|");
        if (!seen.has(id)) { seen.add(id); rows.push(it); }
      });
      if (items.length < 500) break;
    }
  }
  historyCache[key] = rows;
  return rows;
}

// 정보지 값이 없는 말을 공공데이터 과거 기록으로 분석
async function runAutoAnalysis() {
  const btn = $("btnAutoAnalyze");
  if (!current.horses.length) { setStatus("autoStatus", "먼저 출전표를 불러오거나 출전마를 입력하세요.", "warn"); return; }
  btn.disabled = true;
  setStatus("autoStatus", "과거 경주기록으로 분석하는 중… (처음엔 10~20초)");
  try {
    const rows = await loadHistory(current.meta.track);
    const r = enrichFromHistory(current.horses, rows, KRA.fields, { dist: current.meta.dist });
    current.horses = r.horses;
    saveCurrent(); renderHorses(); recalc();
    const parts = [`기록 ${r.rowCount.toLocaleString()}건으로 ${r.changed}두 자동 분석 (기록 있는 말 ${r.withData}두).`];
    if (!r.g3fKey) parts.push("구간기록이 없어 종반G3F·주행 습성은 판단하지 못했습니다.");
    if (r.withData === 0) parts.push("출전마와 이름이 맞는 기록이 없습니다. 연결 테스트 화면을 캡처해 주세요.");
    parts.push("정보지 사진을 읽으면 그 값이 우선합니다.");
    setStatus("autoStatus", parts.join(" "), r.withData ? "ok" : "warn");
  } catch (err) {
    setStatus("autoStatus", "자동 분석 실패: " + err.message, "warn");
  } finally {
    btn.disabled = false;
  }
}
$("btnAutoAnalyze").onclick = runAutoAnalysis;

// 오늘 이후 가장 가까운 금·토·일 3일 (YYYYMMDD)
function nextRaceDays(count = 3) {
  const out = [], d = new Date();
  while (out.length < count) {
    if ([5, 6, 0].includes(d.getDay())) out.push(ymd(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// 응답 항목을 짧게 요약: 전체 필드 이름 + 핵심 필드 값
function describeItem(item) {
  const keys = Object.keys(item);
  const important = keys.filter(k => /^(rc|chul|hr|jk|ord|wg|meet|budam)/i.test(k));
  return `필드 ${keys.length}개:\n${keys.join(", ")}\n\n핵심 필드 값:\n` +
    important.map(k => `${k} = ${String(item[k]).slice(0, 20)}`).join("\n");
}

// 설정 탭: 연결 테스트 — 실제 응답의 필드 이름을 보여줌
$("btnApiTest").onclick = async () => {
  const out = $("apiTestOut");
  out.hidden = false;
  out.textContent = "확인 중… (10초 정도 걸립니다)";
  const meet = KRA.meetCode[current.meta.track], lines = [];

  // 출전표: 날짜 없이 + 다가오는 금·토·일 날짜로 각각 시도
  const tries = [["날짜 없음", { meet }], ...nextRaceDays().map(d => [d, { meet, [KRA.dateParam]: d }])];
  let sample = null;
  for (const [label, params] of tries) {
    try {
      const { items } = await kraFetch(KRA.entry.path, params);
      lines.push(`■ 출전표 (${label}): ${items.length}건`);
      if (items[0] && !sample) sample = items[0];
    } catch (err) { lines.push(`■ 출전표 (${label}): 실패 — ${err.message}`); }
  }
  if (sample) lines.push("\n[출전표 첫 항목]\n" + describeItem(sample));

  // 경주기록: 최근 한 달
  try {
    const { items } = await kraFetch(KRA.result.path, { meet });
    lines.push(`\n■ 경주기록: ${items.length}건`);
    if (items[0]) lines.push("\n[경주기록 첫 항목]\n" + describeItem(items[0]));
  } catch (err) { lines.push(`\n■ 경주기록: 실패 — ${err.message}`); }

  out.textContent = lines.join("\n") + "\n\n이 화면 전체를 캡처해 주세요 (길면 여러 장).";
};

/* =========================================================
 * 7. 기록·채점·통계
 * ========================================================= */
$("btnSaveRecord").onclick = () => {
  if (!lastResult || lastResult.scored.length < 2) { toast("분석할 출전마가 부족합니다."); return; }
  const m = current.meta;
  const id = `${ymd(m.date)}-${m.track}-${m.raceNo}`;
  const exists = records.findIndex(r => r.id === id);
  if (exists >= 0 && !confirm("같은 경주 기록이 있습니다. 덮어쓸까요?")) return;
  const rec = {
    id, savedAt: new Date().toISOString(),
    meta: { ...m },
    fieldSize: lastResult.scored.length,
    horses: current.horses.map(h => ({ num: h.num, name: h.name, winOdds: h.winOdds, placeOdds: h.placeOdds, mark: h.mark })),
    picks: [...lastResult.picks, ...lastResult.baseline],
    result: null, grades: null
  };
  if (exists >= 0) records[exists] = rec; else records.unshift(rec);
  store.set(K.records, records); updateCount();
  toast("기록했습니다. 경주가 끝나면 기록 탭에서 채점하세요.");
};

function applyResult(rec, top, fieldSize) {
  rec.result = { top, fieldSize: fieldSize || rec.fieldSize, gradedAt: new Date().toISOString() };
  rec.grades = {};
  rec.picks.forEach(p => { rec.grades[p.id] = gradePick(p, top, rec.result.fieldSize); });
}

// 대기 중인 기록을 날짜·경마장별로 묶어 한 번씩만 API 호출
$("btnGradeAll").onclick = async () => {
  const pending = records.filter(r => !r.result);
  if (!pending.length) { setStatus("gradeStatus", "채점할 기록이 없습니다.", "ok"); return; }
  const btn = $("btnGradeAll");
  btn.disabled = true;
  setStatus("gradeStatus", "경주 결과를 불러오는 중…");
  const groups = {};
  pending.forEach(r => { (groups[`${r.meta.date}|${r.meta.track}`] ||= []).push(r); });
  let done = 0, fail = [];
  for (const [g, recs] of Object.entries(groups)) {
    const [date, track] = g.split("|");
    try {
      const { items } = await kraFetch(KRA.result.path, { meet: KRA.meetCode[track], [KRA.dateParam]: ymd(date) });
      const f = KRA.fields;
      recs.forEach(rec => {
        const race = items.filter(it => toNum(pick(it, f.rcNo)) === rec.meta.raceNo &&
          (pick(it, f.rcDate) === undefined || String(pick(it, f.rcDate)) === ymd(date)));
        const top = [1, 2, 3].map(o => race.find(it => toNum(pick(it, f.ord)) === o)).map(it => it && Math.round(toNum(pick(it, f.chulNo))));
        if (top[0] && top[1]) { applyResult(rec, top.filter(Boolean), race.length); done++; }
        else fail.push(`${rec.meta.track} ${rec.meta.raceNo}경주`);
      });
    } catch (err) {
      fail.push(`${track} ${date} (${err.message})`);
    }
  }
  store.set(K.records, records); updateCount();
  renderRecords();
  btn.disabled = false;
  setStatus("gradeStatus", `${done}건 채점 완료.` + (fail.length ? ` 결과 없음: ${fail.join(", ")} — 경주 전이거나 응답 형식이 다르면 기록 카드에서 착순을 직접 입력하세요.` : ""), fail.length ? "warn" : "ok");
};

function renderRecords() {
  renderStats();
  if (!records.length) { $("recordList").innerHTML = `<div class="empty">아직 기록이 없습니다. 분석 탭에서 [이 경주 기록하기]를 누르세요.</div>`; return; }
  $("recordList").innerHTML = records.map((r, i) => {
    const main = r.picks.filter(p => p.track !== "기준선");
    const cell = p => {
      const g = r.grades?.[p.id];
      const cls = !g ? "" : g.hit ? "hit" : "miss";
      return `<div class="${cls}">${p.track === "안정형" ? "안" : "공"}·${p.type} ${p.nums.length ? p.nums.join("-") : "없음"}${p.nums.length ? ` (${p.odds.toFixed(1)})` : ""}</div>`;
    };
    return `<div class="record" data-i="${i}">
      <div class="record-head">
        <strong>${r.meta.date} ${r.meta.track} ${r.meta.raceNo}R</strong>
        <span class="record-state ${r.result ? "done" : ""}">${r.result ? `결과 ${r.result.top.join("-")}` : "대기"}</span>
      </div>
      <div class="record-picks">${main.map(cell).join("")}</div>
      <div class="record-actions">
        <input type="text" inputmode="numeric" placeholder="착순 직접 입력: 5,3,9" data-f="top" />
        <button class="btn btn-sm" data-act="grade">채점</button>
        <button class="btn btn-sm btn-danger" data-act="del">삭제</button>
      </div>
    </div>`;
  }).join("");
}

$("recordList").addEventListener("click", e => {
  const box = e.target.closest(".record");
  if (!box) return;
  const rec = records[box.dataset.i];
  if (e.target.dataset.act === "del") {
    if (!confirm("이 기록을 삭제할까요?")) return;
    records.splice(box.dataset.i, 1);
  } else if (e.target.dataset.act === "grade") {
    const top = box.querySelector('[data-f="top"]').value.split(/[,\s\-]+/).map(v => Math.round(toNum(v, 0))).filter(Boolean);
    if (top.length < 2) { toast("1착, 2착(, 3착) 마번을 쉼표로 입력하세요."); return; }
    applyResult(rec, top.slice(0, 3), rec.fieldSize);
  } else return;
  store.set(K.records, records); updateCount();
  renderRecords();
});

function renderStats() {
  const graded = records.filter(r => r.grades);
  if (!graded.length) { $("statsBox").innerHTML = `<div class="empty">채점된 경주가 없습니다.</div>`; return; }
  const rows = [
    ["안정형", ["c_win", "c_place", "c_qp", "c_q"]],
    ["공격형", ["h_win", "h_place", "h_qp", "h_q"]],
    ["기준선(인기순)", ["b_win", "b_place", "b_qp", "b_q"]]
  ];
  const name = { win: "단승", place: "연승", qp: "복연승", q: "복승" };
  const rowHtml = (label, gs) => {
    const n = gs.length, hits = gs.filter(g => g.hit).length;
    const stake = gs.reduce((s, g) => s + g.stake, 0), pay = gs.reduce((s, g) => s + g.payout, 0);
    const roi = stake ? pay / stake * 100 : 0;
    return `<tr><td>${label}</td><td>${n}</td><td>${n ? (hits / n * 100).toFixed(0) + "%" : "-"}</td>
      <td class="${n ? (roi >= 100 ? "good" : "bad") : ""}">${n ? roi.toFixed(0) + "%" : "-"}</td></tr>`;
  };
  let html = `<table class="stats-table"><tr><th>승식</th><th>건수</th><th>적중률</th><th>회수율</th></tr>`;
  rows.forEach(([group, ids]) => {
    html += `<tr class="group"><td colspan="4">${group}</td></tr>`;
    ids.forEach(id => {
      const gs = graded.map(r => r.grades[id]).filter(Boolean);
      const n = gs.length, hits = gs.filter(g => g.hit).length;
      const stake = gs.reduce((s, g) => s + g.stake, 0), pay = gs.reduce((s, g) => s + g.payout, 0);
      const roi = stake ? pay / stake * 100 : 0;
      html += `<tr><td>${name[id.split("_")[1]]}</td><td>${n}</td><td>${n ? (hits / n * 100).toFixed(0) + "%" : "-"}</td>
        <td class="${n ? (roi >= 100 ? "good" : "bad") : ""}">${n ? roi.toFixed(0) + "%" : "-"}</td></tr>`;
    });
  });
  // 순위별: 각 경주에서 같은 순위를 받은 조합끼리 모아 비교
  html += `<tr class="group"><td colspan="4">순위별 (안정형 / 공격형)</td></tr>`;
  ["안정형", "공격형"].forEach(track => {
    [1, 2].forEach(rank => {
      const gs = graded.map(r => { const p = r.picks.find(x => x.track === track && x.rank === rank); return p && r.grades[p.id]; }).filter(Boolean);
      html += rowHtml(`${track} ${rank}순위`, gs);
    });
  });
  $("statsBox").innerHTML = html + `</table><p class="fineprint">채점 ${graded.length}경주. 표본이 적을 때(30경주 미만) 수치는 우연의 영향이 큽니다.</p>`;
}

/* =========================================================
 * 8. 설정·백업
 * ========================================================= */
function bindSettings() {
  $("geminiKey").value = settings.geminiKey;
  $("geminiModel").value = settings.geminiModel;
  $("dataKey").value = settings.dataKey;
  $("strictMin").checked = settings.strictMin;
  $("versionText").textContent = "버전 " + APP_VERSION;

  $("btnSaveSettings").onclick = () => {
    settings.geminiKey = $("geminiKey").value.trim();
    settings.geminiModel = $("geminiModel").value.trim() || "gemini-3.8-flash";
    settings.dataKey = $("dataKey").value.trim();
    store.set(K.settings, settings);
    toast("저장했습니다.");
  };
  $("strictMin").onchange = e => { settings.strictMin = e.target.checked; store.set(K.settings, settings); recalc(); };

  // 백업에는 API 키를 넣지 않음
  $("btnExport").onclick = () => {
    $("backupBox").value = JSON.stringify({ app: "hpm", version: APP_VERSION, exportedAt: new Date().toISOString(), records }, null, 0);
    $("backupBox").select();
    navigator.clipboard?.writeText($("backupBox").value).then(() => toast("복사했습니다. 메모 앱 등에 붙여넣어 보관하세요."), () => toast("내용을 길게 눌러 복사하세요."));
  };
  $("btnImport").onclick = () => {
    try {
      const data = JSON.parse($("backupBox").value);
      if (data.app !== "hpm" || !Array.isArray(data.records)) throw new Error();
      if (!confirm(`기록 ${data.records.length}건으로 바꿉니다. 현재 기록 ${records.length}건은 사라집니다. 계속할까요?`)) return;
      records = data.records;
      store.set(K.records, records); updateCount();
      toast("가져왔습니다.");
    } catch { toast("백업 내용이 올바르지 않습니다."); }
  };
  $("btnResetAll").onclick = () => {
    if (!confirm("모든 기록을 삭제합니다. 되돌릴 수 없습니다. 계속할까요?")) return;
    records = [];
    store.set(K.records, records); updateCount();
    toast("삭제했습니다.");
  };
}

/* =========================================================
 * 9. 시작
 * ========================================================= */
// 웹 버전에서만 서비스워커 등록 (안드로이드 앱 안에서는 필요 없음)
const isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
if (!isNativeApp && "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* 실패해도 앱은 정상 동작 */ });
}

function init() {
  updateCount();
  bindMeta();
  bindSettings();
  renderHorses();
  recalc();
  if (!store.get(K.agreed, false)) $("introModal").hidden = false;
  $("btnAgree").onclick = () => { store.set(K.agreed, true); $("introModal").hidden = true; };
  $("btnGuide").onclick = () => { $("guideModal").hidden = false; $("guideModal").querySelector(".guide-body").scrollTop = 0; };
  $("btnGuideClose").onclick = () => { $("guideModal").hidden = true; };
  $("guideModal").addEventListener("click", e => { if (e.target.id === "guideModal") $("guideModal").hidden = true; });
}
init();
