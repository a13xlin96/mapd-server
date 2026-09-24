const {Parser} = require('htmlparser2');
const {EngineError} = require('./engineError');
const {parseMentionedAccounts} = require('./placeNameNormalize');
const MAX_HTML_BYTES = 2 * 1024 * 1024;
function parsePage(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_HTML_BYTES) throw new EngineError('input_too_large',{stage:'metadata'});
  const meta = Object.create(null), scripts = [];
  let inTitle = false, inScript = false, title = '', script = '';
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === 'meta') {
        const key = (attrs.property || attrs.name || '').toLowerCase();
        if (key && !meta[key]) meta[key] = attrs.content || '';
      }
      if (name === 'title') inTitle = true;
      if (name === 'script') {inScript = true; script = '';}
    },
    ontext(text) {if (inTitle) title += text; if (inScript) script += text;},
    onclosetag(name) {
      if (name === 'title') inTitle = false;
      if (name === 'script') {inScript = false; if (scripts.length < 100) scripts.push(script);}
    },
  },{decodeEntities:true});
  parser.end(html);
  return {title:meta['og:title'] || meta['twitter:title'] || title.trim(),
    description:meta['og:description'] || meta['twitter:description'] || meta.description || '',
    image:meta['og:image'] || meta['twitter:image'] || '',url:meta['og:url'] || '',siteName:meta['og:site_name'] || '',scripts};
}
// Read JSON and JSON string literals from script payloads; never execute page JS.
function scriptValues(script) {
  try {return [JSON.parse(script)];} catch {}
  const values = [];
  for (let i = 0; i < script.length && values.length < 50; i++) {
    if (!['{','[','"'].includes(script[i])) continue;
    const start = i, stack = []; let quoted = false, escaped = false;
    for (; i < script.length; i++) {
      const c = script[i];
      if (escaped) {escaped = false; continue;}
      if (quoted && c === '\\') {escaped = true; continue;}
      if (c === '"') {quoted = !quoted; if (!quoted && script[start] === '"') break; continue;}
      if (quoted) continue;
      if (c === '{' || c === '[') stack.push(c);
      if (c === '}' || c === ']') {stack.pop(); if (!stack.length) break;}
    }
    try {values.push(JSON.parse(script.slice(start,i+1)));} catch {}
  }
  return values;
}
function account(user, origin) {
  const handle = typeof user === 'string' ? user : user?.username;
  if (typeof handle !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.]{0,29}$/.test(handle) || handle.endsWith('.') || handle.includes('..')) return null;
  return {handle:handle.toLowerCase(),displayName:typeof user?.full_name === 'string' ? user.full_name.slice(0,200) : '',origin};
}
function parseInstagramPost(html, shortcode) {
  const page = parsePage(html);
  const stack = page.scripts.flatMap(scriptValues).map(value=>({value,depth:0}));
  const seen = new Set(); let visits = 0, post = null;
  while (stack.length && visits++ < 30000) {
    const {value,depth} = stack.pop();
    if (depth > 30) continue;
    if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
      try {stack.push({value:JSON.parse(value),depth:depth+1});} catch {}
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      if (value.shortcode === shortcode || value.code === shortcode) {post = value; break;}
      for (const child of Object.values(value)) stack.push({value:child,depth:depth+1});
    }
  }
  const raw = [];
  const array = value => Array.isArray(value) ? value : [];
  const caption = array(post?.edge_media_to_caption?.edges).map(e=>typeof e?.node?.text==='string'?e.node.text:'').join('\n') || (typeof post?.caption?.text==='string'?post.caption.text:'');
  for (const handle of parseMentionedAccounts(caption || page.description)) raw.push(account(handle,'caption'));
  // These are fields of the matching post only. Suggested users, tagged users
  // on other posts and the uploader are deliberately not promoted to tags.
  for (const edge of array(post?.edge_media_to_tagged_user?.edges)) raw.push(account(edge?.node?.user,'post_tag'));
  for (const tag of array(post?.usertags?.in)) raw.push(account(tag?.user,'post_tag'));
  for (const user of array(post?.coauthor_producers)) raw.push(account(user,'collaboration'));
  // Prefer structured associations over caption-only accounts when metadata exceeds the budget.
  raw.sort((a,b)=>(a?.origin==='caption'?1:0)-(b?.origin==='caption'?1:0));
  const tags = [], keys = new Set();
  for (const item of raw) {if (!item || keys.has(item.origin+':'+item.handle)) continue; keys.add(item.origin+':'+item.handle); tags.push(item); if(tags.length >= 30) break;}
  const slides = (Array.isArray(post?.edge_sidecar_to_children?.edges) ? post.edge_sidecar_to_children.edges : []).map(e=>e?.node?.display_url).filter(u=>typeof u==='string' && u.startsWith('https://')).slice(0,20);
  if(!slides.length && typeof post?.display_url==='string' && post.display_url.startsWith('https://')) slides.push(post.display_url);
  const hasStructuredTags=Array.isArray(post?.edge_media_to_tagged_user?.edges) || Array.isArray(post?.usertags?.in) || Array.isArray(post?.coauthor_producers);
  return {page,caption,accountTags:tags,tagMetadataAvailable:!!post,accountTagCoverage:!post?'unavailable':!hasStructuredTags || raw.filter(Boolean).length>30?'partial':'complete',
    collaborators:tags.filter(t=>t.origin==='collaboration').map(t=>t.handle),
    uploader:post?.owner?.username || post?.user?.username || '',
    location:typeof post?.location?.name === 'string' ? post.location.name : '',slides,
    // Matching structured post only: page-wide video tags can belong to a recommendation.
    mediaRenditions:!post?.edge_sidecar_to_children && post?.media_type !== 8 ? [
      ...(typeof post?.video_url === 'string' ? [{url:post.video_url,format:'mp4',hasAudio:true}] : []),
      ...array(post?.video_versions).map(v=>({url:v?.url,format:'mp4',hasAudio:true,width:v?.width,height:v?.height})),
    ].slice(0,8) : [], durationMs:Number.isFinite(post?.video_duration) ? post.video_duration*1000 : null};
}
function assertReadableInstagramPost(metadata) {
  if (metadata.tagMetadataAvailable) return;
  const {title,description,url}=metadata.page;
  const loginUrl=/\/(?:accounts\/(?:login|signup)|challenge)(?:\/|[?#]|$)/i.test(url);
  const genericTitle=/^(?:instagram|(?:log in|login|sign up).*instagram|instagram.*(?:log in|login|sign up))$/i.test(title.trim());
  const loginCopy=/(?:log in|login|sign up|create an account|see photos and videos|forgot password)/i.test(description);
  if (loginUrl || (genericTitle && loginCopy)) throw new EngineError('access_blocked',{stage:'source',provider:'instagram'});
}
module.exports = {parsePage,parseInstagramPost,assertReadableInstagramPost,MAX_HTML_BYTES};
