const {normalizePlaceName:normalize} = require('../lib/placeNameNormalize');
function geo(value) {
  return normalize(value).replace(/\bnyc\b/g,'new york').replace(/\bsf\b/g,'san francisco').replace(/\bla\b/g,'los angeles').replace(/\b(?:usa|us|united states of america)\b/g,'united states').replace(/\b(?:uk|great britain)\b/g,'united kingdom');
}
function validCoordinates(top) {
  const lat=top?.geometry?.location?.lat ?? top?.lat, lng=top?.geometry?.location?.lng ?? top?.lng;
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat)<=90 && Math.abs(lng)<=180;
}
function similarity(a,b) {
  if(!a || !b) return 0;
  if(a===b) return 1;
  const aa=new Set(a.split(' ')), bb=new Set(b.split(' '));
  const common=[...aa].filter(t=>bb.has(t)).length;
  return common/Math.max(aa.size,bb.size);
}
function rankPlaces(results, evidence={}, extractedPlace) {
  const text=geo([evidence.title,evidence.description,evidence.shareText,evidence.subtitles].filter(Boolean).join(' '));
  const city=geo(extractedPlace?.city || '');
  const addressHint=geo(extractedPlace?.address || '');
  const country=geo(extractedPlace?.country || '');
  // The model's source label is not proof. A proposed name absent from the
  // original text needs confirmation, including account-derived suggestions.
  const ordinaryText=normalize([evidence.title,evidence.description,evidence.shareText,evidence.subtitles,...(evidence.hashtags || [])].filter(Boolean).join(' ').replace(/@[\w.]+/g,''));
  const unsupportedName=!!extractedPlace && extractedPlace.source!=='vision' && !ordinaryText.replace(/\s/g,'').includes(normalize(extractedPlace.name).replace(/\s/g,''));

  const ranked=results.slice(0,5).filter(p=>p.place_id && p.name && validCoordinates(p) && (!extractedPlace?.confirmedPlaceId || p.place_id===extractedPlace.confirmedPlaceId)).map(top=>{
    const name=normalize(top.name), address=geo(top.formatted_address || '');
    const nameScore=extractedPlace ? similarity(normalize(extractedPlace.name),name) : (text.includes(name) ? 1 : 0);
    const explicitCity = city || geo((evidence.description || '').match(/\bin\s+([^.!?\n,#]+)/i)?.[1]?.split(/\b(?:with|for|and|where|at|on|we|is|was|then|today|near)\b/i)[0]?.trim() || '');
    const cityMatches=(!explicitCity || address.includes(explicitCity)) && (!country || address.includes(country));
    const addressParts=address.split(/\s+/).filter(w=>w.length>3);
    const geoMention=addressParts.some(w=>text.includes(w));
    const addressMatches=addressHint && (address.includes(addressHint) || similarity(addressHint,address)>=0.5);
    let score=0;
    if(nameScore >= 0.65 && cityMatches) score=Math.round(55*nameScore)+(city || country || geoMention || addressMatches ? 25 : 10);
    // A handle resemblance is useful for presenting a candidate, but does not
    // prove this is a restaurant's account. Always require user selection.
    const handleOnly=extractedPlace?.source==='handle';
    const missingGeography=!(geoMention || (city && text.includes(city)) || (country && text.includes(country)) || (addressHint && text.includes(addressHint)));
    if(handleOnly && !score) {
      const handle=normalize(extractedPlace.handle || extractedPlace.name).replace(/\s/g,'');
      if(handle.includes(name.replace(/\s/g,'')) && cityMatches) score=45;
    }
    return {top,score,requiresSelection:!extractedPlace?.confirmedPlaceId && (handleOnly || unsupportedName || missingGeography || extractedPlace?.requiresSelection===true),evidence:{nameScore,cityMatches,geoMention:!!geoMention,addressMatches:!!addressMatches}};
  }).sort((a,b)=>b.score-a.score);
  const winner=ranked[0];
  if(!winner || winner.score<40) return {place:null,score:0,requiresSelection:false,ranked};
  const ambiguous=ranked[1]?.score>=winner.score-10 && ranked[1]?.top.place_id!==winner.top.place_id;
  return {place:winner.top,score:winner.score,requiresSelection:winner.requiresSelection || !!ambiguous || winner.score<60,ranked};
}
function calculateConfidence(results,ogData) {
  const result=rankPlaces(results,ogData);
  // Legacy callers use flat lat/lng; retain geometry too for the pin builder.
  if(result.place) result.place={...result.place,lat:result.place.geometry?.location?.lat,lng:result.place.geometry?.location?.lng};
  return result;
}
module.exports={calculateConfidence,rankPlaces,validCoordinates,similarity};
