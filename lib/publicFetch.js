const https = require('https');
const dns = require('dns').promises;
const {BlockList, isIP} = require('net');
const {EngineError} = require('./engineError');
const {withProvider} = require('./providerRuntime');

const blocked4 = new BlockList(), blocked6 = new BlockList();
const ipv4Ranges = [
  ['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8],
  ['169.254.0.0',16], ['172.16.0.0',12], ['192.168.0.0',16], ['192.0.0.0',24],
  ['192.0.2.0',24], ['198.18.0.0',15], ['198.51.100.0',24], ['203.0.113.0',24],
  ['224.0.0.0',4], ['240.0.0.0',4],
];
// Block transition/translation ranges too: they can embed private IPv4 targets.
const ipv6Ranges = [
  ['::',96], ['::ffff:0:0',96], ['64:ff9b::',96], ['64:ff9b:1::',48],
  ['100::',64], ['2001::',32], ['2001:db8::',32], ['2002::',16],
  ['fc00::',7], ['fe80::',10], ['ff00::',8],
];
for (const [ip,bits] of ipv4Ranges) blocked4.addSubnet(ip,bits,'ipv4');
for (const [ip,bits] of ipv6Ranges) blocked6.addSubnet(ip,bits,'ipv6');
const denied = () => new EngineError('access_blocked',{stage:'source_url'});
function isPublic(address) {
  const family = isIP(address);
  return family === 4 ? !blocked4.check(address,'ipv4') : family === 6 && !blocked6.check(address,'ipv6');
}
async function publicAddress(url) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || (target.port && target.port !== '443')) throw denied();
  const hostname = target.hostname.replace(/^\[|\]$/g,'');
  if (isIP(hostname) && !isPublic(hostname)) throw denied();
  let timer;
  const addresses = await Promise.race([
    dns.lookup(hostname,{all:true}),
    new Promise((_,reject) => {timer = setTimeout(() => reject(new EngineError('dependency_timeout',{stage:'dns'})),4000);}),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(a => !isPublic(a.address))) throw denied();
  return addresses[0];
}
async function fetchPublicInner(url, axios, options) {
  const started = Date.now();
  for (let redirects = 0; redirects <= 3; redirects++) {
    const address = await publicAddress(url);
    const remaining = 15000 - (Date.now() - started);
    if (remaining <= 0) throw new EngineError('dependency_timeout',{stage:'metadata'});
    // Pin the validated DNS answer into the actual connection. Performing a
    // second lookup would permit rebinding between validation and the request.
    const agent = new https.Agent({lookup:(_host,opts,cb) => opts.all ? cb(null,[address]) : cb(null,address.address,address.family)});
    let response;
    try {
      const request = options.method === 'HEAD' ? axios.head.bind(axios) : axios.get.bind(axios);
      response = await request(url,{
        ...options, httpsAgent:agent, proxy:false, maxRedirects:0,
        timeout:Math.min(remaining,8000), validateStatus:s => s >= 200 && s < 400,
        maxContentLength:2 * 1024 * 1024, maxBodyLength:2 * 1024 * 1024,
      });
    } finally {agent.destroy();}
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.location;
      if (!location) throw denied();
      url = new URL(location,url).href;
      continue;
    }
    return {...response,url};
  }
  throw denied();
}
async function fetchPublic(url,axios,options = {}) {
  return withProvider('web',() => fetchPublicInner(url,axios,options),4);
}
module.exports = {fetchPublic,publicAddress};
