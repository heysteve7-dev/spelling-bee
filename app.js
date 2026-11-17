import { parseTranscript, isCorrect, spelledOut } from './grader.js';
import { store, dayKey } from './store.js';

export const APP_VERSION = '1.3.0';

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
const focusWords = () => WORDS.filter((w) => status(w) === 'focus');

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
  stopListening(); $home.hidden = true;
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
    <section class="row">
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
  document.getElementById('dashBtn').onclick = () => renderDashboard('daily');
  document.getElementById('settingsBtn').onclick = renderSettings;
  const lo = document.getElementById('logoutBtn'); if (lo) lo.onclick = () => store.logout();
  fillVersion();
}

// ───────────────────────── quiz ─────────────────────────
let quiz = null;

// Practice: focus words come back often (about 4 in 10 questions) until answered correctly enough;
// new words come next; then other words, with "learned" words asked least.
function pickNext() {
  const recent = quiz.recent.slice(-4);
  if (quiz.mode === 'review') {
    let pool = focusWords().filter((w) => !recent.includes(w.id));
    if (!pool.length) pool = focusWords();
    return pool.length ? pick(pool) : null;
  }
  const inLevel = (w) => currentLevel === 'All' || w.level === currentLevel;
  const all = WORDS.filter(inLevel);
  const focus = all.filter((w) => status(w) === 'focus' && !recent.includes(w.id));
  if (focus.length && Math.random() < 0.4) return pick(focus);
  const fresh = all.filter((w) => status(w) === 'new' && !quiz.asked.has(w.id));
  if (fresh.length) return pick(fresh);
  const weight = { focus: 6, solid: 2, learned: 1 };
  let pool = all.filter((w) => !quiz.asked.has(w.id) && !recent.includes(w.id));
  if (!pool.length) { quiz.asked.clear(); pool = all.filter((w) => !recent.includes(w.id)); }
  const bag = pool.flatMap((w) => Array(weight[status(w)] || 1).fill(w));
  return bag.length ? pick(bag) : pick(all);
}

function startQuiz(mode) {
  quiz = { mode, asked: new Set(), recent: [], count: 0, right: 0, word: null };
  nextQuestion();
}

function nextQuestion() {
  stopListening();
  const w = pickNext();
  if (!w) { toast('No focus words left — great job! 🎉'); return renderHome(); }
  quiz.word = w; quiz.asked.add(w.id); quiz.recent.push(w.id); quiz.count++;
  quiz.q = { showText: false, replays: 0, startedAt: Date.now(), answeredAt: 0, transcript: '', parsed: null, result: null,
    override: null, hard: false, method: null };
  renderQuestion();
  askWord(w.word).then(() => { if (quiz?.word === w && !quiz.q.answeredAt) quiz.q.startedAt = Date.now(); });
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
      <span>#${quiz.count} · ✅ ${quiz.right}</span>
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
  area.innerHTML = `
    ${canListen ? `
      <button class="mic ${listening ? 'live' : ''}" id="micBtn">${listening ? '⏹ Done' : '🎤 Tap and spell'}</button>
      <div class="heard" id="heard">${q.parsed ? esc(q.parsed.display || '…') : (listening ? 'Listening…' : '&nbsp;')}</div>
      <div class="raw" id="micStatus">${listening ? esc(q.micStatus || '⏳ starting mic…') : (q.micStatus && q.micStatus.startsWith('⚠️') ? esc(q.micStatus) : '')}</div>
      <div class="raw" id="rawHeard">${q.transcript ? 'raw: “' + esc(q.transcript) + '”' : ''}</div>
      ${q.parsed && !listening ? `
        ${q.parsed.wholeWord ? `<p class="warnmsg">I heard a whole word (“${esc(q.parsed.unknown.join(' '))}”), not letters.<br>Please spell it letter by letter.</p>` : ''}
        ${!q.parsed.wholeWord && q.parsed.unknown.length ? `<p class="warnmsg">I didn’t understand: “${esc(q.parsed.unknown.join(' '))}”. Say it again, or check anyway.</p>` : ''}
        <div class="row">
          <button class="mid" id="againBtn">🔁 Say it again</button>
          ${q.parsed.letters && !q.parsed.wholeWord ? '<button class="mid primary" id="checkBtn">✓ Check</button>' : ''}
        </div>` : ''}
      <details class="typebox"><summary>⌨️ Type instead</summary>${typeForm()}</details>
    ` : typeForm()}`;
  const mic = document.getElementById('micBtn');
  if (mic) mic.onclick = () => (listening ? stopListening(true) : startListening());
  const again = document.getElementById('againBtn');
  if (again) again.onclick = () => { q.transcript = ''; q.parsed = null; startListening(); };
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

let rec = null, listening = false, userStopped = false;
function startListening() {
  const q = quiz.q;
  if (!q.answeredAt) q.answeredAt = Date.now();
  stopSpeaking();
  rec = new SR();
  rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  const base = q.transcript;   // keep what was said before a pause
  userStopped = false;
  const status = (msg) => { q.micStatus = msg; const el = document.getElementById('micStatus'); if (el) el.textContent = msg; };
  rec.onstart = () => status('🎙️ mic on — start spelling');
  rec.onaudiostart = () => status('🎙️ hearing audio…');
  rec.onspeechstart = () => status('🗣️ hearing your voice…');
  rec.onresult = (e) => {
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
    q.transcript = (base + ' ' + parts.join(' ')).trim();
    q.parsed = parseTranscript(q.transcript, quiz.word.word);
    const h = document.getElementById('heard'); if (h) h.textContent = q.parsed.display || '…';
    const raw = document.getElementById('rawHeard'); if (raw) raw.textContent = 'raw: “' + q.transcript + '”';
    status('🗣️ got it — tap Done when finished');
  };
  rec.onerror = (e) => {
    status('⚠️ mic error: ' + e.error);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Mic or Siri & Dictation is off. See the setup tips.');
    else if (e.error === 'no-speech') toast('I didn’t hear anything. Speak a little louder and closer.');
    else if (e.error !== 'aborted') toast('Mic error: ' + e.error);
  };
  rec.onend = () => {
    listening = false; rec = null;
    if (quiz?.q === q) {
      if (q.transcript) q.parsed = parseTranscript(q.transcript, quiz.word.word);
      if (userStopped && q.parsed?.letters && !q.parsed.wholeWord && !q.parsed.unknown.length) return grade(q.parsed.letters, 'voice');
      renderAnswerArea();
    }
  };
  try { rec.start(); listening = true; } catch (err) { toast('Could not start the mic'); }
  renderAnswerArea();
}
function stopListening(byUser = false) {
  if (rec) { userStopped = byUser; try { rec.stop(); } catch {} }
}

function grade(answer, method) {
  const q = quiz.q, w = quiz.word;
  stopListening();
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
  document.getElementById('nextBtn').onclick = () => { commit(); nextQuestion(); };
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
    method: q.method, override: q.override || null, replays: q.replays, thinkSec: q.thinkSec ?? null, hard: q.hard, transcript: q.transcript || '' });
}

function leaveQuiz() { commit(); stopListening(); stopSpeaking(); }

// ───────────────────────── focus words ─────────────────────────
function renderFocus() {
  leaveQuiz(); $home.hidden = false;
  const row = (w, extra) => { const r = store.get(w.id); return `
    <li>
      <button class="speak" data-say="${esc(w.word)}">🔊</button>
      <div class="grow"><b>${esc(w.word)}</b> <small class="muted">${esc(w.level)}</small><br>
        <small>✅ ${r.correct} · ❌ ${r.wrong}${extra(r)}</small></div>
    </li>`; };
  const focus = focusWords().sort((a, b) => store.get(b.id).wrong - store.get(a.id).wrong);
  const learned = WORDS.filter((w) => status(w) === 'learned').sort((a, b) => store.get(b.id).lastAt - store.get(a.id).lastAt);
  $app.innerHTML = `
    <section class="card">
      <h2>🔥 Focus words (${focus.length})</h2>
      <p class="small muted">Words that were wrong or hard. They come up often until answered correctly ${settings.graduateAfter} times.</p>
      ${focus.length ? `<button class="big warn" id="reviewNow">Practice focus words</button>` : '<p>None right now! 🎉</p>'}
      <ul class="wordlist">${focus.map((w) => row(w, (r) => ` · correct ${r.reviewStreak || 0}/${settings.graduateAfter}${r.reasons?.length ? ' · ' + esc(r.reasons.join(', ')) : ''}`)).join('')}</ul>
    </section>
    <section class="card">
      <h2>🎓 Learned (${learned.length})</h2>
      <p class="small muted">Used to be focus words, now answered correctly. They come up less often.</p>
      <ul class="wordlist">${learned.map((w) => row(w, () => '')).join('')}</ul>
    </section>`;
  const rv = document.getElementById('reviewNow'); if (rv) rv.onclick = () => startQuiz('review');
  $app.querySelectorAll('[data-say]').forEach((b) => b.onclick = () => askWord(b.dataset.say));
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
