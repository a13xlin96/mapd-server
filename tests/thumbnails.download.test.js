const https = require('https');
const dns = require('dns').promises;
const { EventEmitter } = require('events');
const { downloadImage } = require('../lib/thumbnails');
const raw = 'https://scontent.cdninstagram.com/thumbnail.jpg';
const jpeg = Buffer.from([255,216,255,224]);
let request;
function response({status=200,headers={},chunks=[jpeg]}={}) {
  request.mockImplementationOnce((_url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = err => {req.emit('error',err);req.emit('close');};
    queueMicrotask(() => {
      const res = new EventEmitter();
      Object.assign(res,{statusCode:status,headers,resume:()=>req.emit('close')});
      callback(res);
      chunks.forEach(chunk=>res.emit('data',chunk));
      res.emit('end'); req.emit('close');
    });
    return req;
  });
}
beforeEach(()=>{
  jest.spyOn(dns,'lookup').mockResolvedValue([{address:'203.0.113.4',family:4}]);
  request=jest.spyOn(https,'get');
});
afterEach(()=>jest.restoreAllMocks());
test('pins the validated DNS answer and identifies actual image bytes',async()=>{
  response();
  expect(await downloadImage(raw)).toEqual({bytes:jpeg,contentType:'image/jpeg'});
  const lookup=request.mock.calls[0][1].lookup;
  const cb=jest.fn();lookup('ignored',{all:true},cb);
  expect(cb).toHaveBeenCalledWith(null,[{address:'203.0.113.4',family:4}]);
});
test.each(['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1'])('rejects a CDN name resolving to %s',async address=>{
  dns.lookup.mockResolvedValue([{address,family:address.includes(':')?6:4}]);
  await expect(downloadImage(raw)).rejects.toThrow('unsafe-image-address');
  expect(request).not.toHaveBeenCalled();
});
test('revalidates the destination after redirects',async()=>{
  response({status:302,headers:{location:'https://127.0.0.1/private'}});
  await expect(downloadImage(raw)).rejects.toThrow('unsafe-image-url');
  expect(request).toHaveBeenCalledTimes(1);
});
test('rejects oversized declared and streamed images',async()=>{
  response({headers:{'content-length':String(6*1024*1024)}});
  await expect(downloadImage(raw)).rejects.toThrow('image-unavailable');
  response({chunks:[Buffer.alloc(6*1024*1024)]});
  await expect(downloadImage(raw)).rejects.toThrow('image-too-large');
});
test('does not serve active content disguised as an image',async()=>{
  response({headers:{'content-type':'image/jpeg'},chunks:[Buffer.from('<svg onload="alert(1)"/>')]});
  await expect(downloadImage(raw)).rejects.toThrow('unsupported-image');
});
