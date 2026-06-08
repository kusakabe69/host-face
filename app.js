/* host-face（ホスフェイス） ― 顔と名前 暗記アプリ
 * 静的Web。stores.json と images/<店舗id>/<photo> を使用。
 * 進捗は店舗ごとに localStorage 保存。 */

'use strict';

// ====== 定数 ======
const CHOICE_COUNT = 6;            // 名前候補の数（正解1＋ダミー5）
const MASTER_STREAK = 2;           // 連続正解この数で「覚えた」扱い
const LS_LAST_STORE = 'hostface_lastStore';
const LS_PROGRESS = (sid) => `hostface_progress_${sid}`;

// ====== 状態 ======
let DATA = null;            // stores.json 全体
let store = null;           // 選択中の店舗オブジェクト
let pool = [];              // 出題対象（写真あり）スタッフ配列
let progress = null;        // { qCount, stats: { id: {seen,correct,wrong,streak,lastWrongAt} } }
let session = null;         // { n, score, wrong: [staff...], lastId }
let pendingAnswer = null;   // 答え合わせ表示用 { staff, correct, picked }

// ====== ユーティリティ ======
const $ = (id) => document.getElementById(id);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = $('screen-' + name);
  if (el) el.classList.add('active');
  window.scrollTo(0, 0);
}

// 写真が無い人/読み込み失敗時のプレースホルダー（グレー＋「?」）
const PLACEHOLDER =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400">' +
    '<rect width="100%" height="100%" fill="#1a1a1a"/>' +
    '<text x="50%" y="50%" font-size="120" fill="#3a3a3a" ' +
    'text-anchor="middle" dominant-baseline="central">?</text></svg>'
  );

// photos(配列) を返す。無ければ旧 photo(単数) にフォールバック。
// imgNN.jpg は特殊画像なので表示対象から除外する（保険）。
function staffPhotos(staff) {
  let list = Array.isArray(staff.photos) && staff.photos.length
    ? staff.photos
    : (staff.photo ? [staff.photo] : []);
  return list.filter((p) => !p.split('/').pop().toLowerCase().startsWith('img'));
}

function photoUrl(rel) {
  return `images/${store.id}/${rel}`;
}

// その人の photos からランダムに1枚（無ければ null）。
// 同じ人が再登場したとき、前回と同じ写真が連続しないよう避ける。
function randomPhoto(staff) {
  const ps = staffPhotos(staff);
  if (!ps.length) return null;
  if (ps.length === 1) return ps[0];
  const lastMap = session && session.lastPhoto;
  const prev = lastMap ? lastMap[staff.id] : null;
  let choices = prev ? ps.filter((p) => p !== prev) : ps;
  if (!choices.length) choices = ps;
  const pick = choices[Math.floor(Math.random() * choices.length)];
  if (lastMap) lastMap[staff.id] = pick;
  return pick;
}

// img 要素に写真をセット。失敗時はプレースホルダーへフォールバック。
function setPhoto(imgEl, rel) {
  imgEl.onerror = () => { imgEl.onerror = null; imgEl.src = PLACEHOLDER; };
  imgEl.src = rel ? photoUrl(rel) : PLACEHOLDER;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ====== 進捗（localStorage） ======
function blankStat() {
  return { seen: 0, correct: 0, wrong: 0, streak: 0, lastWrongAt: -9999 };
}

function loadProgress(sid) {
  let p = null;
  try {
    const raw = localStorage.getItem(LS_PROGRESS(sid));
    if (raw) p = JSON.parse(raw);
  } catch (e) { p = null; }
  if (!p || typeof p !== 'object') p = {};
  if (typeof p.qCount !== 'number') p.qCount = 0;
  if (!p.stats || typeof p.stats !== 'object') p.stats = {};
  return p;
}

function saveProgress() {
  try {
    localStorage.setItem(LS_PROGRESS(store.id), JSON.stringify(progress));
  } catch (e) { /* 容量超過等は無視 */ }
}

function statOf(id) {
  if (!progress.stats[id]) progress.stats[id] = blankStat();
  return progress.stats[id];
}

function isMastered(id) {
  const s = progress.stats[id];
  return !!s && s.streak >= MASTER_STREAK;
}

// ====== 出題ロジック（苦手・未出題を重点的に） ======
function weightOf(staff) {
  const s = progress.stats[staff.id];
  if (!s || s.seen === 0) return 6;             // 未出題（通常は別枠で処理）
  // ベースを高めにして、苦手補正は控えめ＝「同じ苦手な人ばかり」を防ぎつつ
  // それでも間違えた人がやや出やすい、くらいの軽い重み付けにする。
  let w = 2;
  w += s.wrong * 1.2;                           // 間違えた回数（マイルド）
  const sinceWrong = progress.qCount - s.lastWrongAt;
  if (s.wrong > 0 && sinceWrong < 12) {         // 最近間違えた人を少しだけ
    w += 2 * (1 - sinceWrong / 12);
  }
  if (s.streak === 1) w *= 0.7;                 // あと1回で覚えた、はやや控えめ
  return Math.max(w, 0.3);
}

function pickWeighted(candidates) {
  let total = 0;
  const weights = candidates.map((c) => {
    const w = weightOf(c);
    total += w;
    return w;
  });
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

function nextQuestion() {
  // 直近に出した人は一定期間出さない（同じ人の短時間での繰り返しを防ぐ）。
  // 人数が少ない店舗でも詰まらないよう窓幅は人数に応じて調整。
  const cooldown = Math.min(pool.length - 1, 12);
  let candidates = pool.filter((s) => !session.recent.includes(s.id));
  if (candidates.length === 0) candidates = pool;   // 念のためのフォールバック

  // 「新顔の紹介」と「未習得者の復習」を混ぜる。
  // こうしないと未出題が多い店では新顔ばかり出て、苦手な人が再登場せず
  // 連続正解（＝覚えた）も積み上がらない。
  const unseen = candidates.filter((s) => {
    const st = progress.stats[s.id];
    return !st || st.seen === 0;
  });
  const review = candidates.filter((s) => {
    const st = progress.stats[s.id];
    return st && st.seen > 0 && !isMastered(s.id);   // 既出だがまだ覚えていない人
  });
  const REVIEW_RATIO = 0.4;   // 復習は4割。残り6割は新顔をランダムに

  let target;
  if (review.length && (unseen.length === 0 || Math.random() < REVIEW_RATIO)) {
    target = pickWeighted(review);                              // 苦手・既出を重点的に
  } else if (unseen.length) {
    target = unseen[Math.floor(Math.random() * unseen.length)]; // 新顔を1人
  } else {
    target = pickWeighted(candidates);                          // 全員覚えた後は全体から
  }
  // 直近履歴に追加（窓幅 cooldown を超えたら古いものから捨てる）
  session.recent.push(target.id);
  while (session.recent.length > cooldown) session.recent.shift();

  // 6択：正解＋同店舗からダミー5（名前重複を避ける）
  const distractors = shuffle(store.staff.filter((s) => s.name !== target.name));
  const opts = [target];
  for (const d of distractors) {
    if (opts.length >= CHOICE_COUNT) break;
    if (opts.some((o) => o.name === d.name)) continue;
    opts.push(d);
  }
  const choices = shuffle(opts);

  renderQuestion(target, choices);
}

// ====== 画面描画 ======
function renderStoreList() {
  const wrap = $('store-list');
  wrap.innerHTML = '';
  DATA.stores.forEach((st) => {
    const withPhoto = st.staff.filter((s) => s.has_photo !== false).length;
    const btn = document.createElement('button');
    btn.className = 'store-btn';
    btn.innerHTML = `<span>${escapeHtml(st.name)}</span><span class="count">${withPhoto}人</span>`;
    btn.addEventListener('click', () => selectStore(st.id));
    wrap.appendChild(btn);
  });
}

function selectStore(sid) {
  store = DATA.stores.find((s) => s.id === sid);
  if (!store) return;
  pool = store.staff.filter((s) => s.has_photo !== false);
  progress = loadProgress(sid);
  localStorage.setItem(LS_LAST_STORE, sid);
  renderHome();
  showScreen('home');
}

function masteryNumbers() {
  const total = pool.length;
  const mastered = pool.filter((s) => isMastered(s.id)).length;
  return { total, mastered };
}

function renderHome() {
  $('home-store-name').textContent = store.name;
  const { total, mastered } = masteryNumbers();
  $('home-mastered').textContent = mastered;
  $('home-total').textContent = total;
  $('home-progress-fill').style.width = total ? (mastered / total * 100) + '%' : '0%';
}

function startSession() {
  // 「やめる」を選ぶまで続く無限出題。run の通算成績を持つ。
  session = {
    n: 0, score: 0, ng: 0, wrong: [],
    streak: 0, bestStreak: 0,
    recent: [], lastPhoto: {},
  };
  updateQuizStats();
  advance();
  showScreen('quiz');
}

function advance() {
  session.n += 1;
  nextQuestion();
}

function updateQuizStats() {
  $('q-streak').textContent = session.streak;
  $('q-ok').textContent = session.score;
  $('q-ng').textContent = session.ng;
}

function renderQuestion(target, choices) {
  const chosenPhoto = randomPhoto(target);   // 毎回ランダムで1枚
  pendingAnswer = { staff: target, choices, photo: chosenPhoto };
  $('q-feedback').classList.remove('show');   // 正解オーバーレイを消す
  const img = $('q-photo');
  setPhoto(img, chosenPhoto);
  img.alt = '';
  const wrap = $('q-choices');
  wrap.innerHTML = '';
  choices.forEach((c) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.textContent = c.name;
    btn.addEventListener('click', () => answer(c, btn));
    wrap.appendChild(btn);
  });
}

function answer(picked, btnEl) {
  const target = pendingAnswer.staff;
  const correct = picked.name === target.name;

  // 全ボタンを無効化＆正誤マーク
  const buttons = $('q-choices').querySelectorAll('.choice-btn');
  buttons.forEach((b) => {
    b.disabled = true;
    if (b.textContent === target.name) b.classList.add('correct');
  });
  if (!correct) btnEl.classList.add('wrong');

  // 統計更新
  const s = statOf(target.id);
  s.seen += 1;
  progress.qCount += 1;
  if (correct) {
    s.correct += 1;
    s.streak += 1;
    session.score += 1;
    session.streak += 1;
    if (session.streak > session.bestStreak) session.bestStreak = session.streak;
  } else {
    s.wrong += 1;
    s.streak = 0;
    s.lastWrongAt = progress.qCount;
    session.ng += 1;
    session.streak = 0;
    if (!session.wrong.some((w) => w.id === target.id)) session.wrong.push(target);
  }
  saveProgress();
  updateQuizStats();

  pendingAnswer.correct = correct;
  pendingAnswer.picked = picked;

  clearTimeout(session.timer);
  if (correct) {
    // 正解：「正解！」を約1秒見せて、自動的に次の問題へ（ぽんぽん）
    const fb = $('q-feedback');
    fb.textContent = session.streak >= 2 ? `○ 正解！ 🔥${session.streak}` : '○ 正解！';
    fb.classList.add('show');
    session.timer = setTimeout(onNext, 1000);
  } else {
    // 不正解：確認のため答え合わせ画面で止まる（手動で「次へ」）
    session.timer = setTimeout(showAnswer, 550);
  }
}

function showAnswer() {
  const { staff, correct, picked } = pendingAnswer;
  const banner = $('answer-banner');
  banner.textContent = correct
    ? (session.streak >= 2 ? `○ 正解！ 🔥連続${session.streak}` : '○ 正解！')
    : '× 不正解';
  banner.className = 'answer-banner ' + (correct ? 'ok' : 'ng');

  const img = $('a-photo');
  setPhoto(img, pendingAnswer.photo);   // クイズで表示したのと同じ写真
  img.alt = staff.name;
  $('a-furigana').textContent = staff.reading || '';
  $('a-name').textContent = staff.name;
  $('a-group').textContent = staff.group || '';

  const yp = $('a-yourpick');
  yp.textContent = correct ? '' : `あなたの回答：${picked.name}`;

  showScreen('answer');
}

function onNext() {
  // 10問区切りは廃止。「やめる」を押すまでずっと出題し続ける。
  advance();
  showScreen('quiz');
}

// 「やめる」で終了 → 今回の成績を結果画面で表示
function endSession() {
  if (session) clearTimeout(session.timer);   // 自動送りタイマーを止める
  if (!session || (session.score + session.ng) === 0) {
    renderHome();
    showScreen('home');
    return;
  }
  renderResult();
  showScreen('result');
}

function renderResult() {
  $('result-score').textContent = session.score;
  $('result-total').textContent = session.score + session.ng;
  $('result-best').textContent = session.bestStreak;
  const block = $('result-wrong-block');
  const list = $('result-wrong-list');
  list.innerHTML = '';
  if (session.wrong.length === 0) {
    block.querySelector('.section-heading').textContent = '全問正解！🎉';
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = '間違えはありませんでした。';
    list.appendChild(note);
  } else {
    block.querySelector('.section-heading').textContent = '間違えた人';
    session.wrong.forEach((st) => list.appendChild(miniCard(st)));
  }
}

function miniCard(staff, extra) {
  const div = document.createElement('div');
  div.className = 'mini-card';
  const img = document.createElement('img');
  const ps = staffPhotos(staff);
  setPhoto(img, ps.length ? ps[0] : null);   // 一覧は安定して1枚目
  img.alt = staff.name;
  img.loading = 'lazy';
  div.appendChild(img);
  const nm = document.createElement('div');
  nm.className = 'mc-name';
  nm.textContent = staff.name;
  div.appendChild(nm);
  const fr = document.createElement('div');
  fr.className = 'mc-furi';
  fr.textContent = staff.reading || '';
  div.appendChild(fr);
  if (extra) {
    const ex = document.createElement('div');
    ex.className = 'mc-wrong';
    ex.textContent = extra;
    div.appendChild(ex);
  }
  return div;
}

function renderMastery() {
  $('mastery-store-name').textContent = store.name;
  const { total, mastered } = masteryNumbers();
  $('mastery-mastered').textContent = mastered;
  $('mastery-total').textContent = total;
  $('mastery-progress-fill').style.width = total ? (mastered / total * 100) + '%' : '0%';

  // 全体サマリー：出題した人・正解できた人・合計正解率
  let seenPeople = 0, correctPeople = 0, sumSeen = 0, sumCorrect = 0;
  pool.forEach((s) => {
    const st = progress.stats[s.id];
    if (!st || st.seen === 0) return;
    seenPeople += 1;
    if (st.correct > 0) correctPeople += 1;
    sumSeen += st.seen;
    sumCorrect += st.correct;
  });
  const rate = sumSeen ? Math.round(sumCorrect / sumSeen * 100) : 0;
  $('ms-seen').textContent = seenPeople;
  $('ms-seen-total').textContent = total;
  $('ms-correct-people').textContent = correctPeople;
  $('ms-seen2').textContent = seenPeople;
  $('ms-rate').textContent = rate;
  $('ms-correct').textContent = sumCorrect;
  $('ms-answers').textContent = sumSeen;

  // 区分ごとの達成度
  const groupsWrap = $('mastery-groups');
  groupsWrap.innerHTML = '';
  const order = ['ランキング', 'スタッフ', '運営スタッフ'];
  const groups = {};
  pool.forEach((s) => {
    const g = s.group || 'その他';
    if (!groups[g]) groups[g] = { total: 0, mastered: 0 };
    groups[g].total += 1;
    if (isMastered(s.id)) groups[g].mastered += 1;
  });
  const keys = Object.keys(groups).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  keys.forEach((g) => {
    const d = groups[g];
    const row = document.createElement('div');
    row.className = 'group-row';
    const pct = d.total ? (d.mastered / d.total * 100) : 0;
    row.innerHTML =
      `<div class="gr-head"><span>${escapeHtml(g)}</span>` +
      `<span class="gr-count">${d.mastered} / ${d.total}</span></div>` +
      `<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
    groupsWrap.appendChild(row);
  });

  // 苦手な人一覧（間違え回数が多い順 → 未習得を表示）
  const weakWrap = $('mastery-weak-list');
  weakWrap.innerHTML = '';
  const weak = pool
    .map((s) => ({ s, st: progress.stats[s.id] }))
    .filter((x) => x.st && (x.st.wrong > 0 || (x.st.seen > 0 && !isMastered(x.s.id))))
    .sort((a, b) => {
      const wb = (b.st.wrong || 0) - (a.st.wrong || 0);
      if (wb !== 0) return wb;
      return (b.st.lastWrongAt || 0) - (a.st.lastWrongAt || 0);
    })
    .slice(0, 24);
  if (weak.length === 0) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'まだデータがありません。クイズをやると苦手な人がここに出ます。';
    weakWrap.appendChild(note);
  } else {
    weak.forEach((x) => {
      const extra = x.st.wrong > 0 ? `×${x.st.wrong}` : '';
      weakWrap.appendChild(miniCard(x.s, extra));
    });
  }

  // 全員の成績（出題回数・正解数・正解率）。出題済みを正解率の低い順に。
  const allWrap = $('mastery-all-list');
  allWrap.innerHTML = '';
  const rows = pool
    .map((s) => ({ s, st: progress.stats[s.id] }))
    .filter((x) => x.st && x.st.seen > 0)
    .sort((a, b) => {
      const ra = a.st.correct / a.st.seen;
      const rb = b.st.correct / b.st.seen;
      if (ra !== rb) return ra - rb;                 // 正解率が低い人を上に
      return b.st.seen - a.st.seen;
    });
  if (rows.length === 0) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'まだ出題していません。クイズをやると、ここに各人の成績が出ます。';
    allWrap.appendChild(note);
  } else {
    rows.forEach((x) => {
      const pct = Math.round(x.st.correct / x.st.seen * 100);
      const row = document.createElement('div');
      row.className = 'person-row' + (isMastered(x.s.id) ? ' mastered' : '');
      row.innerHTML =
        `<span class="pr-name">` +
        (isMastered(x.s.id) ? '<span class="pr-badge">覚えた</span>' : '') +
        `${escapeHtml(x.s.name)}<span class="pr-furi">${escapeHtml(x.s.reading || '')}</span></span>` +
        `<span class="pr-stat">${x.st.seen}</span>` +
        `<span class="pr-stat">${x.st.correct}</span>` +
        `<span class="pr-stat pr-rate">${pct}%</span>`;
      allWrap.appendChild(row);
    });
  }
}

function resetProgress() {
  if (!confirm(`「${store.name}」の進捗をすべて消します。よろしいですか？`)) return;
  localStorage.removeItem(LS_PROGRESS(store.id));
  progress = loadProgress(store.id);
  renderMastery();
  renderHome();
}

// ====== HTMLエスケープ ======
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ====== イベント結線 ======
function wireEvents() {
  document.querySelectorAll('[data-go]').forEach((el) => {
    el.addEventListener('click', () => {
      const dest = el.getAttribute('data-go');
      if (dest === 'store') { renderStoreList(); showScreen('store'); }
      else if (dest === 'home') { renderHome(); showScreen('home'); }
      else if (dest === 'mastery') { renderMastery(); showScreen('mastery'); }
    });
  });
  $('start-btn').addEventListener('click', startSession);
  $('again-btn').addEventListener('click', startSession);
  $('next-btn').addEventListener('click', onNext);
  $('quit-btn').addEventListener('click', endSession);
  $('reset-btn').addEventListener('click', resetProgress);
}

// ====== 起動 ======
async function init() {
  wireEvents();
  try {
    const res = await fetch('stores.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    DATA = await res.json();
  } catch (e) {
    $('error-detail').textContent = String(e);
    showScreen('error');
    return;
  }
  renderStoreList();
  // 前回の店舗があればホームへ復帰
  const last = localStorage.getItem(LS_LAST_STORE);
  if (last && DATA.stores.some((s) => s.id === last)) {
    selectStore(last);
  } else {
    showScreen('store');
  }
}

init();
