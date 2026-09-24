'use strict';
const {createHash} = require('crypto');

/** scene-grid-v1 heuristics, NOT OCR. Input is a normalized 8-bit grayscale image.
 * Grid novelty downweights the bottom 25% to prevent changing subtitles from dominating signs.
 * Stable formulas/version must change together if corpus tuning changes these thresholds.
 */
function analyzeGrayFrame(bytes,width,height,previous) {
  if(!Buffer.isBuffer(bytes) || bytes.length!==width*height || width<9 || height<9)throw new TypeError('Invalid gray frame');
  const grid=new Array(64).fill(0),counts=new Array(64).fill(0);
  let laplacian=0,edges=0;
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++) {
    const i=y*width+x,cell=Math.min(7,Math.floor(y*8/height))*8+Math.min(7,Math.floor(x*8/width));
    const gradient=(Math.abs(bytes[i]-bytes[i-1])+Math.abs(bytes[i]-bytes[i-width]))/510;
    grid[cell]+=gradient;counts[cell]++;edges+=gradient;
    laplacian+=Math.abs(4*bytes[i]-bytes[i-1]-bytes[i+1]-bytes[i-width]-bytes[i+width])/1020;
  }
  grid.forEach((_,i)=>{grid[i]/=Math.max(1,counts[i]);});
  const regionScores=grid.map((edge,i)=>Math.min(1,Math.abs(edge-(previous?.grid?.[i] || 0))*8)*(i>=48?0.5:1));
  const novelRegionScore=Math.min(1,regionScores.slice().sort((a,b)=>b-a).slice(0,8).reduce((a,b)=>a+b,0)/8);
  let hash=0n;
  for(let y=0;y<8;y++)for(let x=0;x<8;x++) {
    const row=Math.min(height-1,Math.floor((y+0.5)*height/8));
    const a=bytes[row*width+Math.floor(x*width/9)],b=bytes[row*width+Math.floor((x+1)*width/9)];
    hash=(hash<<1n) | (a>b?1n:0n);
  }
  return {digest:createHash('sha256').update(bytes).digest('hex'),perceptualHash:hash.toString(16).padStart(16,'0'),grid,
    clarity:Math.min(1,laplacian/((width-2)*(height-2))*12),novelRegionScore,regionScores,
    edgeDensity:edges/((width-2)*(height-2))};
}
function hammingDistance(a,b) {
  let xor=BigInt('0x'+a)^BigInt('0x'+b),count=0;while(xor){count++;xor&=xor-1n;}return count;
}
module.exports={analyzeGrayFrame,hammingDistance};
