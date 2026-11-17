import { parseTranscript, isCorrect, spelledOut } from './grader.js';
import { store } from './store.js';

// ───────────────────────── settings (per device) ─────────────────────────
const DEFAULTS = { rate: 0.85, thinkSeconds: 8, graduateAfter: 3, voiceURI: '' };
const settings = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('sb_settings') || '{}'));
const saveSettings = () => localStorage.setItem('sb_settings', JSON.stringify(settings));

// ───────────────────────── helpers ─────────────────────────
const $app = document.getElementById('app');
const $home = document.getElementById('homeBtn');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function toast(msg) {
  const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2200);
}
const LEVELS = ['One Bee', 'Two Bee', 'Three Bee'];
let WORDS = [];
const byId = new Map();

function record(w) {
  return store.get(w.id) || { id: w.id, word: w.word, level: w.level, attempts: 0, correct: 0, wrong: 0,
    inNotebook: false, reviewStreak: 0, reasons: [], lastResult: null, lastAt: 0 };
}
const notebookWords = () => WORDS.filter((w) => store.get(w.id)?.inNotebook);

// ───────────────────────── speech: talking ─────────────────────────
let voice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
  voice = vs.find((v) => v.voiceURI === settings.voiceURI)
    || vs.find((v) => /en[-_]US/i.test(v.lang) && /samantha|ava|allison|google us/i.test(v.name))
    || vs.find((v) => /en[-_]US/i.test(v.lang)) || vs[0] || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
// iOS Safari notes:
//  - speech must first be started inside a tap; we "unlock" it on the very first touch.
//  - calling cancel() right before speak() can silently drop the new utterance, so only cancel when busy.
//  - the ring/silent switch mutes this voice, so we show a hint if nothing starts playing.
let ttsUnlocked = false;
function unlockTTS() {
  if (ttsUnlocked || !('speechSynthesis' in window)) return;
  ttsUnlocked = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}
document.addEventListener('touchend', unlockTTS, { once: true, capture: true });
document.addEventListener('click', unlockTTS, { once: true, capture: true });

function say(text) {
  return new Promise((res) => {
    if (!('speechSynthesis' in window)) { toast('This browser cannot speak. Use Safari.'); return res(); }
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    if (!voice) pickVoice();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'en-US';
    u.rate = settings.rate;
    u.volume = 1;
    let started = false;
    u.onstart = () => { started = true; };
    u.onend = () => { started = true; res(); };
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') toast('Speech error: ' + e.error); res(); };
    speechSynthesis.speak(u);
    if (speechSynthesis.paused) speechSynthesis.resume();
    setTimeout(() => {
      if (!started && !speechSynthesis.speaking) toast('No sound? Turn off Silent mode and turn the volume up.');
    }, 2500);
  });
}

// ───────────────────────── speech: listening ─────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const canListen = !!SR;

// ───────────────────────── screens ─────────────────────────
let currentLevel = localStorage.getItem('sb_level') || 'One Bee';

function renderHome() {
  $home.hidden = true;
  const nb = notebookWords().length;
  const lvlStats = LEVELS.map((l) => {
    const ws = WORDS.filter((w) => w.level === l);
    const seen = ws.filter((w) => store.get(w.id)?.attempts > 0).length;
    return { l, n: ws.length, seen };
  });
  $app.innerHTML = `
    <section class="card">
      <h2>Choose a level</h2>
      <div class="levels">
        ${[...lvlStats, { l: 'All', n: WORDS.length, seen: WORDS.filter((w) => store.get(w.id)?.attempts > 0).length }].map((s) => `
          <button class="level ${s.l === currentLevel ? 'on' : ''}" data-level="${s.l}">
            <b>${s.l}</b><small>${s.seen}/${s.n} tried</small>
          </button>`).join('')}
      </div>
      <button class="big primary" id="practiceBtn">▶ Practice</button>
      <button class="big ${nb ? 'warn' : ''}" id="reviewBtn" ${nb ? '' : 'disabled'}>📒 Review my notebook (${nb})</button>
    </section>
    <section class="row">
      <button class="mid" id="notebookBtn">📒 Notebook</button>
      <button class="mid" id="statsBtn">📊 Parent view</button>
      <button class="mid" id="settingsBtn">⚙️ Settings</button>
    </section>
    ${!canListen ? '<p class="note">This browser can’t listen to speech, so answers are typed. On iPhone/iPad, open in Safari.</p>' : ''}`;
  $app.querySelectorAll('.level').forEach((b) => b.onclick = () => {
    currentLevel = b.dataset.level; localStorage.setItem('sb_level', currentLevel); renderHome();
  });
  document.getElementById('practiceBtn').onclick = () => startQuiz('practice');
  document.getElementById('reviewBtn').onclick = () => startQuiz('review');
  document.getElementById('notebookBtn').onclick = renderNotebook;
  document.getElementById('statsBtn').onclick = renderStats;
  document.getElementById('settingsBtn').onclick = renderSettings;
}

// ───────────────────────── quiz ─────────────────────────
let quiz = null;

function pickNext() {
  if (quiz.mode === 'review') {
    const inNb = (w) => store.get(w.id)?.inNotebook;
    quiz.queue = quiz.queue.filter(inNb);             // drop words that just graduated
    if (!quiz.queue.length) quiz.queue = shuffle(notebookWords().filter((w) => w.id !== quiz.word?.id));
    if (!quiz.queue.length) quiz.queue = notebookWords();
    return quiz.queue.shift() || null;
  }
  // practice: words never tried first, then words missed more often, never repeating within a session
  const pool = WORDS.filter((w) => (currentLevel === 'All' || w.level === currentLevel) && !quiz.asked.has(w.id));
  if (!pool.length) { quiz.asked.clear(); return pickNext(); }
  const fresh = pool.filter((w) => !(store.get(w.id)?.attempts > 0));
  if (fresh.length) return fresh[Math.floor(Math.random() * fresh.length)];
  const weighted = pool.flatMap((w) => Array(1 + 2 * (store.get(w.id)?.wrong || 0)).fill(w));
  return weighted[Math.floor(Math.random() * weighted.length)];
}

function startQuiz(mode) {
  quiz = { mode, asked: new Set(), queue: [], count: 0, right: 0, word: null };
  nextQuestion();
}

function nextQuestion() {
  stopListening();
  const w = pickNext();
  if (!w) { toast('Notebook is empty — great job! 🎉'); return renderHome(); }
  quiz.word = w; quiz.asked.add(w.id); quiz.count++;
  quiz.q = { replays: 0, startedAt: 0, answeredAt: 0, transcript: '', parsed: null, result: null,
    override: null, hard: false, method: null };
  renderQuestion();
  say(`Spell ${w.word}`).then(() => { quiz.q.startedAt = Date.now(); });
  quiz.q.startedAt = Date.now();
}

function renderQuestion() {
  $home.hidden = false;
  const w = quiz.word, q = quiz.q;
  $app.innerHTML = `
    <div class="quizhead">
      <span>${quiz.mode === 'review' ? '📒 Review' : '▶ ' + esc(currentLevel)}</span>
      <span>#${quiz.count} · ✅ ${quiz.right}</span>
    </div>
    <section class="card center">
      <button class="hear" id="hearBtn">🔊 Hear the word</button>
      <p class="muted small">Say the word, spell it letter by letter, then say the word again.</p>
      <div id="answerArea"></div>
    </section>`;
  document.getElementById('hearBtn').onclick = () => { q.replays++; say(w.word); };
  renderAnswerArea();
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
  speechSynthesis?.cancel?.();
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
      // If the child tapped Done and we got clean letters, check right away.
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
  q.thinkSec = Math.round((q.answeredAt - q.startedAt) / 100) / 10;
  if (q.result === 'correct') say('Correct!'); else say('Not quite.');
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
  area.innerHTML = `
    <div class="verdict ${res}">${res === 'correct' ? '⭕ Correct!' : '❌ Not quite'}</div>
    <div class="answer">
      <div><small>Word</small><b>${esc(w.word)}</b></div>
      <div><small>Spelling</small><b class="spell">${esc(spelledOut(w.accepted_spellings[0]))}</b></div>
      ${w.accepted_spellings.length > 1 ? `<div><small>Also OK</small><b>${w.accepted_spellings.slice(1).map(esc).join(', ')}</b></div>` : ''}
      <div><small>You said</small><b class="spell ${res}">${esc(spelledOut(q.answer.toLowerCase()))}</b></div>
    </div>
    ${reasons.length ? `<p class="small muted">📒 Goes to notebook: ${esc(reasons.join(', '))}</p>` : ''}
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
  document.getElementById('hardBtn').onclick = () => { q.hard = !q.hard; renderAnswerArea(); };
  document.getElementById('nextBtn').onclick = () => { commit(); nextQuestion(); };
  area.querySelectorAll('[data-ov]').forEach((b) => b.onclick = () => { q.override = b.dataset.ov || null; renderAnswerArea(); });
}

// Save the finished question to storage (called on Next / Home).
function commit() {
  const q = quiz?.q; if (!q || !q.result || q.committed) return;
  q.committed = true;
  const w = quiz.word, r = record(w), res = finalResult(q), reasons = hardReasons(q);
  r.attempts++; r.lastAt = Date.now(); r.lastResult = res;
  if (res === 'correct') { r.correct++; quiz.right++; } else r.wrong++;
  if (reasons.length) {
    r.inNotebook = true; r.reviewStreak = 0;
    r.reasons = [...new Set([...(r.reasons || []), ...reasons.map((x) => x.replace(/\s*\(.*\)|\s\d+x$/, ''))])];
  } else if (r.inNotebook) {
    r.reviewStreak = (r.reviewStreak || 0) + 1;
    if (r.reviewStreak >= settings.graduateAfter) { r.inNotebook = false; r.reasons = []; toast(`🎓 “${w.word}” graduated from the notebook!`); }
  }
  store.save(r);
  store.logAttempt({ id: w.id, word: w.word, level: w.level, mode: quiz.mode, result: res, answer: q.answer,
    method: q.method, override: q.override || null, replays: q.replays, thinkSec: q.thinkSec, hard: q.hard, transcript: q.transcript || '' });
}

// ───────────────────────── notebook ─────────────────────────
function renderNotebook() {
  commit(); stopListening(); $home.hidden = false;
  const list = notebookWords().map((w) => ({ w, r: store.get(w.id) }))
    .sort((a, b) => (b.r.wrong - a.r.wrong) || (b.r.lastAt - a.r.lastAt));
  $app.innerHTML = `
    <section class="card">
      <h2>📒 My notebook (${list.length})</h2>
      <p class="small muted">Get a word right ${settings.graduateAfter} times in a row (without it being hard) to graduate it.</p>
      ${list.length ? `<button class="big warn" id="reviewNow">Review these words</button>` : '<p>Empty! 🎉</p>'}
      <ul class="wordlist">
        ${list.map(({ w, r }) => `
          <li>
            <button class="speak" data-say="${esc(w.word)}">🔊</button>
            <div class="grow"><b>${esc(w.word)}</b> <small class="muted">${esc(w.level)}</small><br>
              <small>✅ ${r.correct} · ❌ ${r.wrong} · streak ${r.reviewStreak || 0}/${settings.graduateAfter}${r.reasons?.length ? ' · ' + esc(r.reasons.join(', ')) : ''}</small></div>
            <button class="small" data-remove="${w.id}">Remove</button>
          </li>`).join('')}
      </ul>
    </section>`;
  const rv = document.getElementById('reviewNow'); if (rv) rv.onclick = () => startQuiz('review');
  $app.querySelectorAll('[data-say]').forEach((b) => b.onclick = () => say(b.dataset.say));
  $app.querySelectorAll('[data-remove]').forEach((b) => b.onclick = () => {
    const r = store.get(b.dataset.remove); r.inNotebook = false; r.reviewStreak = 0; r.reasons = []; store.save(r); renderNotebook();
  });
}

// ───────────────────────── parent view ─────────────────────────
async function renderStats() {
  commit(); stopListening(); $home.hidden = false;
  const rows = [...LEVELS, 'All'].map((l) => {
    const ws = WORDS.filter((w) => l === 'All' || w.level === l);
    const rs = ws.map((w) => store.get(w.id)).filter(Boolean);
    const tried = rs.filter((r) => r.attempts > 0).length;
    const c = rs.reduce((s, r) => s + r.correct, 0), a = rs.reduce((s, r) => s + r.attempts, 0);
    const mastered = rs.filter((r) => r.lastResult === 'correct' && !r.inNotebook).length;
    return `<tr><td>${l}</td><td>${tried}/${ws.length}</td><td>${a ? Math.round((100 * c) / a) + '%' : '–'}</td><td>${mastered}</td><td>${rs.filter((r) => r.inNotebook).length}</td></tr>`;
  }).join('');
  $app.innerHTML = `
    <section class="card">
      <h2>📊 Parent view</h2>
      <table class="stats"><tr><th>Level</th><th>Tried</th><th>Accuracy</th><th>Last correct</th><th>Notebook</th></tr>${rows}</table>
      <h3>Recent answers</h3><div id="recent" class="muted small">Loading…</div>
    </section>`;
  try {
    const list = await store.recentAttempts(40);
    document.getElementById('recent').innerHTML = list.length ? `<ul class="recent">${list.map((a) => `
      <li>${a.result === 'correct' ? '⭕' : '❌'} <b>${esc(a.word)}</b>
        ${a.result !== 'correct' ? `→ <span class="wrongtxt">${esc(a.answer || '')}</span>` : ''}
        <small class="muted">${new Date(a.at).toLocaleString()} · ${a.method}${a.override ? ' · fixed by parent' : ''}${a.replays ? ' · 🔊' + a.replays : ''} · ${a.thinkSec}s</small></li>`).join('')}</ul>` : 'No answers yet.';
  } catch (e) { document.getElementById('recent').textContent = 'Could not load history.'; }
}

// ───────────────────────── settings ─────────────────────────
function renderSettings() {
  commit(); stopListening(); $home.hidden = false;
  const voices = ('speechSynthesis' in window) ? speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('en')) : [];
  $app.innerHTML = `
    <section class="card form">
      <h2>⚙️ Settings <small class="muted">(this device)</small></h2>
      <label>Speaking speed <b id="rateV">${settings.rate}</b>
        <input type="range" id="rate" min="0.5" max="1.1" step="0.05" value="${settings.rate}"></label>
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
      <label>Correct in a row to graduate from notebook
        <input type="number" id="grad" min="1" max="10" value="${settings.graduateAfter}"></label>
      <p class="small muted">Sync: ${store.mode === 'cloud' ? '☁️ Google Cloud (Firebase) — ' + esc(store.user?.email || '') : '📱 This device only (Firebase not set up)'}</p>
      ${store.mode === 'cloud' ? '<button class="small" id="logout">Sign out</button>' : ''}
    </section>`;
  const rate = document.getElementById('rate');
  rate.oninput = () => { settings.rate = +rate.value; document.getElementById('rateV').textContent = rate.value; saveSettings(); };
  document.getElementById('voiceSel').onchange = (e) => { settings.voiceURI = e.target.value; saveSettings(); pickVoice(); };
  document.getElementById('testVoice').onclick = () => say('Spell rendezvous');
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
  document.getElementById('grad').onchange = (e) => { settings.graduateAfter = Math.max(1, +e.target.value || 3); saveSettings(); };
  const lo = document.getElementById('logout'); if (lo) lo.onclick = () => store.logout();
}

// ───────────────────────── login ─────────────────────────
function renderLogin(err = '') {
  $home.hidden = true;
  $app.innerHTML = `
    <section class="card form">
      <h2>Sign in</h2>
      <p class="small muted">Use the family account so every iPhone/iPad shares the same notebook.</p>
      <form id="loginForm">
        <input name="email" type="email" placeholder="email" autocomplete="username" required>
        <input name="pw" type="password" placeholder="password" autocomplete="current-password" required>
        <button class="big primary">Sign in</button>
      </form>
      ${err ? `<p class="warnmsg">${esc(err)}</p>` : ''}
    </section>`;
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await store.login(f.email.value.trim(), f.pw.value); afterReady(); }
    catch (x) { renderLogin('Sign-in failed: ' + (x.code || x.message)); }
  };
}

// ───────────────────────── boot ─────────────────────────
function afterReady() {
  document.getElementById('syncBadge').textContent = store.mode === 'cloud' ? '☁️ synced' : '📱 this device';
  renderHome();
}
$home.onclick = () => { commit(); stopListening(); renderHome(); };
store.onChange(() => {
  // refresh list screens when another device changes data (never interrupt a question)
  if (!$app.querySelector('#answerArea') && $app.querySelector('.levels')) renderHome();
});

(async function boot() {
  try {
    const data = await fetch('words.json').then((r) => r.json());
    WORDS = data.words; WORDS.forEach((w) => byId.set(w.id, w));
    const state = await store.init();
    if (state === 'need-login') renderLogin(); else afterReady();
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<p class="warnmsg">Could not start: ${esc(e.message)}</p>`;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
