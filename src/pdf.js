// Tiny, dependency-free PDF generator for official WB PNG labels.
// Keeps source pixels unchanged except compositing alpha onto white.
// Supports 8-bit grayscale, RGB, indexed, grayscale+alpha and RGBA PNG.
const enc=new TextEncoder();
const be32=(b,i)=>((b[i]*0x1000000)+(b[i+1]<<16)+(b[i+2]<<8)+b[i+3])>>>0;
function bytesFromBase64(input) {
  const binary=atob(input.replace(/\s/g,''));
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return bytes;
}
function concat(parts) {
  const len=parts.reduce((n,x)=>n+x.length,0);
  const out=new Uint8Array(len);
  let at=0;for(const part of parts){out.set(part,at);at+=part.length;}
  return out;
}
async function transformStream(input,kind) {
  const stream=kind==='inflate'?new DecompressionStream('deflate'):new CompressionStream('deflate');
  const writer=stream.writable.getWriter();
  const readPromise=new Response(stream.readable).arrayBuffer();
  await writer.write(input);
  await writer.close();
  return new Uint8Array(await readPromise);
}
async function pngToRgb(png) {
  if(png.length<33 || png.subarray(0,8).some((v,i)=>v!==[137,80,78,71,13,10,26,10][i])) throw Error('invalid_png');
  let width=0,height=0,depth=0,type=0,interlace=0,palette=null;
  const idat=[];
  for(let pos=8;pos+12<=png.length;){
    const len=be32(png,pos),name=String.fromCharCode(...png.subarray(pos+4,pos+8));
    if(pos+12+len>png.length)throw Error('truncated_png');
    const body=png.subarray(pos+8,pos+8+len);
    if(name==='IHDR') {width=be32(body,0);height=be32(body,4);depth=body[8];type=body[9];interlace=body[12];}
    if(name==='PLTE')palette=body;
    if(name==='IDAT')idat.push(body);
    pos+=12+len;
    if(name==='IEND')break;
  }
  const channels=({0:1,2:3,3:1,4:2,6:4})[type];
  if(!channels || depth!==8 || interlace!==0 || !width || !height || width>4096 || height>4096) throw Error('unsupported_png');
  // Lossless zero-copy path: PDF PNG Predictor 15 understands the original RGB
  // scanline filters. Avoid expensive 800x600 pixel processing on Cloudflare Free.
  if(type===2) return {width,height,compressed:concat(idat),predictor:true};
  const raw=await transformStream(concat(idat),'inflate');
  const stride=width*channels,expected=height*(stride+1);
  if(raw.length!==expected)throw Error('png_length_mismatch');
  const rgb=new Uint8Array(width*height*3),prev=new Uint8Array(stride),row=new Uint8Array(stride);
  let offset=0,out=0;
  const paeth=(a,b,c)=>{
    const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);
    return da<=db&&da<=dc?a:db<=dc?b:c;
  };
  for(let y=0;y<height;y++){
    const filter=raw[offset++];
    for(let x=0;x<stride;x++){
      const left=x>=channels?row[x-channels]:0,up=prev[x],corner=x>=channels?prev[x-channels]:0;
      const predictor=filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):filter===4?paeth(left,up,corner):null;
      if(predictor===null)throw Error('png_filter');
      row[x]=(raw[offset++]+predictor)&255;
    }
    for(let x=0;x<width;x++){
      const i=x*channels;
      let r,g,b,a=255;
      if(type===0){r=g=b=row[i];}
      else if(type===2){r=row[i];g=row[i+1];b=row[i+2];}
      else if(type===3){const p=row[i]*3;if(!palette||p+2>=palette.length)throw Error('png_palette');r=palette[p];g=palette[p+1];b=palette[p+2];}
      else if(type===4){r=g=b=row[i];a=row[i+1];}
      else {r=row[i];g=row[i+1];b=row[i+2];a=row[i+3];}
      rgb[out++]=Math.round((r*a+255*(255-a))/255);
      rgb[out++]=Math.round((g*a+255*(255-a))/255);
      rgb[out++]=Math.round((b*a+255*(255-a))/255);
    }
    prev.set(row);
  }
  return {width,height,compressed:await transformStream(rgb,'deflate')};
}
function ascii(s){return enc.encode(s);}
function streamObject(dictionary,content) {
  return concat([ascii(dictionary+' /Length '+content.length+' >>\nstream\n'),content,ascii('\nendstream')]);
}
function pdfObjects(objects){
  const chunks=[ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')],offsets=[0];
  let cursor=chunks[0].length;
  for(let i=0;i<objects.length;i++){
    const chunk=concat([ascii((i+1)+' 0 obj\n'),objects[i],ascii('\nendobj\n')]);
    offsets.push(cursor);chunks.push(chunk);cursor+=chunk.length;
  }
  const xref=cursor;
  let table='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n';
  for(let i=1;i<offsets.length;i++)table+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';
  chunks.push(ascii(table+'trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n'));
  return concat(chunks);
}
export async function officialPngPdf(base64,{widthMm=58,heightMm=40}={}){
  const img=await pngToRgb(bytesFromBase64(base64));
  const w=widthMm*72/25.4,h=heightMm*72/25.4;
  const scale=Math.min(w/img.width,h/img.height);
  const iw=img.width*scale,ih=img.height*scale;
  const x=(w-iw)/2,y=(h-ih)/2;
  const content=ascii('q\n'+[iw,0,0,ih,x,y].map(n=>n.toFixed(4)).join(' ')+' cm\n/Im1 Do\nQ\n');
  const objects=[
    ascii('<< /Type /Catalog /Pages 2 0 R >>'),
    ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    ascii('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 '+w.toFixed(4)+' '+h.toFixed(4)+'] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>'),
    streamObject('<<',content),
    streamObject('<< /Type /XObject /Subtype /Image /Width '+img.width+' /Height '+img.height+' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode'+(img.predictor?' /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns '+img.width+' >>':''),img.compressed)
  ];
  return pdfObjects(objects);
}
