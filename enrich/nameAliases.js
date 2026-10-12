const {normalizePlaceName:normalize} = require('../lib/placeNameNormalize');

const LATIN = /^[\p{Script=Latin}\p{M}\p{N}\s'’.-]+$/u;
const NATIVE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{M}\p{N}\sー・]+$/u;
const script = value => LATIN.test(value) ? 'latin' : NATIVE.test(value) ? 'native' : null;
const GENERIC_NATIVE = new Set(['雞肉飯','鸡肉饭','雞肉','鸡肉','牛肉麵','牛肉面','拉麵','拉面',
  '壽司','寿司','咖啡','餐廳','餐厅','食堂','居酒屋','焼肉','燒肉','烧肉']);
// Branches, numbered locations, and lists need the full name. Do not drop a
// qualifier from one script just because the other script omits it.
const QUALIFIER = /\p{N}|[店館馆]|分舖|分铺|지점|본점|분점|별관|\b(?:branch|annex|outlet|location|flagship|main|original|east|west|north|south|central|downtown|airport|station|mall|district|city|village)\b/iu;
const LIST = /\b(?:and|or|plus|with|vs|versus)\b|[和與与及、・,，;；&+\r\n]|\s[-–—]|[-–—]\s/iu;
function genericNative(value) {
  let remainder=value.replace(/\s/gu,'');
  for (const term of [...GENERIC_NATIVE].sort((a,b)=>b.length-a.length)) remainder=remainder.split(term).join('');
  return !remainder;
}

function aliases(value) {
  if (typeof value!=='string' || value.length>200 || /[\r\n]/u.test(value)) return null;
  const raw=value.normalize('NFKC').trim();
  // Exactly two explicitly paired scripts. No comma, slash, dash, implicit
  // whitespace, nested parentheses, or repeated-separator list splitting.
  const pair=raw.match(/^([^|()]+)\|([^|()]+)$/u) || raw.match(/^([^|()]+)\(([^|()]+)\)$/u);
  if (!pair) return null;
  const parts=pair.slice(1).map(v=>v.trim());
  const scripts=parts.map(script);
  if (!scripts.includes('latin') || !scripts.includes('native')) return null;
  return parts.map((name,i)=>({name,script:scripts[i]}));
}

function safeName(value,isDistinctive,hasGeography) {
  if (QUALIFIER.test(value) || LIST.test(value)) return false;
  const normalized=normalize(value);
  if (hasGeography(normalized)) return false;
  return script(value)==='native'
    ? normalized.length>=3 && !genericNative(normalized) && isDistinctive(normalized)
    : isDistinctive(normalized);
}

function bilingualNameEvidence(wanted,actual,compare,isDistinctive,hasGeography,isGeneric) {
  const left=aliases(wanted),right=aliases(actual);
  if (!left && !right) return null;
  const none={score:0,partial:false};
  const a=left || [{name:wanted,script:script(wanted)}];
  const b=right || [{name:actual,script:script(actual)}];
  // An ineligible alias is no evidence, not proof that the full names conflict.
  if ([...a,...b].some(part=>!part.script || !safeName(part.name,isDistinctive,hasGeography))) return null;
  const pairs=a.flatMap(x=>b.filter(y=>x.script===y.script).map(y=>[x,y]));
  // Without a Latin-to-Latin comparison we cannot know whether an ignored
  // Latin arm contains an untranslated branch qualifier. Keep whole evidence.
  if (!pairs.some(([x])=>x.script==='latin')) return null;
  for (const [x,y] of pairs.filter(([x])=>x.script==='latin')) {
    const one=new Set(normalize(x.name).split(' ')),two=new Set(normalize(y.name).split(' '));
    const unmatched=[...one].filter(w=>!two.has(w)).concat([...two].filter(w=>!one.has(w)));
    if (unmatched.some(word=>!isGeneric(word))) return left && right ? none : null;
  }
  const comparisons=pairs.map(([x,y])=>compare(x.name,y.name));
  // When both sides explicitly supply both scripts, neither can contradict
  // the other. Never choose the convenient English arm over a different CJK
  // business name (or vice versa), and never infer a translation.
  if (!comparisons.length || comparisons.some(m=>m.score!==1 && !m.partial)) return none;
  return {score:Math.min(0.9,...comparisons.map(m=>m.score)),partial:true};
}

module.exports={bilingualNameEvidence};
