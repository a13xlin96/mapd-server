// Offline component benchmark: all posts, model responses and Google candidates
// below are synthetic. This measures deterministic regressions, not live recall.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { createRequire } = require('module');
const fixtures = require('./fixtures.json');
const root = path.resolve(__dirname, '../..');
function load(relative, overrides = {}) {
  const filename = path.join(root, relative);
  const native = createRequire(filename);
  const module = {exports:{}};
  const quiet = {log(){},warn(){},error(){}};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports:module.exports, require: name => Object.hasOwn(overrides,name) ? overrides[name] : native(name),
    console: quiet, process:{env:{}}, Buffer, URL, AbortController, setTimeout, clearTimeout,
    fetch: async () => {throw new Error('Live network is forbidden in the benchmark');},
  }, {filename});
  return module.exports;
}
async function evaluate(fixture) {
  if (fixture.kind === 'metadata') {
    const parser = load('enrich/ogMetadata.js', {'../lib/publicFetch':{fetchPublic:async()=>({data:fixture.html})}});
    const result = await parser.fetchOGMetadata('https://example.com/post');
    return result.description === fixture.expected;
  }
  if (fixture.kind === 'mentions') {
    const {parseMentionedAccounts} = require('../../lib/placeNameNormalize');
    return JSON.stringify(parseMentionedAccounts(fixture.text)) === JSON.stringify(fixture.expected);
  }
  if (fixture.kind === 'cache' || fixture.kind === 'validation') {
    const cache = new Map(); let calls = 0;
    const shared = require('../../lib/sharedAiOperation').createSharedAiOperations({allowLocal:true,
      cache:{getCached:async k=>cache.get(k),setCache:async(k,v)=>cache.set(k,v)}});
    const ai = load('enrich/ai.js', {
      '../lib/sharedAiOperation': {...shared, SERVER_PUBLIC_SCOPE:require('../../lib/sharedAiOperation').SERVER_PUBLIC_SCOPE},
      '../lib/providerRuntime': {withProvider:async (_provider, work) => {
        await require('../../lib/jobContext').current()?.sharedOperation?.authorizeDispatch();
        return work();
      }},
      '../lib/anthropic': {anthropic:{messages:{create:async()=>{
        calls++;
        return fixture.kind === 'validation'
          ? {stop_reason:fixture.stop,content:[{type:'text',text:fixture.text}]}
          : {stop_reason:'end_turn',content:[{type:'text',text:'{"places":[],"count":0}'}]};
      }}}},
    });
    if (fixture.kind === 'validation') {
      try {await ai.aiExtractPlaces({title:'Synthetic post',description:'Tai Sushi, Kyoto'}); return false;}
      catch {return calls === 1 && cache.size === 0;}
    }
    const base = {title:'My trip',description:'A wonderful holiday. '.repeat(8),subtitles:'A wonderful introduction. '.repeat(8)};
    await ai.aiExtractPlaces(base,{scope:'user:synthetic'});
    const changed = {...base};
    if (fixture.signal === 'caption-tail') changed.description += fixture.input;
    if (fixture.signal === 'hashtag-context') changed.hashtags = [fixture.input];
    if (fixture.signal === 'uploader-context') changed.uploader = fixture.input;
    if (fixture.signal === 'transcript-tail') changed.subtitles += fixture.input;
    await ai.aiExtractPlaces(changed,{scope:'user:synthetic'});
    return calls === 2;
  }
  if (fixture.kind === 'matching') {
    const {calculateConfidence} = require('../../enrich/confidence');
    const name = fixture.id === 'non-latin-match' ? '京都の寿司店' : 'Tai Sushi';
    const result = {place_id:'fixture-place',name,formatted_address:fixture.address,geometry:{location:{lat:35,lng:135}},types:['restaurant']};
    const {score} = calculateConfidence([result,{...result,place_id:'fixture-second'}], {title:fixture.title,description:fixture.caption});
    return (score >= 60) === fixture.expected;
  }
  throw new Error('Unknown fixture kind');
}
async function run() {
  const cases = [];
  for (const fixture of fixtures) {
    try {cases.push({id:fixture.id,kind:fixture.kind,split:fixture.split,passed:await evaluate(fixture)});}
    catch (error) {cases.push({id:fixture.id,kind:fixture.kind,split:fixture.split,passed:false,error:error.message});}
  }
  return {scope:'synthetic component regression benchmark; not measured live accuracy',total:cases.length,passed:cases.filter(c=>c.passed).length,cases};
}
module.exports = {run, evaluate, fixtures};
