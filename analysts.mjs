// Works out who is speaking when a call is made, from how people are handed the mic on air:
// "कुणाल जी गुड मॉर्निंग", "बताइए राजेश जी", "… के सिद्धार्थ राय मंगला का स्वागत" hand over to that person,
// while "नमस्कार स्वाति जी" or "धन्यवाद अनिल जी" are replies to the person named (they are listening, not speaking).
import { readFile } from 'node:fs/promises';

const ALIASES_FILE = new URL('./analysts.json', import.meta.url);

// Words that come before "जी" but aren't names.
const NOT_NAME = new Set(('है हैं में लिए होगा नहीं से आप की का के था थी पर और ट्रेड सर जी हां हाँ नमस्कार बताएं बताइए मंत्री मोदी ' +
  'श बहती सोल ध्वनि क्रिस्पी शिया अच्छा बिल्कुल ठीक धन्यवाद शुक्रिया बहुत आपका आपकी आपके ओके हम तो भी ही यह ये वो वह ' +
  'कि को ने जो सब सभी गुड मॉर्निंग सुप्रभात नमस्ते स्वागत चलिए आइए थैंक यू थैंक्यू मैडम भाई साहब बाबा पापा माता पिता ' +
  'सरकार कंपनी बाजार मार्केट स्टॉक शेयर निफ्टी गवर्नर चेयरमैन सीईओ एमडी डायरेक्टर आज कल अब फिर फरमाइए ट्रेड्स खयाल ख्याल ' +
  'बहदी बती सत सा वाह अरे देवियो सज्जनों दोस्तों साथियों').split(' '));
const isNameWord = w => /^[ऀ-ॿ]{3,}$/.test(w) && !NOT_NAME.has(w);

const HANDOVER_AFTER = /^(गुड|नमस्कार|नमस्ते|सुप्रभात|बताइए|बताएं|बताइये|आपकी|आपके|आपका|आपने|आप|क्या|कैसे|स्वागत|वेलकम|शुरुआत|पहले|आपसे|हमें|हमारे|आइए|जल्दी|फटाफट)/;
const HANDOVER_BEFORE = /^(बताइए|बताएं|बताइये|चलते|बढ़ते|रुख|पास|साथ|स्वागत|आइए|शुरुआत)/;
const REPLY_BEFORE = /^(नमस्कार|धन्यवाद|शुक्रिया|थैंक|थैंक्यू|thank|thanks|बिल्कुल|जी|हां|हाँ|गुड)/i;
const REPLY_AFTER = /^(देखिए|बिल्कुल|धन्यवाद|शुक्रिया|थैंक|थैंक्यू|जैसा|आपने|सही)/;

const clean = w => (w || '').replace(/^[\["'(]+|[\]"'),।!?:;.]+$/g, '');

// Finds handovers in a token list ({ w, t }). Returns [{ pos, t, first, full }].
export function findHandovers(toks) {
  const events = [];
  const full = new Map(); // first name -> full name, from intros in this stream
  for (let i = 0; i < toks.length; i++) {
    const w = clean(toks[i].w);
    // Intro: "… के <first> <last> का स्वागत" or "<first> <last> जी नमस्कार".
    if (/^स्वागत/.test(w) && /^(का|को)$/.test(clean(toks[i - 1]?.w))) {
      const names = [];
      for (let j = i - 2; j >= Math.max(0, i - 5); j--) {
        const n = clean(toks[j].w);
        if (n === 'जी') continue;
        if (!isNameWord(n) || /^(के|की|का|से)$/.test(n)) break;
        names.unshift(n);
      }
      if (names.length) {
        // "सिद्धार्थ राय मंगला": later "सिद्धार्थ जी" or "मंगला जी" both mean this person.
        if (names.length >= 2) for (const n of [names[0], names.at(-1)]) full.set(n, names.slice(0, 3).join(' '));
        events.push({ pos: i, t: toks[i].t, first: names[0], intro: true });
      }
      continue;
    }
    if (w !== 'जी') continue;
    const first = clean(toks[i - 1]?.w);
    if (!isNameWord(first)) continue;
    // Only the word right before जी is taken; the word before that is usually filler ("लेकिन सतीश जी").
    const name = first, start = i - 1;
    const before = clean(toks[start - 1]?.w), after = clean(toks[i + 1]?.w);
    const reply = REPLY_BEFORE.test(before) || REPLY_AFTER.test(after);
    const handover = !reply && (HANDOVER_AFTER.test(after) || HANDOVER_BEFORE.test(before));
    if (handover) events.push({ pos: start, t: toks[start].t, first: name });
  }
  for (const e of events) e.full = full.get(e.first) || e.first;
  return events;
}

// The person handed the mic most recently before token `pos`, within `windowMs`.
export function speakerAt(events, pos, t, windowMs = 4 * 60 * 1000) {
  let best = null;
  for (const e of events) {
    if (e.pos >= pos) break;
    if (t - e.t <= windowMs) best = e;
  }
  return best?.full || null;
}

// Optional analysts.json: [{ "name": "Anil Singhvi", "aliases": ["अनिल सिंघवी", "अनिल"] }] to merge spellings
// and show an English name. Matching ignores spaces.
let aliasMap = null;
export async function canonicalName(name) {
  if (!name) return null;
  if (!aliasMap) {
    aliasMap = new Map();
    try {
      for (const a of JSON.parse(await readFile(ALIASES_FILE, 'utf8')))
        for (const al of [a.name, ...(a.aliases || [])]) aliasMap.set(al.replace(/\s+/g, ''), a.name);
    } catch {}
  }
  return aliasMap.get(name.replace(/\s+/g, '')) || name;
}
