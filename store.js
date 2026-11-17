// store.js — saves progress. Uses Firebase (Firestore) when configured, otherwise this device only.
// Data layout in Firestore:
//   users/{uid}/progress/{wordId}   one document per word (counts, focus/learned state)
//   users/{uid}/attempts/{autoId}   one document per answer (full history)
//   users/{uid}/days/{YYYY-MM-DD}   one document per day: totals + per-word correct/wrong counts
//   users/{uid}/meta/state          bookkeeping (e.g. daily records built from older history)
import { firebaseConfig } from './config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const LS_PROGRESS = 'sb_progress_v1';
const LS_ATTEMPTS = 'sb_attempts_v1';
const LS_DAYS = 'sb_days_v1';

// Local calendar day, e.g. "2026-11-17"
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addToDay(days, a) {
  const k = dayKey(a.at);
  const d = days[k] || (days[k] = { date: k, total: 0, correct: 0, words: {} });
  const ok = a.result === 'correct';
  d.total += 1; d.correct += ok ? 1 : 0;
  const w = d.words[a.id] || (d.words[a.id] = { c: 0, w: 0 });
  if (ok) w.c += 1; else w.w += 1;
}
export function buildDays(attempts) { const days = {}; attempts.forEach((a) => addToDay(days, a)); return days; }

export const store = {
  mode: firebaseConfig ? 'cloud' : 'local',
  progress: {},            // wordId -> record
  days: {},                // 'YYYY-MM-DD' -> { date, total, correct, words: { wordId: {c, w} } }
  user: null,
  _fb: null,
  _listeners: new Set(),

  onChange(fn) { this._listeners.add(fn); },
  _emit() { this._listeners.forEach((fn) => fn()); },

  _localAttempts() { try { return JSON.parse(localStorage.getItem(LS_ATTEMPTS) || '[]'); } catch { return []; } },

  // Returns 'ready' or 'need-login'
  async init() {
    if (this.mode === 'local') {
      try { this.progress = JSON.parse(localStorage.getItem(LS_PROGRESS) || '{}'); } catch { this.progress = {}; }
      // daily records are always rebuilt from the saved answers, so they can never drift apart
      this.days = buildDays(this._localAttempts());
      localStorage.setItem(LS_DAYS, JSON.stringify(this.days));
      return 'ready';
    }
    const [appM, authM, fsM] = await Promise.all([
      import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js'),
    ]);
    const app = appM.initializeApp(firebaseConfig);
    const auth = authM.getAuth(app);
    let db;
    try { db = fsM.initializeFirestore(app, { localCache: fsM.persistentLocalCache() }); }
    catch { db = fsM.getFirestore(app); }
    this._fb = { auth, authM, db, fsM };
    const user = await new Promise((res) => { const un = authM.onAuthStateChanged(auth, (u) => { un(); res(u); }); });
    if (!user) return 'need-login';
    await this._startSync(user);
    return 'ready';
  },

  async login(email, password) {
    const { auth, authM } = this._fb;
    const cred = await authM.signInWithEmailAndPassword(auth, email, password);
    await this._startSync(cred.user);
  },

  async logout() {
    if (this.mode === 'cloud') await this._fb.authM.signOut(this._fb.auth);
    location.reload();
  },

  _col(...path) { const { db, fsM } = this._fb; return fsM.collection(db, 'users', this.user.uid, ...path); },
  _doc(...path) { const { db, fsM } = this._fb; return fsM.doc(db, 'users', this.user.uid, ...path); },

  _listen(col, target) {
    const { fsM } = this._fb;
    return new Promise((resolve) => {
      let first = true;
      fsM.onSnapshot(col, (snap) => {
        snap.docChanges().forEach((ch) => {
          if (ch.type === 'removed') delete target[ch.doc.id];
          else target[ch.doc.id] = ch.doc.data();
        });
        this._emit();
        if (first) { first = false; resolve(); }
      }, (err) => { console.error(err); if (first) { first = false; resolve(); } });
    });
  },

  async _startSync(user) {
    this.user = user;
    await Promise.all([this._listen(this._col('progress'), this.progress), this._listen(this._col('days'), this.days)]);
    await this._backfillDays();
  },

  // One time: build daily records from answers saved before daily records existed.
  async _backfillDays() {
    const { fsM } = this._fb;
    try {
      const meta = await fsM.getDoc(this._doc('meta', 'state'));
      if (meta.exists() && meta.data().daysV1) return;
      const snap = await fsM.getDocs(this._col('attempts'));
      const built = buildDays(snap.docs.map((d) => d.data()));
      await Promise.all(Object.values(built).map((d) => fsM.setDoc(this._doc('days', d.date), d)));
      await fsM.setDoc(this._doc('meta', 'state'), { daysV1: true, builtAt: Date.now() }, { merge: true });
    } catch (e) { console.error('backfill failed', e); }
  },

  get(id) { return this.progress[String(id)]; },

  async save(rec) {
    rec.updatedAt = Date.now();
    this.progress[String(rec.id)] = rec;
    if (this.mode === 'local') {
      localStorage.setItem(LS_PROGRESS, JSON.stringify(this.progress));
    } else {
      const { fsM } = this._fb;
      fsM.setDoc(this._doc('progress', String(rec.id)), rec).catch((e) => console.error('save failed', e));
    }
    this._emit();
  },

  async logAttempt(a) {
    a.at = Date.now();
    a.day = dayKey(a.at);
    // update the in-memory daily record right away (the cloud copy is updated with atomic increments)
    addToDay(this.days, a);
    if (this.mode === 'local') {
      const list = this._localAttempts();
      list.push(a);
      localStorage.setItem(LS_ATTEMPTS, JSON.stringify(list.slice(-20000)));
      localStorage.setItem(LS_DAYS, JSON.stringify(this.days));
    } else {
      const { fsM } = this._fb;
      const ok = a.result === 'correct';
      fsM.addDoc(this._col('attempts'), a).catch((e) => console.error('log failed', e));
      fsM.setDoc(this._doc('days', a.day), {
        date: a.day, total: fsM.increment(1), correct: fsM.increment(ok ? 1 : 0),
        words: { [a.id]: { c: fsM.increment(ok ? 1 : 0), w: fsM.increment(ok ? 0 : 1) } },
      }, { merge: true }).catch((e) => console.error('day failed', e));
    }
    this._emit();
  },

  // All answers between two timestamps (oldest first)
  async attemptsBetween(start, end) {
    if (this.mode === 'local') return this._localAttempts().filter((a) => a.at >= start && a.at < end);
    const { fsM } = this._fb;
    const q = fsM.query(this._col('attempts'), fsM.where('at', '>=', start), fsM.where('at', '<', end), fsM.orderBy('at'));
    const snap = await fsM.getDocs(q);
    return snap.docs.map((d) => d.data());
  },
};
