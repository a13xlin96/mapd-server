'use strict';
const {digest}=require('../sharedAiIdentity');
const {extractContentId}=require('../../enrich/urlUtils');
const cache=require('../cache');
const VERSION=require('../engineVersion');
/** An explicit one-hour freshness allowance, not a claim to have re-hashed
 * source bytes. Only completed validated evidence is reusable; failures never
 * become cached empty successes. Private share text salts the user scope. */
function manifestKey({url,ogData={},extracted,config,userId,baselinePlaces=[]}) {
  const contentId=extractContentId(url);
  if(!contentId)return null;
  return 'media-manifest-v2:'+digest({contentId,policy:config,engine:VERSION.engine,model:VERSION.model,
    scope:ogData.shareText?`user:${userId}`:'server-public',
    baselinePlaces:baselinePlaces.map(({name,city,country,address})=>({name,city:city || '',country:country || '',address:address || ''})),
    text:[ogData.title || '',ogData.description || '',extracted?.subtitles || ''],
    tracks:extracted?.subtitle_tracks || []});
}
function validResult(value) {
  if(!value || value.attempted!==true || value.incomplete!==false || !/^[a-f0-9]{64}$/.test(value.mediaDigest)
    || !Array.isArray(value.places) || value.places.length>40 || !value.coverage || value.error
    || !Array.isArray(value.retryOperations) || value.retryOperations.length || Buffer.byteLength(JSON.stringify(value))>65536)return false;
  if(value.contradictions!=null && (!Array.isArray(value.contradictions) || value.contradictions.length>40 || value.contradictions.some(c=>typeof c?.name!=='string' || c.name.length>300 || !Array.isArray(c.evidenceRefs) || !c.evidenceRefs.length || c.evidenceRefs.length>16)))return false;
  if(!['audio','visual','fusion'].every(k=>['complete','unavailable'].includes(value.coverage[k]?.status)))return false;
  return value.places.every(p=>typeof p.name==='string' && p.name.trim() && p.name.length<=300 && p.requiresSelection===true
    && ['city','country','address'].every(k=>p[k]==null || typeof p[k]==='string' && p[k].length<=500)
    && Array.isArray(p.evidenceRefs) && p.evidenceRefs.length>0 && p.evidenceRefs.length<=16);
}
async function readManifest(key,{now=Date.now,reader=cache.getCached}={}) {
  if(!key)return null;
  try {
    const item=await reader(key);
    if(item?.version!==1 || !Number.isFinite(item.createdAt) || item.createdAt>now() || now()-item.createdAt>=3600000 || !validResult(item.result))return null;
    return structuredClone(item.result);
  } catch {return null;}
}
async function writeManifest(key,result,{now=Date.now,writer=cache.setCache,ttlSeconds=3600}={}) {
  if(!key || !validResult(result))return;
  try {await writer(key,{version:1,createdAt:now(),result:structuredClone(result)},Math.min(3600,ttlSeconds));} catch { /* cache never authorizes a retry */ }
}
module.exports={manifestKey,validResult,readManifest,writeManifest};
