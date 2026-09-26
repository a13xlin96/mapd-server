const {normalizePlaceName:normalize} = require('../lib/placeNameNormalize');
const {hasPhrase,removePhrase,geography,matchesGeography,matchesCountry,geographyMention,addressEvidence,nameEvidence,compatibleVariants} = require('./matchingEvidence');
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
  const city=normalize(extractedPlace?.city);
  const country=normalize(extractedPlace?.country);
  const addressHint=extractedPlace?.address || '';
  // The model's source label is not proof. A proposed name absent from the
  // original text needs confirmation, including account-derived suggestions.
  const ordinaryText=normalize([evidence.title,evidence.description,evidence.shareText,evidence.subtitles,...(evidence.hashtags || [])].filter(Boolean).join(' ').replace(/@[\p{L}\p{N}_.]+/gu,''));
  const unsupportedName=!!extractedPlace && !hasPhrase(ordinaryText,normalize(extractedPlace.name));
  const explicitCity = city || normalize((evidence.description || '').match(/\bin\s+([^.!?\n,#]+)/i)?.[1]?.split(/\b(?:with|for|and|where|at|on|we|is|was|then|today|near)\b/i)[0]?.trim());
  const ranked=results.slice(0,10).filter(p=>p?.place_id && p.name && validCoordinates(p) && (!extractedPlace?.confirmedPlaceId || p.place_id===extractedPlace.confirmedPlaceId)).map(top=>{
    const lat=p=>p.geometry?.location?.lat ?? p.lat, lng=p=>p.geometry?.location?.lng ?? p.lng;
    const variants=[top,...(Array.isArray(top._matchingVariants) ? top._matchingVariants : []).filter(v=>
      v?.place_id===top.place_id && v.name && validCoordinates(v) &&
      Math.abs(lat(v)-lat(top))<=0.002 && Math.abs(lng(v)-lng(top))<=0.002 && compatibleVariants(top,v))];
    // A name and geography must agree within one complete Google result. Do
    // not combine a localized name with another row's more convenient city.
    const assessed=variants.map(variant=>{
      const profile=geography(variant), name=normalize(variant.name);
      const nameMatch=extractedPlace ? nameEvidence(extractedPlace.name,name,profile,similarity) : {score:hasPhrase(ordinaryText,name)?1:0,partial:false};
      const nameScore=nameMatch.score;
      const cityMatches=matchesGeography(explicitCity,profile.groups) && matchesCountry(country,profile);
      let locationText=ordinaryText;
      for (const venueName of [normalize(extractedPlace?.name),...variants.map(v=>normalize(v.name))].filter(Boolean).sort((a,b)=>b.length-a.length)) locationText=removePhrase(locationText,venueName);
      const geoMention=geographyMention(locationText,profile);
      const address=addressEvidence(addressHint,profile), addressMatches=address.matches;
      const sourceAddress=addressMatches && hasPhrase(locationText,normalize(addressHint));
      const locationMatches=!!(explicitCity || country || geoMention || addressMatches);
      let score=0;
      if(cityMatches && !address.conflict) {
        if(nameScore===1) score=55+(locationMatches?25:10);
        else if(nameMatch.partial && locationMatches) score=Math.min(59,40+Math.round(19*nameScore));
      }
      // A handle resemblance is useful for presenting a candidate, but does not
      // prove this is a restaurant's account. Always require user selection.
      const handleOnly=extractedPlace?.source==='handle';
      const missingGeography=!(geoMention || sourceAddress);
      if(handleOnly && !score && !address.conflict) {
        const handle=normalize(extractedPlace.handle || extractedPlace.name).replace(/\s/g,'');
        if(handle.includes(name.replace(/\s/g,'')) && cityMatches) score=45;
      }
      const mediaOnly=['vision','transcript','subtitle','audio','media'].includes(extractedPlace?.source);
      return {top,score,requiresSelection:!extractedPlace?.confirmedPlaceId && (handleOnly || unsupportedName || missingGeography || mediaOnly || variant!==top || nameMatch.partial || extractedPlace?.requiresSelection===true),evidence:{nameScore,cityMatches,geoMention:!!geoMention,addressMatches:!!addressMatches}};
    });
    return assessed.sort((a,b)=>b.score-a.score)[0];
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
