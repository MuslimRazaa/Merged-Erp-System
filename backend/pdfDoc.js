/* ============================================================
   Server-side port of the frontend's hand-rolled PdfDoc (public/index.html)
   — same minimal PDF-1.4 writer, no library, so payslip PDFs built here
   look and behave exactly like every other document this app prints.
   Kept as a plain, careful copy rather than a shared file the browser also
   loads, since the frontend version has no module system to export from.

   Adds one thing the frontend version doesn't need: real password
   protection (PDF Standard Security Handler, Revision 2 / 40-bit RC4 —
   the simplest variant, but still opens a password prompt in every normal
   PDF viewer, which is all "lock the payslip to its own employee" needs).
   RC4 and MD5-based key derivation are implemented directly (RC4 is ~15
   lines either way, and Node's legacy RC4 cipher isn't guaranteed to be
   available depending on the OpenSSL build) rather than pulling in a PDF
   library — this file is the one new piece of "security code" in the
   app, so it stays small and auditable in one place.
   ============================================================ */
'use strict';
const crypto = require('crypto');

const PDF_W_N=[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const PDF_W_B=[278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const PDF_MARK={'\u2013':'\\226','\u2014':'\\227','\u00D8':'\\330','\u00B7':'\\267','\u00B0':'\\260','\u2018':'\\221','\u2019':'\\222','\u201C':'\\223','\u201D':'\\224','\u2026':'\\205','\u00AE':'\\256','\u2122':'\\231','\u00A9':'\\251','\u00B1':'\\261','\u00D7':'\\327','\u20AC':'\\200','\u00A3':'\\243'};
const PDF_MARK_W={'\u2013':[556,556],'\u2014':[1000,1000],'\u00D8':[778,778],'\u00B7':[278,278],'\u00B0':[400,400],'\u2018':[222,278],'\u2019':[222,278],'\u201C':[333,500],'\u201D':[333,500],'\u2026':[1000,1000],'\u00AE':[737,737],'\u2122':[1000,1000],'\u00A9':[737,737],'\u00B1':[584,584],'\u00D7':[584,584],'\u20AC':[556,556],'\u00A3':[556,556]};
const PDF_SPELL={'\u2264':'<=','\u2265':'>='};

/* ---------------- RC4 + MD5-based Standard Security Handler (Rev 2) ----------------
   All of it works on "binary strings" (one JS char = one byte, 0-255) — the
   same convention PdfDoc already uses throughout for raw PDF bytes. */
const PAD32='\x28\xBF\x4E\x5E\x4E\x75\x8A\x41\x64\x00\x4E\x56\xFF\xFA\x01\x08\x2E\x2E\x00\xB6\xD0\x68\x3E\x80\x2F\x0C\xA9\xFE\x64\x53\x69\x7A';
function rc4(keyBytes,dataStr){
  const S=new Uint8Array(256);
  for(let i=0;i<256;i++)S[i]=i;
  let j=0;
  for(let i=0;i<256;i++){j=(j+S[i]+keyBytes[i%keyBytes.length])&0xFF;const t=S[i];S[i]=S[j];S[j]=t;}
  let i=0;j=0;let out='';
  for(let n=0;n<dataStr.length;n++){
    i=(i+1)&0xFF;j=(j+S[i])&0xFF;
    const t=S[i];S[i]=S[j];S[j]=t;
    const k=S[(S[i]+S[j])&0xFF];
    out+=String.fromCharCode(dataStr.charCodeAt(n)^k);
  }
  return out;
}
function md5(binStr){return crypto.createHash('md5').update(Buffer.from(binStr,'binary')).digest('latin1');}
function strBytes(s){const a=[];for(let i=0;i<s.length;i++)a.push(s.charCodeAt(i));return a;}
function padPassword(pw){
  let s=String(pw||'');
  if(s.length>32)s=s.slice(0,32);
  return s+PAD32.slice(0,32-s.length);
}
function computeOwnerKey(ownerPw){return md5(padPassword(ownerPw)).slice(0,5);} // 40-bit, Rev 2: no extra MD5 rounds
function computeO(userPw,ownerPw){
  const key=computeOwnerKey(ownerPw||userPw);
  return rc4(strBytes(key),padPassword(userPw));
}
function computeEncryptionKey(userPw,O,P,id0){
  let input=padPassword(userPw)+O;
  const p=P>>>0;
  input+=String.fromCharCode(p&0xFF,(p>>8)&0xFF,(p>>16)&0xFF,(p>>24)&0xFF);
  input+=id0;
  return md5(input).slice(0,5);
}
function computeU(fileKey){return rc4(strBytes(fileKey),PAD32);}
function objectKey(fileKey,objNum,genNum){
  const extra=String.fromCharCode(objNum&0xFF,(objNum>>8)&0xFF,(objNum>>16)&0xFF,genNum&0xFF,(genNum>>8)&0xFF);
  const n=Math.min(fileKey.length+5,16);
  return md5(fileKey+extra).slice(0,n);
}
function toHexString(binStr){
  let h='';
  for(let i=0;i<binStr.length;i++)h+=binStr.charCodeAt(i).toString(16).padStart(2,'0');
  return '<'+h.toUpperCase()+'>';
}

function PdfDoc(opts){
  opts=opts||{};
  this.land=!!opts.landscape;
  this.w=opts.w||(this.land?842:595); this.h=opts.h||(this.land?595:842);
  this.mL=40;this.mR=40;this.mT=46;this.mB=46;
  this.pages=[];this.imgs=[];this._enc=null;this.newPage();
}
PdfDoc.prototype={
 newPage(){this.cur={ops:[],imgs:[]};this.pages.push(this.cur);this.y=this.h-this.mT;},
 // Password-protect the finished PDF (Standard Security Handler, Rev 2 /
 // 40-bit RC4) — every normal PDF viewer (Acrobat, Chrome, Preview,
 // phone viewers) will prompt for this password before opening the file.
 // ownerPassword defaults to the same value when omitted (we only need an
 // "open password" here, not separate print/copy restrictions).
 encrypt(userPassword,ownerPassword){this._enc={userPassword:String(userPassword),ownerPassword:String(ownerPassword||userPassword)};return this;},
 esc(s){return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[^\x20-\x7E]/g,c=>PDF_MARK[c]||PDF_SPELL[c]||'');},
 tw(s,size){return String(s==null?'':s).length*size*0.5;},
 twx(s,size,bold){
   s=String(s==null?'':s);
   const w=bold?PDF_W_B:PDF_W_N;let t=0;
   for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);
     if(c>=32&&c<=126){t+=w[c-32];continue;}
     const m=PDF_MARK_W[s[i]];
     if(m){t+=m[bold?1:0];continue;}
     const sp=PDF_SPELL[s[i]];
     if(sp)for(let k=0;k<sp.length;k++)t+=w[sp.charCodeAt(k)-32];
   }
   return t*size/1000;
 },
 text(x,y,s,size,bold,color){size=size||9;
   this.cur.ops.push('BT /'+(bold?'F2':'F1')+' '+size+' Tf '+(color||'0 0 0')+' rg '+x.toFixed(1)+' '+y.toFixed(1)+' Td ('+this.esc(s)+') Tj ET');},
 rect(x,y,w2,h2,fill){this.cur.ops.push((fill||'0.93 0.94 0.96')+' rg '+x.toFixed(1)+' '+y.toFixed(1)+' '+w2.toFixed(1)+' '+h2.toFixed(1)+' re f');},
 line(x1,y1,x2,y2){this.cur.ops.push('0.6 0.6 0.65 RG 0.5 w '+x1.toFixed(1)+' '+y1.toFixed(1)+' m '+x2.toFixed(1)+' '+y2.toFixed(1)+' l S');},
 rule(x1,y1,x2,y2,lw,col){this.cur.ops.push((col||'0 0 0')+' RG '+(lw||0.9)+' w '+x1.toFixed(1)+' '+y1.toFixed(1)+' m '+x2.toFixed(1)+' '+y2.toFixed(1)+' l S');},
 box(x,y,w2,h2,lw,col){this.cur.ops.push((col||'0 0 0')+' RG '+(lw||0.9)+' w '+x.toFixed(1)+' '+y.toFixed(1)+' '+w2.toFixed(1)+' '+h2.toFixed(1)+' re S');},
 textC(cx,y,s,size,bold,color){this.text(cx-this.twx(s,size,bold)/2,y,s,size,bold,color);},
 textR(xr,y,s,size,bold,color){this.text(xr-this.twx(s,size,bold),y,s,size,bold,color);},
 uText(x,y,s,size,bold,color){this.text(x,y,s,size,bold,color);this.rule(x,y-2.5,x+this.twx(s,size,bold),y-2.5,0.8,color||'0 0 0');},
 need(hpt){if(this.y-hpt<this.mB){this.newPage();return true;}return false;},
 fit(s,wpt,size){s=String(s==null?'':s);const maxc=Math.max(3,Math.floor(wpt/(size*0.5)));return s.length>maxc?s.slice(0,maxc-1)+'\u2026':s;},
 wrap(s,wpt,size,bold){
   s=String(s==null?'':s);if(!s)return [];
   const out=[];
   s.split(/\n/).forEach(para=>{
     let cur='';
     para.split(/\s+/).filter(w=>w!=='').forEach(w=>{
       const test=cur?cur+' '+w:w;
       if(this.twx(test,size,bold)<=wpt){cur=test;return;}
       if(cur){out.push(cur);cur='';}
       let long=w;
       while(this.twx(long,size,bold)>wpt){
         let n=1;while(n<long.length&&this.twx(long.slice(0,n+1),size,bold)<=wpt)n++;
         out.push(long.slice(0,n));long=long.slice(n);
       }
       cur=long;
     });
     out.push(cur);
   });
   return out;
 },
 parseJpegDims(bin){
   let iw=0,ih=0;
   for(let i=2;i<bin.length-9;){
     if(bin.charCodeAt(i)!==0xFF){i++;continue;}
     const m2=bin.charCodeAt(i+1);
     if(m2>=0xC0&&m2<=0xCF&&m2!==0xC4&&m2!==0xC8&&m2!==0xCC){ih=(bin.charCodeAt(i+5)<<8)|bin.charCodeAt(i+6);iw=(bin.charCodeAt(i+7)<<8)|bin.charCodeAt(i+8);break;}
     i+=2+((bin.charCodeAt(i+2)<<8)|bin.charCodeAt(i+3));
   }
   return [iw,ih];
 },
 imageAt(dataUrl,x,y,w,h){
   try{
     const b64=dataUrl.split(',')[1];const bin=atob(b64);
     const [iw,ih]=this.parseJpegDims(bin);
     if(!iw||!ih)return;
     const idx=this.imgs.length;this.imgs.push({bin,iw,ih});
     this.cur.ops.push('q '+w.toFixed(1)+' 0 0 '+h.toFixed(1)+' '+x.toFixed(1)+' '+y.toFixed(1)+' cm /Im'+idx+' Do Q');
     this.cur.imgs.push(idx);
   }catch(e){}
 },
 bytes(){
   const enc=s=>unescape(encodeURIComponent(s));
   const objs=[];const add=o=>{objs.push(o);return objs.length;};
   const fontN=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
   const fontB=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
   const imgIds=this.imgs.map(im=>add({stream:im.bin,dict:'<< /Type /XObject /Subtype /Image /Width '+im.iw+' /Height '+im.ih+' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+im.bin.length+' >>'}));
   const pageIds=[];const contentIds=[];
   this.pages.forEach((p,pi)=>{
     const foot=this.noFooter?'':('BT /F1 7 Tf 0.5 0.5 0.55 rg '+(this.w/2-30).toFixed(1)+' '+(this.mB-18)+' Td (Page '+(pi+1)+' of '+this.pages.length+' - Premier ERP) Tj ET');
     const cs=p.ops.join('\n')+(foot?'\n'+foot:'');
     const csBytes=enc(cs);
     contentIds.push(add({stream:csBytes,dict:'<< /Length '+csBytes.length+' >>'}));
   });
   const pagesId=objs.length+this.pages.length+1;
   this.pages.forEach((p,pi)=>{
     let xo=p.imgs.map(ii=>'/Im'+ii+' '+imgIds[ii]+' 0 R').join(' ');
     pageIds.push(add('<< /Type /Page /Parent '+pagesId+' 0 R /MediaBox [0 0 '+this.w+' '+this.h+'] /Contents '+contentIds[pi]+' 0 R /Resources << /Font << /F1 '+fontN+' 0 R /F2 '+fontB+' 0 R >>'+(xo?' /XObject << '+xo+' >>':'')+' >> >>'));
   });
   const pid=add('<< /Type /Pages /Kids ['+pageIds.map(i=>i+' 0 R').join(' ')+'] /Count '+pageIds.length+' >>');
   const cat=add('<< /Type /Catalog /Pages '+pid+' 0 R >>');

   let encDictId=null,idHex=null,fileKey=null;
   if(this._enc){
     const id0=md5(String(Date.now())+'|'+Math.random()+'|'+this.w+'x'+this.h);
     const P=-1; // no restrictions once opened — this is purely an "open password" gate
     const O=computeO(this._enc.userPassword,this._enc.ownerPassword);
     fileKey=computeEncryptionKey(this._enc.userPassword,O,P,id0);
     const U=computeU(fileKey);
     idHex=toHexString(id0);
     encDictId=add('<< /Filter /Standard /V 1 /R 2 /O '+toHexString(O)+' /U '+toHexString(U)+' /P '+P+' >>');
   }

   let body='%PDF-1.4\n';const offs=[0];
   objs.forEach((o,i)=>{
     offs.push(body.length);
     const objNum=i+1;
     let content;
     if(typeof o==='string'){content=o;}
     else{
       let streamData=o.stream;
       if(fileKey)streamData=rc4(strBytes(objectKey(fileKey,objNum,0)),streamData);
       content=o.dict+'\nstream\n'+streamData+'\nendstream';
     }
     body+=objNum+' 0 obj\n'+content+'\nendobj\n';
   });
   const xref=body.length;
   body+='xref\n0 '+(objs.length+1)+'\n0000000000 65535 f \n'+offs.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('');
   body+='trailer\n<< /Size '+(objs.length+1)+' /Root '+cat+' 0 R'+(encDictId?' /Encrypt '+encDictId+' 0 R /ID ['+idHex+' '+idHex+']':'')+' >>\nstartxref\n'+xref+'\n%%EOF';
   const bytes=Buffer.alloc(body.length);
   for(let i=0;i<body.length;i++)bytes[i]=body.charCodeAt(i)&0xFF;
   return bytes;
 }
};

module.exports = { PdfDoc };
