const {fixtures,evaluate} = require('./engine/evaluate.cjs');
describe('offline engine regression corpus (not live accuracy)',()=>{
  test.each(fixtures.map(f=>[f.id,f]))('%s',async(_id,f)=>{expect(await evaluate(f)).toBe(true);});
});
const {parseInstagramPost} = require('../lib/postMetadata');
const html = value=>`<script type="application/json">${JSON.stringify(value)}</script>`;
describe('account-tag evidence',()=>{
  test('only matching post tags and collaborators are used, not suggestions or uploader',()=>{
    const result=parseInstagramPost(html({posts:[
      {shortcode:'OTHER',coauthor_producers:[{username:'unrelated'}]},
      {shortcode:'TARGET',owner:{username:'creator'},edge_media_to_tagged_user:{edges:[{node:{user:{username:'ramenofficial',full_name:'Ramen Kitchen'}}}]},coauthor_producers:[{username:'cafeab',full_name:'Cafe AB'}]},
    ],suggested_users:[{username:'suggestion'}]}),'TARGET');
    expect(result.accountTags).toEqual([
      {handle:'ramenofficial',displayName:'Ramen Kitchen',origin:'post_tag'},
      {handle:'cafeab',displayName:'Cafe AB',origin:'collaboration'},
    ]);
    expect(result.uploader).toBe('creator');
    expect(result.tagMetadataAvailable).toBe(true);
  });
  test('tag-only post works with mobile usertags and no caption',()=>{
    const result=parseInstagramPost(html({code:'TARGET',usertags:{in:[{user:{username:'ab',full_name:'京都の寿司店'}}]}}),'TARGET');
    expect(result.caption).toBe('');expect(result.accountTags[0].displayName).toBe('京都の寿司店');
  });
  test('unknown structure does not mean a confirmed absence of tags',()=>{
    const result=parseInstagramPost('<meta content="Dinner @ab" property="og:description">','TARGET');
    expect(result.tagMetadataAvailable).toBe(false);expect(result.accountTags[0].handle).toBe('ab');
  });
  test('reads JSON embedded inside a script string without executing code',()=>{
    const payload={shortcode:'TARGET',coauthor_producers:[{username:'ramenofficial'}]};
    const result=parseInstagramPost(`<script>consume(${JSON.stringify(JSON.stringify(payload))}); global.__shouldNeverRun = true;</script>`,'TARGET');
    expect(result.collaborators).toEqual(['ramenofficial']);expect(global.__shouldNeverRun).toBeUndefined();
  });
});
const {rankPlaces,validCoordinates} = require('../enrich/confidence');
const place=(id,name,address)=>({place_id:id,name,formatted_address:address,geometry:{location:{lat:35,lng:135}}});
test('ranks the correct city above the first wrong-city Google result',()=>{
  const result=rankPlaces([place('wrong','Tai Sushi','Miami USA'),place('right','Tai Sushi','Kyoto Japan')],{description:'Tai Sushi in Kyoto'}, {name:'Tai Sushi',city:'Kyoto'});
  expect(result.place.place_id).toBe('right');expect(result.requiresSelection).toBe(false);
});
test('a tag match and ambiguous branches require selection',()=>{
  const result=rankPlaces([place('one','Tai Sushi','Kyoto Japan'),place('two','Tai Sushi','Kyoto Japan')],{}, {name:'Tai Sushi',city:'Kyoto',source:'handle',handle:'taisushi'});
  expect(result.requiresSelection).toBe(true);
});
test('missing coordinates are not interpreted as zero; real zero coordinates are valid',()=>{
  expect(validCoordinates({geometry:{location:{lat:null,lng:null}}})).toBe(false);
  expect(validCoordinates({geometry:{location:{lat:0,lng:0}}})).toBe(true);
});

test('exact business name without destination evidence still asks for confirmation',()=>{
  const result=rankPlaces([place('one','Tai Sushi','Miami USA')],{description:'Tai Sushi'}, {name:'Tai Sushi',source:'caption'});
  expect(result.place.place_id).toBe('one');expect(result.requiresSelection).toBe(true);
});
test('login boilerplate is blocked while a real matching post is allowed',()=>{
  const {assertReadableInstagramPost}=require('../lib/postMetadata');
  const metadata=parseInstagramPost('<meta property="og:title" content="Instagram"><meta property="og:description" content="Log in to see photos and videos from friends">','TARGET');
  expect(()=>assertReadableInstagramPost(metadata)).toThrow(expect.objectContaining({code:'access_blocked'}));
  expect(()=>assertReadableInstagramPost({...metadata,tagMetadataAvailable:true})).not.toThrow();
});
test('matching post without structured tag fields reports partial coverage',()=>{
  expect(parseInstagramPost(html({shortcode:'TARGET',caption:{text:'@cafe'}}),'TARGET').accountTagCoverage).toBe('partial');
});

test('a fabricated name or location cannot authorize an automatic save',()=>{
  const candidate=place('one','Tai Sushi','Miami USA');
  expect(rankPlaces([candidate],{description:'Lunch with friends in Miami'}, {name:'Tai Sushi',city:'Miami',source:'caption'}).requiresSelection).toBe(true);
  expect(rankPlaces([candidate],{description:'Tai Sushi'}, {name:'Tai Sushi',city:'Miami',source:'caption'}).requiresSelection).toBe(true);
});
