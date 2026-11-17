// store.js — saves progress. Uses Firebase (Firestore) when configured, otherwise this device only.
// Data layout in Firestore:
//   users/{uid}/progress/{wordId}   one document per word (counts, notebook state)
//   users/{uid}/attempts/{autoId}   one document per answer (history log)
import { firebaseConfig } from './config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const LS_PROGRESS = 'sb_progress_v1';
const LS_ATTEMPTS = 'sb_attempts_v1';

export const store = {
  mode: firebaseConfig ? 'cloud' : 'local',
  progress: {},            // wordId -> record
  user: null,
  _fb: null,
  _listeners: new Set(),

  onChange(fn) { this._listeners.add(fn); },
  _emit() { this._listeners.forEach((fn) => fn()); },

  // Returns 'ready' or 'need-login'
  async init() {
    if (this.mode === 'local') {
      try { this.progress = JSON.parse(localStorage.getItem(LS_PROGRESS) || '{}'); } catch { this.progress = {}; }
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

  async _startSync(user) {
    this.user = user;
    const { db, fsM } = this._fb;
    const col = fsM.collection(db, 'users', user.uid, 'progress');
    await new Promise((resolve) => {
      let first = true;
      fsM.onSnapshot(col, (snap) => {
        snap.docChanges().forEach((ch) => {
          if (ch.type === 'removed') delete this.progress[ch.doc.id];
          else this.progress[ch.doc.id] = ch.doc.data();
        });
        this._emit();
        if (first) { first = false; resolve(); }
      }, (err) => { console.error(err); if (first) { first = false; resolve(); } });
    });
  },

  get(id) { return this.progress[String(id)]; },

  async save(rec) {
    rec.updatedAt = Date.now();
    this.progress[String(rec.id)] = rec;
    if (this.mode === 'local') {
      localStorage.setItem(LS_PROGRESS, JSON.stringify(this.progress));
    } else {
      const { db, fsM } = this._fb;
      fsM.setDoc(fsM.doc(db, 'users', this.user.uid, 'progress', String(rec.id)), rec)
        .catch((e) => console.error('save failed', e));
    }
    this._emit();
  },

  async logAttempt(a) {
    a.at = Date.now();
    if (this.mode === 'local') {
      let list = [];
      try { list = JSON.parse(localStorage.getItem(LS_ATTEMPTS) || '[]'); } catch {}
      list.push(a);
      localStorage.setItem(LS_ATTEMPTS, JSON.stringify(list.slice(-3000)));
    } else {
      const { db, fsM } = this._fb;
      fsM.addDoc(fsM.collection(db, 'users', this.user.uid, 'attempts'), a)
        .catch((e) => console.error('log failed', e));
    }
  },

  async recentAttempts(n = 40) {
    if (this.mode === 'local') {
      let list = [];
      try { list = JSON.parse(localStorage.getItem(LS_ATTEMPTS) || '[]'); } catch {}
      return list.slice(-n).reverse();
    }
    const { db, fsM } = this._fb;
    const q = fsM.query(fsM.collection(db, 'users', this.user.uid, 'attempts'), fsM.orderBy('at', 'desc'), fsM.limit(n));
    const snap = await fsM.getDocs(q);
    return snap.docs.map((d) => d.data());
  },
};
