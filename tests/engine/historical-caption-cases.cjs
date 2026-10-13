'use strict';
// Reuse previously captured public Places responses. Post text and normalized
// extraction inputs below are reconstructed from the earlier incident tests;
// they are not archived captions or a fresh model/source invocation.
const incident=require('./incident-google-responses.json');
const kuma=require('./kuma-google-response.json').result;
const rows=require('./matching-google-results.json');
const chicken=require('./matching-localized-google.json');
const query=p=>[p.name,p.address,p.city].filter(Boolean).join(' ');
const one=(id,name,p,key)=>({id,name,clues:[p],entries:[{query:query(p),results:incident[key].results}],
  expectedIds:[incident[key].results[0].place_id],provenance:incident[key].provenance});
const cases=[
 one('qinghe','清河鵝肉',{name:'清河鵝肉',city:'臺北市',source:'caption'},'taipei'),
 one('tamvi','Tầm Vị',{name:'Tầm Vị',city:'Hanoi',address:'4B Yên Thế, Đống Đa, Hà Nội',source:'caption'},'tamvi'),
 one('banhcuon','Bánh Cuốn Hong Kong 189',{name:'Banh Cuon Hong Kong 189',city:'Ho Chi Minh City',address:'189/1 Đường Phùng Hưng, Chợ Lớn, Ho Chi Minh City',source:'caption'},'banhcuon'),
 one('ruemiche','Rue Miche account tag',{name:'ruemiche',handle:'ruemiche',city:'Ho Chi Minh City',source:'handle'},'ruemiche'),
];
const kumaClues=[
 {name:'Kuma Omakase',city:'Ho Chi Minh City',address:'44 Dang Thi Nhu, Ben Thanh Ward, HCMC, Vietnam',source:'caption'},
 {name:'Kuma Omakase',city:'HCMC',country:'Vietnam',address:'44 Dang Thi Nhu, Ben Thanh Ward',source:'caption'},
];
cases.push({id:'kuma',name:'Kuma Omakase (duplicate mentions)',url:'https://www.instagram.com/reel/Ddz3bp3BEgP/',
 clues:kumaClues,entries:kumaClues.map(p=>({query:query(p),results:[kuma]})),expectedIds:[kuma.place_id],
 provenance:require('./kuma-google-response.json').provenance});
const chickenClue={name:'上好雞肉 | Shang Hao Chicken Rice',city:'New Taipei City',
 address:'No.1 Lane8 Minzhi Street Zhonghe District Taiwan',source:'caption'};
cases.push({id:'shanghao',name:'Shang Hao Chicken Rice (bilingual)',url:'https://www.instagram.com/reel/DeZMm_tz7NL/',
 clues:[chickenClue],entries:[{query:query(chickenClue),results:rows.at(-1).results,localized:{'zh-TW':[chicken]}}],
 expectedIds:[chicken.place_id],provenance:'Captured public Google fields; reconstructed bilingual clue from the reported failure.'});
const tokyoNames=['Oudouya Chokkei IEKEI TOKYO','王道家直系 IEKEI TOKYO','Shisen Tantanmen Aun Yushima honten',
 'Mendokoro Haru','Craft Ramen BiT','Ramen Yamato'];
cases.push({id:'tokyo',name:'Tokyo ramen roundup (six names, five unique Places IDs)',url:'https://www.instagram.com/p/DdqsSY2gA7_/',
 clues:tokyoNames.map(name=>({name,city:'Tokyo, Japan',source:'caption'})),entries:rows.slice(0,6),
 expectedIds:[...new Set(rows.slice(0,6).map(r=>r.results[0].place_id))],
 provenance:'Recorded public names/IDs/addresses; Tokyo coordinates are synthetic, as documented by the original fixture. Six reconstructed clues, not a claim to recover every venue in the video.'});
for(const c of cases) {
 c.url ||= `https://www.instagram.com/reel/OfflineCase_${c.id}/`;
 c.caption=c.clues.map(p=>`${p.source==='handle'?'@': '📍 '}${p.name}\n${[p.address,p.city,p.country].filter(Boolean).join(', ')}`).join('\n');
}
function frozenLookup(fixture) {
 return async(q,_bias,_restriction,options)=>{
  const entry=fixture.entries.find(e=>e.query===q);
  if(!entry)throw new Error('No recorded response for this query');
  if(options?.languageCode) {
   if(!entry.localized?.[options.languageCode])throw new Error('No recorded response for this language');
   return structuredClone(entry.localized[options.languageCode]);
  }
  return structuredClone(entry.results);
 };
}
module.exports={cases,frozenLookup,query};
