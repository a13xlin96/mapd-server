const { createThumbnailRepair } = require('../lib/repairThumbnails');
const url='https://www.instagram.com/reel/ABC/';
const raw='https://scontent.cdninstagram.com/expired.jpg';
const stored='https://firebasestorage.googleapis.com/v0/b/test/o/image?alt=media';
test('repairs main/source images without dropping a newly added link', async()=>{
 const before={userId:'u1',url,ogImage:raw,sources:[{url,ogImage:raw}]};
 const current={...before,sources:[...before.sources,{url:'https://other.test',ogImage:'new'}]};
 const txn={get:async()=>({exists:true,data:()=>current}),update:jest.fn()};
 const fs={runTransaction:fn=>fn(txn)};
 const persist=jest.fn(async image=>image===raw?raw:stored);
 const extract=jest.fn(async()=>({image:'https://scontent.cdninstagram.com/fresh.jpg',url}));
 const repair=createThumbnailRepair({persist,extract});
 expect(await repair(fs,{ref:'pin',data:()=>before})).toBe(true);
 expect(extract).toHaveBeenCalledTimes(1);
 expect(persist).toHaveBeenNthCalledWith(1,raw,url,'u1');
 expect(txn.update.mock.calls[0][1]).toEqual({ogImage:stored,sources:[{url,ogImage:stored},{url:'https://other.test',ogImage:'new'}]});
});
test('a source removed during extraction stays removed',async()=>{
 const before={userId:'u1',url:'',ogImage:'',sources:[{url,ogImage:raw}]};
 const txn={get:async()=>({exists:true,data:()=>({...before,sources:[]})}),update:jest.fn()};
 const repair=createThumbnailRepair({persist:async()=>stored});
 expect(await repair({runTransaction:fn=>fn(txn)},{ref:'p',data:()=>before})).toBe(false);
 expect(txn.update).not.toHaveBeenCalled();
});
