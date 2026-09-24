'use strict';
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const {createHash,randomUUID} = require('crypto');
const {Transform} = require('stream');
const {execFile} = require('child_process');
const {promisify} = require('util');
const {pipeline} = require('stream/promises');
const {publicAddress} = require('../publicFetch');
const {EngineError,retryAfter} = require('../engineError');
const {validateMediaConfig} = require('./mediaConfig');
const {assertInternalDescriptor} = require('./mediaSource');
const ACTIVE = new Set();
const error = code => new EngineError(code,{stage:'media_download'});
/** Kernel process-birth identity, not just PID liveness (PIDs are reusable after a crash).
 * Linux uses boot UUID + start ticks; macOS uses ps lstart. Unknown probes retain files.
 */
async function processIdentity(pid) {
  if(!Number.isSafeInteger(pid) || pid<1)return {state:'unknown'};
  try {
    if(process.platform==='linux') {
      const [stat,boot]=await Promise.all([fsp.readFile(`/proc/${pid}/stat`,'utf8'),fsp.readFile('/proc/sys/kernel/random/boot_id','utf8')]);
      const ticks=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19];
      if(/^\d+$/.test(ticks) && /^[a-f0-9-]{36}$/.test(boot.trim()))return {state:'alive',birth:`linux:${boot.trim()}:${ticks}`};
    } else if(process.platform==='darwin') {
      const {stdout}=await promisify(execFile)('/bin/ps',['-p',String(pid),'-o','lstart='],
        {timeout:1000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}});
      const birth=stdout.trim().replace(/\s+/g,' ');
      if(/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(birth))return {state:'alive',birth:`darwin:${birth}`};
    }
  } catch { /* No guessed identity on a denied, absent or unsupported process probe. */ }
  try {process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return {state:'dead'};}
  return {state:'unknown'};
}
function sniffContainer(bytes) {
  if (bytes.length >= 12 && bytes.toString('ascii',4,8) === 'ftyp' && bytes.readUInt32BE(0) >= 12) return 'mp4';
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3
      && /webm|matroska/.test(bytes.subarray(0,4096).toString('latin1'))) return 'webm';
  return null;
}
/** Private workspace with references owned by physical operations. dispose releases the caller;
 * retain returns an idempotent release function. No path/reference enters serialized results.
 */
async function createWorkspace({root = os.tmpdir(),maxBytes = 128*1024*1024} = {}) {
  const directory = await fsp.mkdtemp(path.join(root,'mapd-media-'));
  const identity=await processIdentity(process.pid);
  const owner = {version:2,pid:process.pid,processBirth:identity.birth || null,createdAt:Date.now(),token:randomUUID()};
  try {
    await fsp.chmod(directory,0o700);
    await fsp.writeFile(path.join(directory,'owner.json'),JSON.stringify(owner),{mode:0o600,flag:'wx'});
  } catch(e) {await fsp.rm(directory,{recursive:true,force:true});throw e;}
  ACTIVE.add(directory);
  let refs = 1, disposed = false, removed = false;
  async function release() { if (--refs === 0) {removed=true; ACTIVE.delete(directory); await fsp.rm(directory,{recursive:true,force:true});} }
  return {
    directory,
    retain() {
      if (removed) throw error('attempt_stopped');
      refs++; let released=false;
      return async () => {if (!released) {released=true;await release();}};
    },
    async dispose() {if (!disposed) {disposed=true;await release();}},
    async assertQuota() {
      const entries = await fsp.readdir(directory,{withFileTypes:true});
      let bytes=0;
      for (const entry of entries) {
        if (!entry.isFile()) throw error('access_blocked');
        bytes += (await fsp.lstat(path.join(directory,entry.name))).size;
        if (bytes > maxBytes) throw error('input_too_large');
      }
      return bytes;
    },
  };
}
/** Crash-only sweep: aged known directories owned by a dead process or a reused PID with a
 * different kernel birth identity. Unknown identity retains files. Never follow symlinks.
 * Version-1 markers from older workers are removable only when the PID is confirmed dead.
 */
async function sweepOrphanWorkspaces({root=os.tmpdir(),olderThanMs=86400000,now=Date.now(),identifyProcess=processIdentity}={}) {
  let removed=0;
  for (const entry of await fsp.readdir(root,{withFileTypes:true})) {
    if (!entry.isDirectory() || !/^mapd-media-[a-zA-Z0-9]+$/.test(entry.name)) continue;
    const directory=path.join(root,entry.name); if (ACTIVE.has(directory)) continue;
    try {
      const marker=path.join(directory,'owner.json');
      if (!(await fsp.lstat(marker)).isFile() || (await fsp.stat(marker)).size > 1024) continue;
      const owner=JSON.parse(await fsp.readFile(marker,'utf8'));
      if (![1,2].includes(owner.version) || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !Number.isFinite(owner.createdAt)
          || now-owner.createdAt < olderThanMs) continue;
      const identity=await identifyProcess(owner.pid);
      const birth=value=>typeof value==='string' && /^(?:linux|darwin):[^\r\n]{1,180}$/.test(value);
      const reused=owner.version===2 && identity?.state==='alive' && birth(owner.processBirth) && birth(identity.birth)
        && owner.processBirth!==identity.birth;
      if(identity?.state!=='dead' && !reused)continue;
      await fsp.rm(directory,{recursive:true,force:true});removed++;
    } catch { /* Unknown ownership is retained, not guessed. */ }
  }
  return removed;
}

/** HTTPS streaming transport. DNS answer is pinned to the socket; every redirect is revalidated.
 * Caller headers/cookies/proxies are unsupported. Byte limits apply to streamed bytes, not headers.
 */
async function downloadPublicMedia({url,destination,signal,deadline,maxBytes=64*1024*1024},deps={}) {
  const resolve=deps.publicAddress || publicAddress, request=deps.request || https.request;
  const controller=new AbortController();
  const stopped=()=>controller.abort(error('attempt_stopped'));
  if (signal?.aborted) throw error('attempt_stopped');
  signal?.addEventListener('abort',stopped,{once:true});
  const end=Math.min(deadline || Infinity,Date.now()+25000);
  if (end <= Date.now()) {signal?.removeEventListener('abort',stopped);throw error('dependency_timeout');}
  const timer=setTimeout(()=>controller.abort(error('dependency_timeout')),end-Date.now());
  let bytes=0, prefix=Buffer.alloc(0), container, digest=createHash('sha256'),created=false;
  try {
    for (let redirect=0;redirect<=3;redirect++) {
      const address=await resolve(url);
      if (controller.signal.aborted) throw controller.signal.reason;
      const agent=new https.Agent({lookup:(_host,opts,cb)=>opts.all?cb(null,[address]):cb(null,address.address,address.family)});
      let response;
      try {
        response=await new Promise((resolveResponse,reject)=>{
          const req=request(url,{method:'GET',agent,signal:controller.signal,
            headers:{Accept:'video/mp4,video/webm,application/octet-stream','Accept-Encoding':'identity'}},resolveResponse);
          req.on('error',reject);req.end();
        });
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.destroy();
          if (!response.headers.location || redirect === 3) throw error('access_blocked');
          url=new URL(response.headers.location,url).href;continue;
        }
        if (response.statusCode !== 200) {
          response.destroy();
          if (response.statusCode === 429) throw new EngineError('rate_limited',{stage:'media_download',retryAfterSeconds:retryAfter(response.headers['retry-after'])});
          throw error([401,403].includes(response.statusCode)?'access_blocked':'source_unavailable');
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw error('invalid_response');
        const length=Number(response.headers['content-length']);
        if (length > maxBytes) throw error('input_too_large');
        const meter=new Transform({transform(chunk,_encoding,done) {
          bytes+=chunk.length;
          if (bytes > maxBytes) return done(error('input_too_large'));
          if (prefix.length < 4096) prefix=Buffer.concat([prefix,chunk.subarray(0,4096-prefix.length)]);
          digest.update(chunk);done(null,chunk);
        }});
        const output=fs.createWriteStream(destination,{flags:'wx',mode:0o600});
        output.once('open',()=>{created=true;});
        // Some Node versions reject pipeline on an upstream error before the
        // asynchronous file open completes. Wait for close before checking
        // ownership/deleting, or the late open can leave a file after rejection.
        const outputClosed=new Promise(resolve=>output.once('close',resolve));
        try {await pipeline(response,meter,output,{signal:controller.signal});}
        finally {output.destroy();await outputClosed;}
        container=sniffContainer(prefix);
        if (!container || bytes === 0 || Number.isFinite(length) && length > 0 && bytes !== length) throw error('invalid_response');
        return {path:destination,bytes,container,contentDigest:digest.digest('hex')};
      } finally {response?.destroy();agent.destroy();}
    }
    throw error('access_blocked');
  } catch(e) {
    if(created)await fsp.rm(destination,{force:true});
    if (controller.signal.aborted) throw controller.signal.reason;
    if (e instanceof EngineError) throw e;
    throw error('dependency_error');
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',stopped);}
}

/** Acquire exactly one rendition for one attempt. No fallback after blocked/429/expired media.
 * Returns LocalMedia {path, directory, contentDigest, bytes, container, retain, dispose, assertQuota}.
 */
async function acquireMedia({descriptor,signal,deadline,config = {},root},deps={}) {
  assertInternalDescriptor(descriptor);
  const policy=validateMediaConfig(config);
  if (descriptor.durationMs > policy.maxDurationMs) throw error('input_too_large');
  const workspace=await createWorkspace({root,maxBytes:policy.maxWorkspaceBytes});
  try {
    const available=policy.maxWorkspaceBytes-await workspace.assertQuota();
    if(available<=0)throw error('input_too_large');
    const runtime=require('../providerRuntime');
    const withLease=deps.withLease || runtime.withLease,withProvider=deps.withProvider || runtime.withProvider;
    const result=await withLease('media:download',()=>withProvider(descriptor.provider,()=>downloadPublicMedia({
      url:descriptor.renditions[0].url,destination:path.join(workspace.directory,'source.media'),
      maxBytes:Math.min(policy.maxDownloadBytes,available),signal,deadline:Math.min(deadline || Infinity,Date.now()+policy.downloadTimeoutMs)},deps)),{slots:2});
    await workspace.assertQuota();
    return {...workspace,...result};
  } catch(e) {await workspace.dispose();throw e;}
}
module.exports={acquireMedia,downloadPublicMedia,createWorkspace,sweepOrphanWorkspaces,sniffContainer,processIdentity};
