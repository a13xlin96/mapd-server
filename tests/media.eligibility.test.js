const {mediaEligibility,mergeCandidates}=require('../lib/media/mediaEligibility');
const {createEngineFeatures}=require('../lib/engineFeatures');
const features=createEngineFeatures({snapshotVersion:2,version:'test',rolloutPercent:100,flags:{mediaEvidence:true}}).selectForVerifiedUid('u',['mediaRecoveryV1']);
const base={features,url:'https://www.instagram.com/reel/abc/',extracted:{subtitles:'A restaurant speech'},ogData:{description:'A'.repeat(100)},places:[{name:'Tai Sushi'}]};
test('off and carousels never start new providers',()=>{
 expect(mediaEligibility({...base,features:null}).run).toBe(false);
 expect(mediaEligibility({...base,extracted:{is_carousel:true}}).run).toBe(false);
});
test('good single-caption result does not suppress missing audio or listicle evidence',()=>{
 expect(mediaEligibility({...base,extracted:{}}).reason).toBe('missing_subtitle_coverage');
 expect(mediaEligibility({...base,ogData:{description:'Top 8 restaurants '+ 'A'.repeat(100)}}).reason).toBe('incomplete_listicle');
});
test('provisional ambiguity escalates once and never loops',()=>{
 expect(mediaEligibility(base).run).toBe(false);
 expect(mediaEligibility({...base,matches:{requiresSelection:true}}).run).toBe(true);
 expect(mediaEligibility({...base,analysisRetry:true,attempted:true}).run).toBe(false);
});
test('conflicting geography downgrades automatic baseline and preserves branches',()=>{
 const merged=mergeCandidates([{name:'Cafe A',city:'Tokyo'}],[{name:'Cafe A',city:'Kyoto'}]);
 expect(merged).toHaveLength(2);expect(merged.every(p=>p.requiresSelection)).toBe(true);
 expect(mergeCandidates([{name:'Cafe A',city:'Tokyo'}],[{name:'Cafe A',city:'Tokyo'}])).toEqual([{name:'Cafe A',city:'Tokyo'}]);
});
