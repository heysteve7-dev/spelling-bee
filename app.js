import { parseTranscript, isCorrect, spelledOut } from './grader.js';
import { store, dayKey } from './store.js';

export const APP_VERSION = '1.4.1';

// ───────────────────────── settings (per device) ─────────────────────────
const DEFAULTS = { v: 2, wordRate: 0.7, talkRate: 0.8, pauseMs: 700, spellVolume: 0.55, thinkSeconds: 8, graduateAfter: 2, voiceURI: '' };
const saved = JSON.parse(localStorage.getItem('sb_settings') || '{}');
const settings = Object.assign({}, DEFAULTS, saved);
if (!saved.v) { // older version: switch to the new slower voice and "2 correct" rule
  Object.assign(settings, { v: 2, wordRate: DEFAULTS.wordRate, talkRate: DEFAULTS.talkRate, graduateAfter: 2 });
  delete settings.rate;
}
const saveSettings = () => localStorage.setItem('sb_settings', JSON.stringify(settings));
saveSettings();

// ───────────────────────── helpers ─────────────────────────
const $app = document.getElementById('app');
const $home = document.getElementById('homeBtn');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (c, t) => (t ? Math.round((100 * c) / t) + '%' : '–');
function toast(msg) {
  const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2400);
}
const LEVELS = ['One Bee', 'Two Bee', 'Three Bee'];
let WORDS = [];
const byId = new Map();

function record(w) {
  return store.get(w.id) || { id: w.id, word: w.word, level: w.level, attempts: 0, correct: 0, wrong: 0,
    inNotebook: false, graduated: false, reviewStreak: 0, reasons: [], lastResult: null, lastAt: 0 };
}
// new = never tried · focus = needs repeating · learned = was focus, now correct enough · solid = never a problem
function status(w) {
  const r = store.get(w.id);
  if (!r || !r.attempts) return 'new';
  if (r.inNotebook) return 'focus';
  if (r.graduated) return 'learned';
  return 'solid';
}
// A word switched Off (on the Focus words screen) is left out of every test until switched back On.
const isOff = (w) => !!store.get(w.id)?.off;
const focusWords = () => WORDS.filter((w) => status(w) === 'focus' && !isOff(w));

// ───────────────────────── speech: talking ─────────────────────────
let voice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
  voice = vs.find((v) => v.voiceURI === settings.voiceURI)
    || vs.find((v) => /en[-_]US/i.test(v.lang) && /samantha|ava|allison|google us/i.test(v.name))
    || vs.find((v) => /en[-_]US/i.test(v.lang)) || vs[0] || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

// iOS Safari: speech must first start inside a tap (we unlock on the first touch);
// cancel() right before speak() can drop the new utterance, so only cancel when busy;
// the Silent switch mutes this voice, so we show a hint if nothing plays.
let ttsUnlocked = false;
function unlockTTS() {
  if (ttsUnlocked || !('speechSynthesis' in window)) return;
  ttsUnlocked = true;
  const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u);
}
document.addEventListener('touchend', unlockTTS, { once: true, capture: true });
document.addEventListener('click', unlockTTS, { once: true, capture: true });

let speakSeq = 0;   // a newer request stops an older multi-part one
function speakOne(text, { rate = settings.talkRate, volume = 1, pitch = 1 } = {}) {
  return new Promise((res) => {
    if (!('speechSynthesis' in window)) { toast('This browser cannot speak. Use Safari.'); return res(); }
    if (!voice) pickVoice();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'en-US';
    u.rate = rate; u.volume = volume; u.pitch = pitch;
    let started = false;
    u.onstart = () => { started = true; };
    u.onend = () => { started = true; res(); };
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') toast('Speech error: ' + e.error); res(); };
    speechSynthesis.speak(u);
    if (speechSynthesis.paused) speechSynthesis.resume();
    setTimeout(() => { if (!started && !speechSynthesis.speaking) toast('No sound? Turn off Silent mode and turn the volume up.'); }, 3000);
  });
}
function stopSpeaking() {
  speakSeq++;
  if ('speechSynthesis' in window && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
}
// General talking (meaning, sentence, feedback) — slower than normal speech.
function say(text) { stopSpeaking(); return speakOne(text, { rate: settings.talkRate }); }
// The question: "Spell" (softer) … pause … "funny" (louder, slow).
async function askWord(word) {
  stopSpeaking(); const my = speakSeq;
  await speakOne('Spell', { rate: settings.wordRate, volume: settings.spellVolume, pitch: 0.95 });
  if (my !== speakSeq) return;
  await sleep(settings.pauseMs);
  if (my !== speakSeq) return;
  await speakOne(word, { rate: settings.wordRate * 0.9, volume: 1, pitch: 1.05 });
}

// ───────────────────────── speech: listening ─────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const canListen = !!SR;

// ───────────────────────── version / refresh ─────────────────────────
async function latestVersion() {
  try { const r = await fetch('version.json?ts=' + Date.now(), { cache: 'no-store' }); return (await r.json()).version; }
  catch { return null; }
}
function versionHTML() { return `<div class="version" id="versionLine">App v${APP_VERSION} · checking for updates…</div>`; }
async function fillVersion() {
  const el = document.getElementById('versionLine'); if (!el) return;
  const v = await latestVersion();
  if (!document.body.contains(el)) return;
  if (!v) el.textContent = `App v${APP_VERSION} · could not check for updates (offline?)`;
  else if (v === APP_VERSION) el.innerHTML = `App v${APP_VERSION} · ✅ This is the latest version`;
  else el.innerHTML = `App v${APP_VERSION} · ⬆️ <b>v${esc(v)} is available</b> — tap “Update app”`;
}
// Clears the app's cached files and reloads. Does NOT delete practice records.
async function hardRefresh() {
  toast('Updating app…');
  try { const regs = await navigator.serviceWorker?.getRegistrations?.(); for (const r of regs || []) await r.unregister(); } catch {}
  try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
  location.replace(location.pathname + '?v=' + Date.now());
}

// ───────────────────────── home ─────────────────────────
let currentLevel = localStorage.getItem('sb_level') || 'One Bee';

function renderHome() {
  dropRec(); $home.hidden = true;
  const nf = focusWords().length;
  const today = store.days[dayKey()] || { total: 0, correct: 0 };
  const lvlStats = [...LEVELS, 'All'].map((l) => {
    const ws = WORDS.filter((w) => l === 'All' || w.level === l);
    return { l, n: ws.length, seen: ws.filter((w) => status(w) !== 'new').length };
  });
  $app.innerHTML = `
    <section class="card todaybar">
      <span>Today</span><b>${today.total}</b> questions · <b>${today.correct}</b> correct · <b>${pct(today.correct, today.total)}</b>
    </section>
    <section class="card">
      <h2>Choose a level</h2>
      <div class="levels">
        ${lvlStats.map((s) => `
          <button class="level ${s.l === currentLevel ? 'on' : ''}" data-level="${s.l}">
            <b>${s.l}</b><small>${s.seen}/${s.n} tried</small>
          </button>`).join('')}
      </div>
      <button class="big primary" id="practiceBtn">▶ Practice</button>
      <button class="big ${nf ? 'warn' : ''}" id="reviewBtn" ${nf ? '' : 'disabled'}>🔥 Practice focus words (${nf})</button>
    </section>
    <section class="homegrid">
      <button class="mid" id="wordsBtn">📚 Word list</button>
      <button class="mid" id="focusBtn">🔥 Focus words</button>
      <button class="mid" id="dashBtn">📊 Dashboard</button>
      <button class="mid" id="settingsBtn">⚙️ Settings</button>
    </section>
    ${!canListen ? '<p class="note">This browser can’t listen to speech, so answers are typed. On iPhone/iPad, open in Safari.</p>' : ''}
    <div class="account">
      ${store.mode === 'cloud' ? `👤 ${esc(store.user?.email)} · <button class="link small" id="logoutBtn">Sign out</button>` : '📱 Saved on this device only'}
    </div>
    ${versionHTML()}`;
  $app.querySelectorAll('.level').forEach((b) => b.onclick = () => {
    currentLevel = b.dataset.level; localStorage.setItem('sb_level', currentLevel); renderHome();
  });
  document.getElementById('practiceBtn').onclick = () => startQuiz('practice');
  document.getElementById('reviewBtn').onclick = () => startQuiz('review');
  document.getElementById('focusBtn').onclick = renderFocus;
  document.getElementById('wordsBtn').onclick = () => { if (LEVELS.includes(currentLevel)) wl.level = currentLevel; renderWordList(); };
  document.getElementById('dashBtn').onclick = () => renderDashboard('daily');
  document.getElementById('settingsBtn').onclick = renderSettings;
  const lo = document.getElementById('logoutBtn'); if (lo) lo.onclick = () => store.logout();
  fillVersion();
}

// ───────────────────────── quiz ─────────────────────────
let quiz = null;

// ── Question order ──
// • Each level has a shuffled "deck" of all its words, saved on this device. Words come in deck order,
//   so no word repeats until the whole deck has been used — even if the app is closed and reopened.
// • "Shown" counts too: a word that was skipped was still shown, and waits like an answered word.
// • A word shown or answered in the last 20 minutes (answers count from any device) waits for a later turn.
// • Focus words get an extra turn exactly once every 5 questions — the one shown longest ago,
//   and only if it wasn't shown or answered in the last 30 minutes. A focus word skipped in this
//   practice doesn't come back in this practice.
// • Learned words are skipped half the time when their turn in the deck comes (asked less often).
// • Words switched Off are never asked.
const DECK_KEY = 'sb_deck_v2', SHOWN_KEY = 'sb_shown_v2';
const MIN = 60 * 1000;
const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
function shownLog() { return loadJSON(SHOWN_KEY, {}); }                    // wordId -> last time shown on this device
function recentIds() { return Object.entries(shownLog()).sort((a, b) => a[1] - b[1]).map(([id]) => +id); }
function markAsked(id) {
  const log = shownLog(); log[id] = Date.now();
  const keep = Object.entries(log).sort((a, b) => b[1] - a[1]).slice(0, 300); // keep it small
  localStorage.setItem(SHOWN_KEY, JSON.stringify(Object.fromEntries(keep)));
}
const lastSeen = (w) => Math.max(shownLog()[w.id] || 0, store.get(w.id)?.lastAt || 0);
const seenWithin = (w, minutes) => Date.now() - lastSeen(w) < minutes * MIN;

function fromDeck(level, skip) {
  const ids = WORDS.filter((w) => level === 'All' || w.level === level).map((w) => w.id);
  const decks = loadJSON(DECK_KEY, {});
  let d = decks[level];
  const valid = d && Array.isArray(d.order) && d.order.length === ids.length;
  if (!valid) d = { order: shuffle([...ids]), pos: 0 };
  for (let guard = 0; guard < ids.length * 2 + 5; guard++) {
    if (d.pos >= d.order.length) {
      // new round: reshuffle; words seen most recently go to the back
      const order = shuffle([...ids]);
      d = { order: [...order.filter((id) => !seenWithin(byId.get(id), 60)), ...order.filter((id) => seenWithin(byId.get(id), 60))], pos: 0 };
    }
    const w = byId.get(d.order[d.pos++]);
    if (!w || skip.has(w.id) || isOff(w)) continue;
    if (status(w) === 'focus') continue;                       // focus words have their own turns
    if (guard < ids.length && seenWithin(w, 20)) continue;
    if (status(w) === 'learned' && Math.random() < 0.5) continue;
    decks[level] = d; localStorage.setItem(DECK_KEY, JSON.stringify(decks));
    return w;
  }
  decks[level] = d; localStorage.setItem(DECK_KEY, JSON.stringify(decks));
  return WORDS.find((w) => (level === 'All' || w.level === level) && !isOff(w) && !skip.has(w.id))
    || (skip.size ? fromDeck(level, new Set()) : null);
}
function pickNext() {
  const inSession = new Set(quiz.items.map((it) => it.word.id));
  if (quiz.mode === 'review') {
    // go through every (On) focus word once, shuffled, before repeating any
    quiz.queue = (quiz.queue || []).filter((w) => status(w) === 'focus' && !isOff(w));
    if (!quiz.queue.length) {
      // new round with every focus word; just don't start it with the word that was asked last
      const lastId = quiz.items[quiz.items.length - 1]?.word.id;
      quiz.queue = shuffle(focusWords());
      if (quiz.queue.length > 1 && quiz.queue[0].id === lastId) quiz.queue.push(quiz.queue.shift());
    }
    return quiz.queue.shift() || null;
  }
  const inLevel = (w) => currentLevel === 'All' || w.level === currentLevel;
  quiz.sinceFocus = (quiz.sinceFocus ?? 0) + 1;
  if (quiz.sinceFocus >= 5) {
    const focus = focusWords().filter((w) => inLevel(w) && !inSession.has(w.id) && !seenWithin(w, 30))
      .sort((a, b) => lastSeen(a) - lastSeen(b));
    if (focus.length) { quiz.sinceFocus = 0; return focus[0]; }
  }
  return fromDeck(currentLevel, inSession);
}

function startQuiz(mode) {
  quiz = { mode, items: [], idx: -1, right: 0, queue: [] };
  nextQuestion();
}
function newQ() {
  return { showText: false, replays: 0, startedAt: Date.now(), answeredAt: 0, baseLetters: '', session: null, transcriptAll: '',
    parsed: null, result: null, override: null, hard: false, method: null };
}
function showItem(i, speak) {
  dropRec(); stopSpeaking();
  quiz.idx = i;
  const it = quiz.items[i];
  quiz.word = it.word; quiz.q = it.q;
  renderQuestion();
  if (speak && !it.q.result) {
    const w = it.word;
    askWord(w.word).then(() => { if (quiz?.word === w && !quiz.q.answeredAt) quiz.q.startedAt = Date.now(); });
  }
}
// ▶ Next: save the current answer (if any), then go forward — to a question already seen, or a new one.
// An unanswered question can be skipped; it is not recorded.
function nextQuestion() {
  commit();
  if (quiz.idx < quiz.items.length - 1) return showItem(quiz.idx + 1, !quiz.items[quiz.idx + 1].q.result);
  const w = pickNext();
  if (!w) { toast(quiz.mode === 'review' ? 'No focus words switched On — great job! 🎉' : 'All words here are switched Off.'); return renderHome(); }
  markAsked(w.id);
  quiz.items.push({ word: w, q: newQ() });
  showItem(quiz.items.length - 1, true);
}
// ◀ Prev: look back at the previous question (its result if it was answered, or answer it now if skipped).
function prevQuestion() {
  if (quiz.idx <= 0) return;
  commit();
  showItem(quiz.idx - 1, !quiz.items[quiz.idx - 1].q.result);
}

const maskWord = (sentence, word) => {
  const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'ig');
  return sentence.replace(re, '_____');
};
function clueHTML(revealed) {
  const w = quiz.word;
  const sent = revealed ? w.sentence : maskWord(w.sentence || '', w.word);
  return `<div><b>${esc(w.part_of_speech)}</b> — ${esc(w.definition)}</div><div class="muted">“${esc(sent)}”</div>`;
}

function renderQuestion() {
  $home.hidden = false;
  const q = quiz.q;
  $app.innerHTML = `
    <div class="quizhead">
      <span>${quiz.mode === 'review' ? '🔥 Focus words' : '▶ ' + esc(currentLevel)}</span>
      <span>#${quiz.idx + 1} · ✅ ${quiz.right}</span>
    </div>
    <div class="qnav">
      <button class="small" id="prevBtn" ${quiz.idx > 0 ? '' : 'disabled'}>◀ Prev</button>
      <button class="small" id="skipBtn">${q.result ? 'Next ▶' : 'Skip ▶'}</button>
    </div>
    <section class="card center">
      <div class="helpers">
        <button class="hear" id="repeatBtn">🔁 Repeat</button>
        <button class="hear" id="defBtn">📖 Meaning</button>
        <button class="hear" id="sentBtn">💬 Sentence</button>
      </div>
      <button class="textbtn" id="textBtn">${q.showText ? '🙈 Hide text' : '📝 Show text'}</button>
      <div class="clue" id="clue">${q.showText ? clueHTML(false) : ''}</div>
      <p class="muted small">Spell it letter by letter, then say the word.<br>Example: “S – O – U – R – C – E, source”</p>
      <div id="answerArea"></div>
    </section>`;
  document.getElementById('prevBtn').onclick = prevQuestion;
  document.getElementById('skipBtn').onclick = nextQuestion;
  bindHelpers();
  renderAnswerArea();
}

// 🔁 Repeat / 📖 Meaning / 💬 Sentence speak only; 📝 Show text shows them on screen.
// Before answering, the word is hidden in the sentence so the screen doesn't give the spelling away.
function bindHelpers() {
  const w = quiz.word, q = quiz.q;
  document.getElementById('repeatBtn').onclick = () => { if (!q.result) q.replays++; askWord(w.word); };
  document.getElementById('defBtn').onclick = () => say(`${w.part_of_speech ? w.part_of_speech + '. ' : ''}${w.definition || ''}`);
  document.getElementById('sentBtn').onclick = () => say(w.sentence || w.word);
  document.getElementById('textBtn').onclick = (e) => {
    q.showText = !q.showText;
    e.target.textContent = q.showText ? '🙈 Hide text' : '📝 Show text';
    document.getElementById('clue').innerHTML = q.showText ? clueHTML(!!q.result) : '';
  };
}

function renderAnswerArea() {
  const q = quiz.q, area = document.getElementById('answerArea');
  if (!area) return;
  if (q.result) return renderResult(area);
  const has = !!q.parsed?.letters;
  area.innerHTML = `
    ${canListen ? `
      <button class="mic ${listening ? 'live' : ''}" id="micBtn">${listening ? '⏹ Done' : has ? '🎤 Keep spelling' : '🎤 Tap and spell'}</button>
      <div class="heard" id="heard">${q.parsed ? esc(q.parsed.display || '…') : (listening ? 'Listening…' : '&nbsp;')}</div>
      <div class="fixrow" id="fixRow" ${has || listening ? '' : 'hidden'}>
        <button class="fix" id="undoBtn">↩️ Undo letter</button>
        <button class="fix" id="clearBtn">🗑 Start over</button>
      </div>
      <div class="raw" id="micStatus">${listening ? esc(q.micStatus || '⏳ starting mic…') : (q.micStatus && q.micStatus.startsWith('⚠️') ? esc(q.micStatus) : '')}</div>
      <div class="raw" id="rawHeard">${(q.session?.transcript || q.lastRaw) ? 'raw: “' + esc(q.session?.transcript || q.lastRaw) + '”' : ''}</div>
      ${q.parsed && !listening ? `
        ${q.parsed.wholeWord ? `<p class="warnmsg">I heard a whole word (“${esc(q.parsed.unknown.join(' '))}”), not letters.<br>Please spell it letter by letter.</p>` : ''}
        ${!q.parsed.wholeWord && q.parsed.unknown.length ? `<p class="warnmsg">I didn’t understand: “${esc(q.parsed.unknown.join(' '))}”. Undo, start over, or check anyway.</p>` : ''}
        ${has && !q.parsed.wholeWord ? '<button class="big primary" id="checkBtn">✓ Check</button>' : ''}` : ''}
      <details class="typebox"><summary>⌨️ Type instead</summary>${typeForm()}</details>
    ` : typeForm()}`;
  const mic = document.getElementById('micBtn');
  if (mic) mic.onclick = () => (listening ? stopListening(true) : startListening());
  const undo = document.getElementById('undoBtn'); if (undo) undo.onclick = () => fixSpelling('undo');
  const clear = document.getElementById('clearBtn'); if (clear) clear.onclick = () => fixSpelling('clear');
  const check = document.getElementById('checkBtn');
  if (check) check.onclick = () => grade(q.parsed.letters, 'voice');
  const form = document.getElementById('typeForm');
  form.onsubmit = (e) => { e.preventDefault(); const v = form.ans.value.trim(); if (v) grade(v, 'typed'); };
  form.ans.onfocus = () => { if (!q.answeredAt) q.answeredAt = Date.now(); };
}
const typeForm = () => `
  <form id="typeForm" class="typeform">
    <input name="ans" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="type the spelling">
    <button class="mid primary">✓ Check</button>
  </form>`;

// How voice answers are kept:
//   q.baseLetters  = letters already confirmed from earlier mic sessions (after a pause, Undo, or Start over)
//   q.session      = what the mic is hearing right now
// Undo / Start over end the current mic session, fix the letters, and turn the mic back on,
// so the child can just keep talking — no typing needed.
function combine(q) {
  const sp = q.session?.parsed;
  const sLetters = sp?.letters || '';
  const off = Math.min(q.session?.offset || 0, sLetters.length);
  const letters = (q.baseLetters || '') + sLetters.slice(off);
  let unknown = (sp?.unknown || []).slice(q.session?.unknownOffset || 0);
  if (q.baseLetters) { // saying the word itself after spelling is fine
    const target = quiz.word.word.toLowerCase();
    unknown = unknown.filter((u) => !target.split(/[\s-]+/).includes(u));
  }
  q.parsed = { letters, display: letters.toUpperCase().split('').join(' '), unknown,
    wholeWord: !letters && !!sp?.wholeWord && unknown.length > 0 };
  return q.parsed;
}
function showLive(q) {
  const h = document.getElementById('heard'); if (h) h.textContent = q.parsed?.display || (listening ? 'Listening…' : '');
  const raw = document.getElementById('rawHeard'); const t = q.session?.transcript || q.lastRaw;
  if (raw) raw.textContent = t ? 'raw: “' + t + '”' : '';
  const fr = document.getElementById('fixRow'); if (fr) fr.hidden = !(q.parsed?.letters || listening);
}
// Undo / Start over.
// iPhone Safari only lets the mic start from a direct tap, so we never restart the mic in the background.
//  • mic on:  keep it running; just mark how much of what it heard is "used up" and continue after it
//  • mic off: fix the letters and turn the mic on right away (still inside the tap)
function fixSpelling(action) {
  const q = quiz.q;
  const current = combine(q).letters;
  q.baseLetters = action === 'undo' ? current.slice(0, -1) : '';
  if (listening && q.session) {
    q.session.offset = q.session.parsed?.letters.length || 0;
    q.session.unknownOffset = q.session.parsed?.unknown.length || 0;
    q.session.transcript = '';   // only the raw display; letters come from parsed + offset
    combine(q); if (!q.parsed.letters) q.parsed = null;
    showLive(q); renderAnswerArea();
    return;
  }
  q.session = null; q.lastRaw = '';
  combine(q); if (!q.parsed.letters) q.parsed = null;
  startListening();
}

let rec = null, listening = false, userStopped = false;
// Fully forget a mic session (also used when the browser never reports that it ended).
function dropRec() {
  if (rec) { const r = rec; r.onresult = r.onend = r.onerror = r.onstart = r.onaudiostart = r.onspeechstart = null; try { r.abort(); } catch {} }
  rec = null; listening = false;
}
function startListening() {
  const q = quiz.q;
  if (!q.answeredAt) q.answeredAt = Date.now();
  stopSpeaking();
  dropRec();
  const r = new SR();
  rec = r;
  r.lang = 'en-US'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
  q.session = { transcript: '', parsed: null, offset: 0, unknownOffset: 0, rawAll: '' };
  userStopped = false;
  let started = false, ended = false;
  const status = (msg) => { q.micStatus = msg; const el = document.getElementById('micStatus'); if (el) el.textContent = msg; };
  r.onstart = () => { started = true; status('🎙️ mic on — start spelling'); };
  r.onaudiostart = () => { started = true; status('🎙️ hearing audio…'); };
  r.onspeechstart = () => status('🗣️ hearing your voice…');
  r.onresult = (e) => {
    started = true;
    // Safari on iPhone sometimes repeats earlier text inside later results; keep only the longest version.
    const parts = [];
    for (let i = 0; i < e.results.length; i++) {
      const tr = e.results[i][0].transcript.trim();
      if (!tr) continue;
      const last = parts[parts.length - 1];
      if (last && tr.toLowerCase().startsWith(last.toLowerCase())) parts[parts.length - 1] = tr;
      else if (last && last.toLowerCase().startsWith(tr.toLowerCase())) continue;
      else parts.push(tr);
    }
    if (!q.session || rec !== r) return;
    const full = parts.join(' ').trim();
    q.session.rawAll = full;
    q.session.parsed = parseTranscript(full, quiz.word.word);
    q.session.transcript = full;
    combine(q); showLive(q);
    status('🗣️ got it — tap Done when finished');
  };
  r.onerror = (e) => {
    if (e.error === 'aborted') return;
    status('⚠️ mic error: ' + e.error);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Mic or Siri & Dictation is off. See the setup tips.');
    else if (e.error === 'no-speech') toast('I didn’t hear anything. Speak a little louder and closer.');
    else toast('Mic error: ' + e.error);
  };
  const finish = () => {
    if (ended || rec !== r) return;
    ended = true;
    dropRec();
    if (quiz?.q !== q) return;
    if (q.session?.rawAll) q.transcriptAll = ((q.transcriptAll || '') + ' | ' + q.session.rawAll).replace(/^ \| /, '');
    combine(q);
    const whole = q.parsed.wholeWord, unk = q.parsed.unknown;
    if (!whole) q.baseLetters = q.parsed.letters;
    q.lastRaw = q.session?.rawAll || '';
    q.session = null; combine(q);
    q.parsed.wholeWord = whole; q.parsed.unknown = unk;
    if (userStopped && q.parsed.letters && !whole && !unk.length) return grade(q.parsed.letters, 'voice');
    if (!q.parsed.letters && !whole) q.parsed = null;
    renderAnswerArea();
  };
  r.onend = finish;
  r._finish = finish;
  try { r.start(); listening = true; }
  catch (err) { dropRec(); status('⚠️ Mic didn’t start — tap the mic again'); toast('Could not start the mic. Tap 🎤 again.'); }
  // If the mic never really starts (no events at all), don't stay stuck in "listening".
  setTimeout(() => { if (rec === r && !started) { status('⚠️ Mic didn’t start — tap the mic again'); finish(); } }, 4000);
  renderAnswerArea();
}
function stopListening(byUser = false) {
  if (!rec) { listening = false; return; }
  const r = rec;
  userStopped = byUser;
  try { r.stop(); } catch {}
  // Safari sometimes never sends "end" — finish ourselves after a moment.
  setTimeout(() => { if (rec === r) r._finish?.(); }, 1500);
}

function grade(answer, method) {
  const q = quiz.q, w = quiz.word;
  dropRec();
  q.method = method;
  q.answer = answer;
  q.result = isCorrect(answer, w) ? 'correct' : 'wrong';
  if (!q.answeredAt) q.answeredAt = Date.now();
  q.thinkSec = Math.max(0, Math.round((q.answeredAt - q.startedAt) / 100) / 10);
  say(q.result === 'correct' ? 'Correct!' : 'Not quite.');
  renderAnswerArea();
}

function finalResult(q) { return q.override || q.result; }
function hardReasons(q) {
  const r = [];
  if (finalResult(q) === 'wrong') r.push('wrong');
  if (q.replays >= 2) r.push('replayed ' + q.replays + 'x');
  if (q.thinkSec >= settings.thinkSeconds) r.push('slow start (' + q.thinkSec + 's)');
  if (q.hard) r.push('marked hard');
  return r;
}

function renderResult(area) {
  const q = quiz.q, w = quiz.word, res = finalResult(q);
  const reasons = hardReasons(q);
  const st = status(w);
  area.innerHTML = `
    <div class="verdict ${res}">${res === 'correct' ? '⭕ Correct!' : '❌ Not quite'}</div>
    <div class="answer">
      <div><small>Word</small><b>${esc(w.word)}</b></div>
      <div><small>Spelling</small><b class="spell">${esc(spelledOut(w.accepted_spellings[0]))}</b></div>
      ${w.accepted_spellings.length > 1 ? `<div><small>Also OK</small><b>${w.accepted_spellings.slice(1).map(esc).join(', ')}</b></div>` : ''}
      <div><small>You said</small><b class="spell ${res}">${esc(spelledOut(q.answer.toLowerCase()))}</b></div>
    </div>
    ${reasons.length ? `<p class="small muted">🔥 Focus word: ${esc(reasons.join(', '))}</p>`
      : st === 'focus' ? `<p class="small muted">🔥 Focus word — correct ${Math.min(settings.graduateAfter, (record(w).reviewStreak || 0) + 1)}/${settings.graduateAfter}</p>` : ''}
    <div class="row">
      <button class="mid ${q.hard ? 'on' : ''}" id="hardBtn">😓 That was hard</button>
      <button class="mid primary" id="nextBtn">Next ▶</button>
    </div>
    <details class="parent"><summary>Parent: fix the result</summary>
      <div class="row">
        <button class="small" data-ov="correct">Mark correct</button>
        <button class="small" data-ov="wrong">Mark wrong</button>
        <button class="small" data-ov="">Undo</button>
      </div>
    </details>`;
  const clue = document.getElementById('clue'); if (clue && q.showText) clue.innerHTML = clueHTML(true);
  document.getElementById('hardBtn').onclick = () => { q.hard = !q.hard; renderAnswerArea(); };
  document.getElementById('nextBtn').onclick = nextQuestion;
  const sk = document.getElementById('skipBtn'); if (sk) sk.textContent = 'Next ▶';
  if (q.committed) { // looking back at a saved answer: show it, but it can no longer be changed
    document.getElementById('hardBtn').disabled = true;
    const par = area.querySelector('.parent'); if (par) par.outerHTML = '<p class="small muted">Saved — this answer can’t be changed now.</p>';
  }
  area.querySelectorAll('[data-ov]').forEach((b) => b.onclick = () => { q.override = b.dataset.ov || null; renderAnswerArea(); });
}

// Save the finished question (called on Next / leaving the quiz).
//  wrong                → becomes a focus word (asked often), correct-count resets
//  correct but hard     → becomes a focus word if it isn't one yet
//  clean correct        → focus words count up; after `graduateAfter` (default 2) → "learned" (asked less)
function commit() {
  const q = quiz?.q; if (!q || !q.result || q.committed) return;
  q.committed = true;
  const w = quiz.word, r = record(w), res = finalResult(q), reasons = hardReasons(q);
  r.attempts++; r.lastAt = Date.now(); r.lastResult = res;
  if (res === 'correct') { r.correct++; quiz.right++; } else r.wrong++;
  const clean = res === 'correct' && !reasons.length;
  if (res === 'wrong') {
    r.inNotebook = true; r.graduated = false; r.reviewStreak = 0;
  } else if (!clean && !r.inNotebook) {
    r.inNotebook = true; r.graduated = false; r.reviewStreak = 0;
  } else if (clean && r.inNotebook) {
    r.reviewStreak = (r.reviewStreak || 0) + 1;
    if (r.reviewStreak >= settings.graduateAfter) {
      r.inNotebook = false; r.graduated = true; r.reasons = [];
      toast(`🎓 “${w.word}” is learned! It will come up less often.`);
    }
  }
  if (reasons.length) r.reasons = [...new Set([...(r.reasons || []), ...reasons.map((x) => x.replace(/\s*\(.*\)|\s\d+x$/, ''))])];
  store.save(r);
  store.logAttempt({ id: w.id, word: w.word, level: w.level, mode: quiz.mode, result: res, answer: q.answer || '',
    method: q.method, override: q.override || null, replays: q.replays, thinkSec: q.thinkSec ?? null, hard: q.hard, transcript: q.transcriptAll || '' });
}

function leaveQuiz() { commit(); dropRec(); stopSpeaking(); }

// ───────────────────────── focus words ─────────────────────────
// Each word has: 🔊 hear it · On/Off switch (Off = left out of all tests) · a button to move it
// between 🔥 Focus and 🎓 Learned by hand.
function renderFocus() {
  leaveQuiz(); $home.hidden = false;
  const focusAll = WORDS.filter((w) => status(w) === 'focus')
    .sort((a, b) => (isOff(a) - isOff(b)) || (store.get(b.id).wrong - store.get(a.id).wrong));
  const learned = WORDS.filter((w) => status(w) === 'learned')
    .sort((a, b) => (isOff(a) - isOff(b)) || (store.get(b.id).lastAt - store.get(a.id).lastAt));
  const active = focusAll.filter((w) => !isOff(w)).length;
  const row = (w, moveLabel, extra) => { const r = store.get(w.id); const off = !!r.off; return `
    <li class="${off ? 'offrow' : ''}">
      <button class="speak" data-say="${esc(w.word)}">🔊</button>
      <div class="grow"><b>${esc(w.word)}</b> <small class="muted">${esc(w.level)}</small><br>
        <small>✅ ${r.correct} · ❌ ${r.wrong}${extra(r)}${off ? ' · <b>Off — not in tests</b>' : ''}</small></div>
      <label class="switch" title="On = in tests, Off = left out"><input type="checkbox" data-onoff="${w.id}" ${off ? '' : 'checked'}><span></span></label>
      <button class="move" data-move="${w.id}">${moveLabel}</button>
    </li>`; };
  const offCount = (list) => list.filter(isOff).length;
  $app.innerHTML = `
    <section class="card">
      <button class="big primary" id="startFocus" ${active ? '' : 'disabled'}>▶ Start practice (${active} words)</button>
      <p class="small muted center">Practices the 🔥 Focus words that are switched On.</p>
    </section>
    <section class="card">
      <h2>🔥 Focus words (${focusAll.length}${offCount(focusAll) ? `, ${offCount(focusAll)} off` : ''})</h2>
      <p class="small muted">Wrong or hard words. They come up often until answered correctly ${settings.graduateAfter} times.<br>
        Switch = On/Off in tests · <b>→ 🎓</b> = move to Learned</p>
      ${focusAll.length ? `<ul class="wordlist">${focusAll.map((w) => row(w, '→ 🎓', (r) => ` · correct ${r.reviewStreak || 0}/${settings.graduateAfter}`)).join('')}</ul>` : '<p>None right now! 🎉</p>'}
    </section>
    <section class="card">
      <h2>🎓 Learned (${learned.length}${offCount(learned) ? `, ${offCount(learned)} off` : ''})</h2>
      <p class="small muted">Answered correctly enough. They come up less often.<br><b>→ 🔥</b> = move back to Focus words</p>
      <ul class="wordlist">${learned.map((w) => row(w, '→ 🔥', () => '')).join('')}</ul>
    </section>`;
  document.getElementById('startFocus').onclick = () => startQuiz('review');
  $app.querySelectorAll('[data-say]').forEach((b) => b.onclick = () => askWord(b.dataset.say));
  $app.querySelectorAll('[data-onoff]').forEach((c) => c.onchange = () => {
    const r = store.get(c.dataset.onoff); r.off = !c.checked; store.save(r); renderFocus();
  });
  $app.querySelectorAll('[data-move]').forEach((b) => b.onclick = () => {
    const r = store.get(b.dataset.move);
    if (r.inNotebook) { r.inNotebook = false; r.graduated = true; toast(`🎓 “${r.word}” moved to Learned`); }
    else { r.inNotebook = true; r.graduated = false; toast(`🔥 “${r.word}” moved to Focus words`); }
    r.reviewStreak = 0; r.reasons = [];
    store.save(r); renderFocus();
  });
}

// ───────────────────────── word list ─────────────────────────
// All words of a level in list order, with status, meaning/sentence (tap the word) and an On/Off switch.
let wl = { level: 'One Bee', q: '' };
const STATUS_BADGE = { new: '<span class="wbadge new">New</span>', solid: '<span class="wbadge solid">✅ OK</span>',
  focus: '<span class="wbadge focus">🔥 Focus</span>', learned: '<span class="wbadge learned">🎓 Learned</span>' };
function renderWordList() {
  leaveQuiz(); $home.hidden = false;
  const all = WORDS.filter((w) => w.level === wl.level);
  const q = wl.q.trim().toLowerCase();
  const list = q ? all.filter((w) => w.word.toLowerCase().includes(q)) : all;
  const count = (st) => all.filter((w) => status(w) === st).length;
  $app.innerHTML = `
    <div class="tabs">${LEVELS.map((l) => `<button class="tab ${wl.level === l ? 'on' : ''}" data-wl="${l}">${l}</button>`).join('')}</div>
    <section class="card">
      <div class="wlsum">${all.length} words · New ${count('new')} · ✅ ${count('solid')} · 🔥 ${count('focus')} · 🎓 ${count('learned')} · Off ${all.filter(isOff).length}</div>
      <input class="search" id="wlSearch" placeholder="Search a word" value="${esc(wl.q)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      <p class="small muted">Tap a word to see its meaning and sentence. Switch Off = left out of tests.</p>
      <ol class="wl">
        ${list.map((w) => { const r = store.get(w.id); const off = isOff(w); const n = all.indexOf(w) + 1; return `
          <li class="${off ? 'offrow' : ''}">
            <span class="num">${n}</span>
            <button class="speak" data-say="${esc(w.word)}">🔊</button>
            <details class="grow">
              <summary><b>${esc(w.word)}</b>${w.accepted_spellings.length > 1 ? ` <small class="muted">(or ${w.accepted_spellings.slice(1).map(esc).join(', ')})</small>` : ''}
                ${STATUS_BADGE[status(w)]}${r?.attempts ? ` <small class="muted">✅${r.correct} ❌${r.wrong}</small>` : ''}</summary>
              <div class="small"><b>${esc(w.part_of_speech)}</b> — ${esc(w.definition)}</div>
              <div class="small muted">“${esc(w.sentence)}”</div>
            </details>
            <label class="switch"><input type="checkbox" data-wloff="${w.id}" ${off ? '' : 'checked'}><span></span></label>
          </li>`; }).join('')}
      </ol>
      ${list.length ? '' : '<p class="muted">No match.</p>'}
    </section>`;
  $app.querySelectorAll('[data-wl]').forEach((b) => b.onclick = () => { wl.level = b.dataset.wl; wl.q = ''; renderWordList(); window.scrollTo(0, 0); });
  const s = document.getElementById('wlSearch');
  s.oninput = () => { wl.q = s.value; const pos = s.selectionStart; renderWordList(); const s2 = document.getElementById('wlSearch'); s2.focus(); s2.setSelectionRange(pos, pos); };
  $app.querySelectorAll('[data-say]').forEach((b) => b.onclick = () => askWord(b.dataset.say));
  $app.querySelectorAll('[data-wloff]').forEach((c) => c.onchange = () => {
    const w = byId.get(+c.dataset.wloff); const r = record(w); r.off = !c.checked; store.save(r);
    c.closest('li').classList.toggle('offrow', !!r.off);
  });
}

// ───────────────────────── dashboard ─────────────────────────
const DAY = 86400000;
const parseDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDay = (k, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) => parseDay(k).toLocaleDateString('en-US', opts);
const shiftDay = (k, n) => { const d = parseDay(k); d.setDate(d.getDate() + n); return dayKey(d.getTime()); };
const mondayOf = (k) => { const d = parseDay(k); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return dayKey(d.getTime()); };
let dash = { tab: 'daily', day: dayKey(), week: mondayOf(dayKey()), gridLevel: 'All', gridOnly: true };

function renderDashboard(tab) {
  leaveQuiz(); $home.hidden = false;
  if (tab) dash.tab = tab;
  const tabs = [['daily', 'Daily'], ['weekly', 'Weekly'], ['grid', 'By word']];
  $app.innerHTML = `
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${dash.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="dashBody"></div>`;
  $app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => renderDashboard(b.dataset.tab));
  ({ daily: renderDaily, weekly: renderWeekly, grid: renderGrid })[dash.tab]();
}

function statCards(items) {
  return `<div class="cards">${items.map(([label, val]) => `<div class="stat"><b>${val}</b><small>${label}</small></div>`).join('')}</div>`;
}
function navBar(label, prevId, nextId, todayId, canNext) {
  return `<div class="nav"><button class="small" id="${prevId}">◀</button><span>${label}</span>
    <button class="small" id="${nextId}" ${canNext ? '' : 'disabled'}>▶</button><button class="small" id="${todayId}">Today</button></div>`;
}

async function renderDaily() {
  const body = document.getElementById('dashBody');
  const k = dash.day, d = store.days[k] || { total: 0, correct: 0, words: {} };
  const nWords = Object.keys(d.words || {}).length;
  const isToday = k === dayKey();
  body.innerHTML = `
    <section class="card">
      ${navBar(fmtDay(k) + (isToday ? ' (today)' : ''), 'dPrev', 'dNext', 'dToday', !isToday)}
      ${statCards([['Questions', d.total], ['Correct', d.correct], ['Wrong', d.total - d.correct], ['Score', pct(d.correct, d.total)], ['Different words', nWords]])}
    </section>
    <section class="card"><h3>Words practiced</h3><div id="dayList" class="muted small">Loading…</div></section>`;
  document.getElementById('dPrev').onclick = () => { dash.day = shiftDay(k, -1); renderDaily(); };
  document.getElementById('dNext').onclick = () => { dash.day = shiftDay(k, 1); renderDaily(); };
  document.getElementById('dToday').onclick = () => { dash.day = dayKey(); renderDaily(); };
  try {
    const start = parseDay(k).getTime();
    const list = await store.attemptsBetween(start, start + DAY);
    if (dash.day !== k || !document.getElementById('dayList')) return;
    document.getElementById('dayList').innerHTML = list.length ? `
      <table class="plain"><tr><th>Time</th><th>Word</th><th></th><th>Answer</th></tr>
      ${list.map((a) => `<tr class="${a.result}">
        <td>${new Date(a.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</td>
        <td><b>${esc(a.word)}</b><br><small class="muted">${esc(a.level)}</small></td>
        <td>${a.result === 'correct' ? '⭕' : '❌'}</td>
        <td>${a.result === 'correct' ? '' : `<span class="wrongtxt">${esc(a.answer)}</span>`}${a.override ? ' <small>(fixed by parent)</small>' : ''}</td></tr>`).join('')}
      </table>` : 'No practice on this day.';
  } catch (e) { console.error(e); document.getElementById('dayList').textContent = 'Could not load the list.'; }
}

function renderWeekly() {
  const body = document.getElementById('dashBody');
  const mon = dash.week, days = [...Array(7)].map((_, i) => shiftDay(mon, i));
  const recs = days.map((k) => store.days[k] || { total: 0, correct: 0, words: {} });
  const total = recs.reduce((s, d) => s + d.total, 0), correct = recs.reduce((s, d) => s + d.correct, 0);
  const max = Math.max(1, ...recs.map((d) => d.total));
  const agg = {};
  recs.forEach((d) => Object.entries(d.words || {}).forEach(([id, v]) => {
    const a = agg[id] || (agg[id] = { c: 0, w: 0 }); a.c += v.c || 0; a.w += v.w || 0; }));
  const missed = Object.entries(agg).filter(([, v]) => v.w > 0).sort((a, b) => b[1].w - a[1].w).slice(0, 15);
  const thisWeek = mondayOf(dayKey()) === mon;
  body.innerHTML = `
    <section class="card">
      ${navBar(`${fmtDay(mon, { month: 'short', day: 'numeric' })} – ${fmtDay(days[6], { month: 'short', day: 'numeric', year: 'numeric' })}`, 'wPrev', 'wNext', 'wToday', !thisWeek)}
      ${statCards([['Questions', total], ['Correct', correct], ['Score', pct(correct, total)], ['Days practiced', recs.filter((d) => d.total).length], ['Different words', Object.keys(agg).length]])}
      <div class="bars">${days.map((k, i) => { const d = recs[i]; return `
        <button class="barcol" data-day="${k}">
          <div class="barwrap"><div class="bar" style="height:${(100 * d.total) / max}%"><div class="barok" style="height:${d.total ? (100 * d.correct) / d.total : 0}%"></div></div></div>
          <b>${d.total || ''}</b><small>${fmtDay(k, { weekday: 'short' })}</small></button>`; }).join('')}</div>
      <p class="small muted center">Bar = questions · green = correct · tap a day for details</p>
    </section>
    <section class="card"><h3>Most missed this week</h3>
      ${missed.length ? `<table class="plain"><tr><th>Word</th><th>❌</th><th>⭕</th></tr>${missed.map(([id, v]) => `<tr><td><b>${esc(byId.get(+id)?.word)}</b></td><td>${v.w}</td><td>${v.c}</td></tr>`).join('')}</table>` : '<p class="muted small">No misses this week. 🎉</p>'}
    </section>`;
  document.getElementById('wPrev').onclick = () => { dash.week = shiftDay(mon, -7); renderWeekly(); };
  document.getElementById('wNext').onclick = () => { dash.week = shiftDay(mon, 7); renderWeekly(); };
  document.getElementById('wToday').onclick = () => { dash.week = mondayOf(dayKey()); renderWeekly(); };
  body.querySelectorAll('[data-day]').forEach((b) => b.onclick = () => { dash.day = b.dataset.day; renderDashboard('daily'); });
}

// Word × day table. Header row + word column + total column + total row stay fixed while scrolling.
function renderGrid() {
  const body = document.getElementById('dashBody');
  const dayKeys = Object.keys(store.days).filter((k) => store.days[k].total).sort();
  const practiced = new Set(dayKeys.flatMap((k) => Object.keys(store.days[k].words || {}).map(Number)));
  const words = WORDS.filter((w) => (dash.gridLevel === 'All' || w.level === dash.gridLevel)
    && (!dash.gridOnly || practiced.has(w.id)));
  const cell = (v) => {
    if (!v || !(v.c + v.w)) return '<td class="empty"></td>';
    const cls = v.w === 0 ? 'ok' : v.c === 0 ? 'bad' : 'mix';
    return `<td class="${cls}">${v.c}/${v.c + v.w}</td>`;
  };
  const colTot = dayKeys.map(() => ({ c: 0, w: 0 })), grand = { c: 0, w: 0 };
  const rows = words.map((w) => {
    const tot = { c: 0, w: 0 };
    const tds = dayKeys.map((k, i) => {
      const v = store.days[k].words?.[w.id];
      if (v) { tot.c += v.c || 0; tot.w += v.w || 0; colTot[i].c += v.c || 0; colTot[i].w += v.w || 0; }
      return cell(v && { c: v.c || 0, w: v.w || 0 });
    }).join('');
    grand.c += tot.c; grand.w += tot.w;
    const st = status(w);
    return `<tr><th class="wcol">${st === 'focus' ? '🔥 ' : st === 'learned' ? '🎓 ' : ''}${esc(w.word)}</th>${tds}
      <td class="tcol">${tot.c + tot.w ? `${tot.c}/${tot.c + tot.w}` : ''}</td></tr>`;
  }).join('');
  body.innerHTML = `
    <section class="card">
      <div class="gridtools">
        <select id="gLevel">${['All', ...LEVELS].map((l) => `<option ${l === dash.gridLevel ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label><input type="checkbox" id="gOnly" ${dash.gridOnly ? 'checked' : ''}> Practiced words only</label>
      </div>
      <p class="small muted">Each cell = correct / asked. 🔥 focus · 🎓 learned · ${words.length} words</p>
      ${dayKeys.length ? `
      <div class="gridwrap"><table class="grid">
        <thead><tr><th class="wcol corner">Word</th>${dayKeys.map((k) => `<th>${fmtDay(k, { month: 'numeric', day: 'numeric' })}</th>`).join('')}<th class="tcol corner">Total</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th class="wcol corner">Total</th>${colTot.map((t) => `<td>${t.c + t.w ? `${t.c}/${t.c + t.w}` : ''}</td>`).join('')}
          <td class="tcol corner">${grand.c}/${grand.c + grand.w}<br><small>${pct(grand.c, grand.c + grand.w)}</small></td></tr></tfoot>
      </table></div>` : '<p class="muted">No practice yet.</p>'}
    </section>`;
  document.getElementById('gLevel').onchange = (e) => { dash.gridLevel = e.target.value; renderGrid(); };
  document.getElementById('gOnly').onchange = (e) => { dash.gridOnly = e.target.checked; renderGrid(); };
}

// ───────────────────────── settings ─────────────────────────
function renderSettings() {
  leaveQuiz(); $home.hidden = false;
  const voices = ('speechSynthesis' in window) ? speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('en')) : [];
  const slider = (id, label, min, max, step, val) => `
    <label>${label} <b id="${id}V">${val}</b><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"></label>`;
  $app.innerHTML = `
    <section class="card form">
      <h2>⚙️ Settings <small class="muted">(this device)</small></h2>
      ${slider('wordRate', 'Word speed', 0.4, 1.0, 0.05, settings.wordRate)}
      ${slider('pauseMs', 'Pause after “Spell” (ms)', 200, 2000, 100, settings.pauseMs)}
      ${slider('spellVolume', '“Spell” volume', 0.2, 1.0, 0.05, settings.spellVolume)}
      ${slider('talkRate', 'Meaning & sentence speed', 0.4, 1.0, 0.05, settings.talkRate)}
      <label>Voice
        <select id="voiceSel"><option value="">Automatic (US English)</option>
          ${voices.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === settings.voiceURI ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('')}
        </select></label>
      <div class="row">
        <button class="mid" id="testVoice">🔊 Test voice</button>
        ${canListen ? '<button class="mid" id="testMic">🎤 Test mic</button>' : ''}
      </div>
      <div class="raw" id="micTestOut"></div>
      <label>“Slow start” counts as hard after (seconds)
        <input type="number" id="think" min="3" max="60" value="${settings.thinkSeconds}"></label>
      <label>Correct answers needed to leave Focus words
        <input type="number" id="grad" min="1" max="10" value="${settings.graduateAfter}"></label>
    </section>
    <section class="card form">
      <h2>App</h2>
      <p class="small muted">Sync: ${store.mode === 'cloud' ? '☁️ Google Cloud (Firebase) — ' + esc(store.user?.email || '') : '📱 This device only (Firebase not set up)'}</p>
      <div class="row">
        ${store.mode === 'cloud' ? '<button class="mid" id="logout">Sign out</button>' : ''}
        <button class="mid" id="refresh">🔄 Update app</button>
      </div>
      <p class="small muted">“Update app” reloads the newest version. Practice records are not deleted.</p>
      ${versionHTML()}
    </section>`;
  ['wordRate', 'pauseMs', 'spellVolume', 'talkRate'].forEach((id) => {
    const el = document.getElementById(id);
    el.oninput = () => { settings[id] = +el.value; document.getElementById(id + 'V').textContent = el.value; saveSettings(); };
  });
  document.getElementById('voiceSel').onchange = (e) => { settings.voiceURI = e.target.value; saveSettings(); pickVoice(); };
  document.getElementById('testVoice').onclick = () => askWord('funny');
  const tm = document.getElementById('testMic');
  if (tm) tm.onclick = () => {
    const out = document.getElementById('micTestOut');
    const r = new SR(); r.lang = 'en-US'; r.continuous = true; r.interimResults = true;
    const log = []; const show = (m) => { log.push(m); out.textContent = log.join(' → '); };
    r.onstart = () => show('mic on: say “B, E, A, C, H”');
    r.onspeechstart = () => show('voice detected');
    r.onresult = (e) => { let t = ''; for (let i = 0; i < e.results.length; i++) t += ' ' + e.results[i][0].transcript;
      out.textContent = log.join(' → ') + ' → heard: “' + t.trim() + '” = ' + (parseTranscript(t, 'beach').display || '(no letters)'); };
    r.onerror = (e) => show('error: ' + e.error);
    r.onend = () => show('mic off');
    try { r.start(); setTimeout(() => { try { r.stop(); } catch {} }, 7000); } catch (x) { show('could not start: ' + x.message); }
  };
  document.getElementById('think').onchange = (e) => { settings.thinkSeconds = Math.max(3, +e.target.value || 8); saveSettings(); };
  document.getElementById('grad').onchange = (e) => { settings.graduateAfter = Math.max(1, +e.target.value || 2); saveSettings(); };
  const lo = document.getElementById('logout'); if (lo) lo.onclick = () => store.logout();
  document.getElementById('refresh').onclick = hardRefresh;
  fillVersion();
}

// ───────────────────────── login ─────────────────────────
function renderLogin(err = '') {
  $home.hidden = true;
  $app.innerHTML = `
    <section class="card form">
      <h2>Sign in</h2>
      <p class="small muted">Use the same account on every iPhone/iPad to share the same records.</p>
      <form id="loginForm">
        <input name="email" type="email" placeholder="email" autocomplete="username" required>
        <input name="pw" type="password" placeholder="password" autocomplete="current-password" required>
        <button class="big primary">Sign in</button>
      </form>
      ${err ? `<p class="warnmsg">${esc(err)}</p>` : ''}
    </section>
    <section class="card center">
      <button class="mid" id="refresh">🔄 Update app (full refresh)</button>
      <p class="small muted">Use this if a new version doesn’t show up. Practice records are not deleted.</p>
      ${versionHTML()}
    </section>`;
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await store.login(f.email.value.trim(), f.pw.value); afterReady(); }
    catch (x) { renderLogin('Sign-in failed: ' + (x.code || x.message)); }
  };
  document.getElementById('refresh').onclick = hardRefresh;
  fillVersion();
}

// ───────────────────────── boot ─────────────────────────
function afterReady() {
  document.getElementById('syncBadge').textContent = store.mode === 'cloud' ? '☁️ synced' : '📱 this device';
  renderHome();
}
$home.onclick = () => { leaveQuiz(); renderHome(); };
store.onChange(() => {
  // refresh the home screen when another device changes data (never interrupt a question)
  if ($app.querySelector('.levels')) renderHome();
});

(async function boot() {
  try {
    const data = await fetch('words.json').then((r) => r.json());
    WORDS = data.words; WORDS.forEach((w) => byId.set(w.id, w));
    const state = await store.init();
    if (state === 'need-login') renderLogin(); else afterReady();
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<p class="warnmsg">Could not start: ${esc(e.message)}</p>
      <button class="mid" onclick="location.replace(location.pathname + '?v=' + Date.now())">🔄 Reload</button>`;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
