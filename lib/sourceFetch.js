const {MAX_HTML_BYTES} = require('./postMetadata');
const {EngineError} = require('./engineError');
// Canonical social HTML readers follow only redirects on the same provider.
async function fetchSourceHtml(url,headers={},fetchImpl=fetch) {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),15000);
  const original=new URL(url);
  const allowed=original.hostname.endsWith('instagram.com') ? 'instagram.com' : 'tiktok.com';
  try {
    for(let redirects=0;redirects<=3;redirects++) {
      const target=new URL(url);
      if(target.protocol!=='https:' || target.username || target.password || (target.port && target.port!=='443') || !(target.hostname===allowed || target.hostname.endsWith('.'+allowed))) throw new EngineError('access_blocked',{stage:'redirect',provider:allowed});
      const response=await fetchImpl(url,{headers,redirect:'manual',signal:controller.signal});
      if(response.status>=300 && response.status<400) {
        await response.body?.cancel?.();
        const location=response.headers.get('location');
        if(!location) throw new EngineError('source_unavailable',{stage:'redirect'});
        url=new URL(location,url).href;continue;
      }
      if(!response.ok) {
        await response.body?.cancel?.();
        const error=new Error(`Source HTTP ${response.status}`);error.status=response.status;error.retryAfter=response.headers?.get('retry-after');throw error;
      }
      if(Number(response.headers?.get('content-length'))>MAX_HTML_BYTES) {await response.body?.cancel?.();throw new EngineError('input_too_large',{stage:'metadata'});}
      if(!response.body?.getReader) {
        const text=await response.text();
        if(Buffer.byteLength(text)>MAX_HTML_BYTES) throw new EngineError('input_too_large',{stage:'metadata'});
        return text;
      }
      const reader=response.body.getReader(), chunks=[];let size=0;
      try {
        while(true) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_HTML_BYTES)throw new EngineError('input_too_large',{stage:'metadata'});chunks.push(Buffer.from(value));}
      } finally {await reader.cancel();}
      return Buffer.concat(chunks).toString('utf8');
    }
    throw new EngineError('source_unavailable',{stage:'redirect'});
  } finally {clearTimeout(timeout);}
}
module.exports={fetchSourceHtml};
