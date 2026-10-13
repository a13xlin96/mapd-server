const {createPlaceMatcher}=require('../enrich/placeMatching');
const {EngineError}=require('../lib/engineError');
const context=require('../lib/jobContext');
const p={name:'Cafe Lantern',city:'Kyoto',country:'Japan',address:'25 Market Road, Kyoto',source:'caption'};
const evidence={description:'Cafe Lantern at 25 Market Road, Kyoto, Japan'};
const query=[p.name,p.address,p.city].join(' ');
const google={place_id:'lantern',name:p.name,formatted_address:p.address+', Japan',geometry:{location:{lat:35,lng:135}}};
test('empty over-specified search gets one simpler literal query and requires confirmation',async()=>{
 const search=jest.fn(async()=>[google]),match=createPlaceMatcher(search);
 expect(await match([],evidence,p,query)).toMatchObject({place:{place_id:'lantern'},requiresSelection:true});
 await match([],evidence,p,query);expect(search.mock.calls).toEqual([['Cafe Lantern Kyoto Japan']]);
});
test.each(['26 Market Road, Kyoto, Japan','25 Market Road, Osaka, Japan','25 Market Road, Taipei, Taiwan'])('simplification cannot erase original address contradiction: %s',async address=>{
 const match=createPlaceMatcher(jest.fn(async()=>[{...google,formatted_address:address}]));
 expect((await match([],evidence,p,query)).place).toBeNull();
});
test.each([{...p,source:'handle'},{...p,city:'Invented City'},{...p,name:'Invented Cafe'},{...p,address:''}])('unsupported clues do not spend on simplified query %#',async candidate=>{
 const search=jest.fn(),match=createPlaceMatcher(search);
 await match([],evidence,candidate,[candidate.name,candidate.address,candidate.city].filter(Boolean).join(' '));
 expect(search).not.toHaveBeenCalled();
});
test('two alternate queries per job includes failures, with no automatic provider retry',async()=>{
 const search=jest.fn(async()=>{throw new EngineError('rate_limited',{stage:'matching',provider:'google'});}),match=createPlaceMatcher(search);
 for(let i=0;i<4;i++){
  const place={...p,name:'Cafe '+i},caption={description:place.name+' '+p.address};
  await match([],caption,place,[place.name,place.address,place.city].join(' '));
 }
 expect(search).toHaveBeenCalledTimes(2);
});
test('successful primary matching costs no alternate request',async()=>{
 const search=jest.fn();expect((await createPlaceMatcher(search)([google],evidence,p,query)).place?.place_id).toBe('lantern');
 expect(search).not.toHaveBeenCalled();
});
test('stopped job does not launch alternate query',async()=>{
 const controller=new AbortController();controller.abort();const search=jest.fn();
 await expect(context.run({signal:controller.signal,deadline:Date.now()+10000},()=>createPlaceMatcher(search)([],evidence,p,query))).rejects.toMatchObject({code:'attempt_stopped'});
 expect(search).not.toHaveBeenCalled();
});
