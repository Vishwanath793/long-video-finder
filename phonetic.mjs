// Sound-alike keys: consonant skeletons shared by Devanagari and English spellings, so "रिलायंस" and "reliance"
// (or a caption's "suzzlon" and "suzlon") get the same key. Used by the rule-based calls and the watchlist helpers.
const DEV = {
  'क': 'k', 'ख': 'k', 'ग': 'g', 'घ': 'g', 'च': 'c', 'छ': 'c', 'ज': 'j', 'झ': 'j', 'ट': 't', 'ठ': 't', 'त': 't', 'थ': 't',
  'ड': 'd', 'ढ': 'd', 'द': 'd', 'ध': 'd', 'ण': 'n', 'न': 'n', 'ञ': 'n', 'ङ': 'n', 'ं': 'n', 'ँ': 'n', 'प': 'p', 'फ': 'f',
  'ब': 'b', 'भ': 'b', 'म': 'm', 'र': 'r', 'ल': 'l', 'ळ': 'l', 'व': 'v', 'श': 's', 'ष': 's', 'स': 's',
};
const collapse = s => s.replace(/(.)\1+/g, '$1');
export function skelDev(word) {
  let out = '';
  for (const ch of word.normalize('NFD').replace(/़/g, '')) out += DEV[ch] || '';
  return collapse(out);
}
export function skelEn(word) {
  const s = word.toLowerCase().replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f').replace(/ch/g, 'c').replace(/sh/g, 's').replace(/th/g, 't').replace(/kh/g, 'k')
    .replace(/gh/g, 'g').replace(/dh/g, 'd').replace(/bh/g, 'b').replace(/ck/g, 'k').replace(/x/g, 'ks')
    .replace(/q/g, 'k').replace(/z/g, 'j').replace(/w/g, 'v').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k');
  return collapse(s.replace(/[aeiouhy]/g, ''));
}
export const isDev = w => /[ऀ-ॿ]/.test(w);
// Captions mix scripts inside one word ("Vedanता" for Vedanta, "adानी" for Adani): key each script run and join.
export const skel = w => {
  const runs = w.match(/[ऀ-ॿ]+|[^ऀ-ॿ]+/g) || [];
  return runs.length > 1 ? runs.map(r => isDev(r) ? skelDev(r) : skelEn(r)).join('') : isDev(w) ? skelDev(w) : skelEn(w);
};

// Words too generic to identify a company on their own.
export const GENERIC = new Set(('bank india power finance financial capital steel energy motors motor infra infrastructure tech technologies technology ' +
  'global life gold market share shares stock new best good small max big first one star city general national international united ' +
  'industries limited ltd company corporation services service solutions systems system products product enterprises holdings ' +
  'investments investment securities trust fund insurance health healthcare pharma pharmaceuticals chemicals chemical cement ' +
  'textiles textile foods food agro green power paper sugar auto oil gas petro metals metal mining housing realty estate ' +
  'electric electricals engineering projects construction media entertainment communications networks digital data software ' +
  'logistics shipping airlines hotels resorts retail fashion jewellers consumer home building materials labs hospitals ' +
  'the and of for with at in on to from by bse nse ipo sip etf gdp rbi fii dii ceo us usa sebi it ai').split(' '));
