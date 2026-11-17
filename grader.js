// grader.js — turns what the speech recognizer heard into letters, and grades it.
// Works in the browser and in Node (for tests).

// Spoken letter names -> letter. Recognizers often return homophones ("sea" for C).
const LETTER_NAMES = {
  a: 'a', ay: 'a', eh: 'a', hey: 'a',
  b: 'b', bee: 'b', be: 'b', bea: 'b',
  c: 'c', see: 'c', sea: 'c', si: 'c', cee: 'c',
  d: 'd', dee: 'd', de: 'd',
  e: 'e', ee: 'e',
  f: 'f', ef: 'f', eff: 'f',
  g: 'g', gee: 'g', ji: 'g',
  h: 'h', aitch: 'h', haitch: 'h', ach: 'h', age: 'h',
  i: 'i', eye: 'i', aye: 'i',
  j: 'j', jay: 'j',
  k: 'k', kay: 'k', okay: 'k', cay: 'k',
  l: 'l', el: 'l', ell: 'l', elle: 'l',
  m: 'm', em: 'm',
  n: 'n', en: 'n',
  o: 'o', oh: 'o', owe: 'o',
  p: 'p', pee: 'p', pea: 'p',
  q: 'q', queue: 'q', cue: 'q', kew: 'q', kyu: 'q',
  r: 'r', are: 'r', ar: 'r', our: 'r',
  s: 's', es: 's', ess: 's',
  t: 't', tee: 't', tea: 't', ti: 't',
  u: 'u', you: 'u', yu: 'u', ewe: 'u',
  v: 'v', vee: 'v', vi: 'v',
  w: 'w',
  x: 'x', ex: 'x', ax: 'x',
  y: 'y', why: 'y', wye: 'y',
  z: 'z', zee: 'z', zed: 'z',
};
const SEPARATORS = { space: ' ', hyphen: '-', dash: '-' };

// Remove accents, case, and everything that is not a letter (spaces/hyphens are not graded).
export function lettersOnly(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

// Parse a speech transcript into a spelling.
// Returns { letters, display, unknown[], wholeWord }
//   wholeWord = true when the recognizer seems to have auto-corrected the answer into
//   a normal word instead of individual letters — such a result must NOT be graded.
export function parseTranscript(transcript, targetWord) {
  let t = transcript.toLowerCase()
    .replace(/[.,!?;:"]/g, ' ')
    .replace(/\bdouble[\s-]?(you|u|ewe)\b/g, ' w ')
    .replace(/\bcapital\b/g, ' ')
    .replace(/-/g, ' hyphen ');
  let tokens = t.split(/\s+/).filter(Boolean);

  // Spellers say the word before/after spelling it (Scripps style). Drop those.
  const targetTokens = targetWord.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[\s-]+/).filter(Boolean);
  const stripEdge = (fromStart) => {
    const n = targetTokens.length;
    const slice = fromStart ? tokens.slice(0, n) : tokens.slice(-n);
    const norm = (x) => x.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (n && tokens.length > n && slice.map(norm).join(' ') === targetTokens.join(' ')) {
      tokens = fromStart ? tokens.slice(n) : tokens.slice(0, -n);
      return true;
    }
    return false;
  };
  // only strip when the word is not itself a single letter name
  if (!(targetTokens.length === 1 && LETTER_NAMES[targetTokens[0]])) {
    stripEdge(true); stripEdge(false);
  }

  let letters = '', display = [], unknown = [];
  for (const tok of tokens) {
    if (LETTER_NAMES[tok]) { letters += LETTER_NAMES[tok]; display.push(LETTER_NAMES[tok].toUpperCase()); }
    else if (SEPARATORS[tok]) { display.push(tok === 'space' ? '␣' : '-'); }
    else if (/^[a-z]$/.test(tok)) { letters += tok; display.push(tok.toUpperCase()); }
    else unknown.push(tok);
  }
  // If the recognizer produced an ordinary multi-letter word (e.g. "beach"), we cannot
  // know which letters the child actually said.
  const wholeWord = unknown.some((u) => u.length > 1);
  return { letters, display: display.join(' '), unknown, wholeWord };
}

// Grade a letter string against an entry's accepted spellings.
export function isCorrect(answer, entry) {
  const a = lettersOnly(answer);
  return a.length > 0 && entry.accepted_spellings.some((s) => lettersOnly(s) === a);
}

// Pretty "B-E-A-C-H" form of the correct spelling(s) for feedback.
export function spelledOut(s) {
  return s.split('').map((c) => (c === ' ' ? '␣' : c.toUpperCase())).join(' ');
}
