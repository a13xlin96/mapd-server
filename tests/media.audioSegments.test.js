const {planAudioSegments,mergeIntervals,missingIntervals,transcriptText,reusableSubtitles} = require('../lib/media/audioSegments');

test('20-second chunks cover full timeline with at most one second overlap',()=>{
  const plan=planAudioSegments(60500);
  expect(plan).toEqual([{startMs:0,endMs:20000},{startMs:19000,endMs:39000},{startMs:38000,endMs:58000},{startMs:57000,endMs:60500}]);
  expect(mergeIntervals(plan.map(p=>[p.startMs,p.endMs]),60500)).toEqual([[0,60500]]);
  expect(plan.reduce((n,p)=>n+p.endMs-p.startMs,0)).toBe(63500);
});
test('nearby silence adjusts a cut but does not discard quiet intervals',()=>{
  const plan=planAudioSegments(40000,{silenceBoundariesMs:[19500]});
  expect(plan[0].endMs).toBe(19500);expect(plan[1].startMs).toBe(18500);
  expect(missingIntervals(plan.map(p=>[p.startMs,p.endMs]),40000)).toEqual([]);
});
test('complete usable subtitle timeline skips all paid chunks; partial coverage leaves gaps',()=>{
  expect(planAudioSegments(30000,{coveredIntervals:[[0,30000]]})).toEqual([]);
  expect(planAudioSegments(30000,{coveredIntervals:[[0,10000],[20000,30000]]})).toEqual([{startMs:10000,endMs:20000}]);
  const subs=reusableSubtitles({segments:[{text:'鯛寿司',startMs:2000,endMs:5000}],coverage:{status:'complete',intervals:[[0,30000]]}},30000);
  expect(subs.segments[0]).toMatchObject({text:'鯛寿司',timing:'native'});
});
test('a subtitle string or false complete coverage cannot suppress audio',()=>{
  expect(()=>reusableSubtitles('some caption',30000)).toThrow();
  expect(()=>reusableSubtitles({segments:[],coverage:{status:'complete',intervals:[[0,10000]]}},30000)).toThrow();
});
test('exact longer overlap is deduplicated only in combined text, repeated venue names survive',()=>{
  const segments=[{startMs:0,endMs:20000,text:'We visited Tai Sushi in Kyoto'},
    {startMs:19000,endMs:39000,text:'Tai Sushi in Kyoto then ngâm CAFE'},
    {startMs:38000,endMs:50000,text:'ngâm CAFE and another ngâm CAFE'}];
  expect(transcriptText(segments)).toBe('We visited Tai Sushi in Kyoto\nthen ngâm CAFE\nngâm CAFE and another ngâm CAFE');
  expect(segments[1].text).toBe('Tai Sushi in Kyoto then ngâm CAFE');
  expect(transcriptText([{startMs:0,endMs:10,text:'same full repeated phrase'},{startMs:10,endMs:20,text:'same full repeated phrase'}])).toMatch(/phrase\nsame/);
});
test.each([-1,NaN,Infinity,180001])('invalid or overlong duration rejected: %s',n=>expect(()=>planAudioSegments(n)).toThrow());
test('invalid interval or excessive overlap rejected',()=>{
  expect(()=>mergeIntervals([[1000,500]],1000)).toThrow();
  expect(()=>planAudioSegments(10000,{overlapMs:2000})).toThrow();
});
test('fragmented subtitle gap plan preserves unread audio for decoder coalescing',()=>{
  const duration=180000,covered=Array.from({length:90},(_,i)=>[i*2000,i*2000+1000]);
  const plan=planAudioSegments(duration,{coveredIntervals:covered});
  expect(plan).toHaveLength(90);
  expect(plan.every(p=>p.endMs-p.startMs<=20000)).toBe(true);
  expect(missingIntervals([...covered,...plan.map(p=>[p.startMs,p.endMs])],duration)).toEqual([]);
  expect(plan).toEqual(planAudioSegments(duration,{coveredIntervals:covered.slice().reverse()}));
});
test('tight policy plans the full timeline so decoder can cap calls and report unread tail',()=>{
  const plan=planAudioSegments(180000,{chunkMs:2000,overlapMs:1000});
  expect(plan).toHaveLength(179);
  expect(missingIntervals(plan.map(p=>[p.startMs,p.endMs]),180000)).toEqual([]);
  expect(missingIntervals(plan.slice(0,32).map(p=>[p.startMs,p.endMs]),180000)).toEqual([[33000,180000]]);
});
