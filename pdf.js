import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import {DATA_DIR,getProfile,uid} from './db.js';
import {cvReadiness,cvContent} from './cv-layout.js';
import {createWordDocument} from './word.js';

// Inspirado en el modelo provisto: nombre y contactos centrados; grilla
// izquierda para títulos y derecha para información, sin foto ni adornos.
const TEAL='#476C73',INK='#22292B',MUTED='#40494D';
const LEFT=62,LABEL_W=161,CONTENT_X=228,RIGHT=536,CONTENT_W=RIGHT-CONTENT_X;
const PAGE_BOTTOM=786;
const clean=s=>String(s??'').trim();

function renderPdf(file,profile){
 const {name,contacts,sections}=cvContent(profile.fields);
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:0,autoFirstPage:true,
   info:{Title:'Currículum vitae - '+name,Author:'NEXO CV'}});
  const stream=fs.createWriteStream(file);
  let settled=false;
  const done=(err)=>{if(settled)return;settled=true;err?reject(err):resolve();};
  stream.on('finish',()=>done());stream.on('error',done);doc.on('error',done);
  doc.pipe(stream);
  doc.font('Helvetica-Bold').fillColor(TEAL);
  let titleSize=22;
  while(titleSize>15&&doc.widthOfString(name,{fontSize:titleSize})>480)titleSize--;
  doc.fontSize(titleSize).text(name,55,31,{width:485,align:'center',characterSpacing:.65});
  let hy=31+titleSize+17;
  doc.fillColor(INK).font('Helvetica').fontSize(10.5);
  for(const c of contacts){
   doc.text(c,LEFT,hy,{width:RIGHT-LEFT,align:'center',lineGap:1});
   hy=doc.y+2;
  }
  let y=Math.max(hy+22,120);
  const newPage=()=>{
   doc.addPage();y=55;
   doc.font('Helvetica-Bold').fontSize(9).fillColor(TEAL)
      .text(name,LEFT,28,{width:RIGHT-LEFT,align:'right'});
  };
  const fit=(height)=>{if(y+height>PAGE_BOTTOM)newPage();};
  const textHeight=(s,width=CONTENT_W,size=10.5,gap=3)=>doc.font('Helvetica')
    .fontSize(size).heightOfString(s,{width,lineGap:gap,breakLine:false});
  for(const section of sections){
   if(!section.text&&!(section.values?.length))continue;
   fit(48);
   const top=y;
   doc.fillColor(TEAL).font('Helvetica-Bold').fontSize(10.6)
     .text(section.label,LEFT,top,{width:LABEL_W,lineBreak:false});
   let cy=top;
   if(section.type==='text'){
    doc.fillColor(INK).font('Helvetica').fontSize(10.65);
    const t=clean(section.text);
    const h=doc.heightOfString(t,{width:CONTENT_W,lineGap:3});
    doc.text(t,CONTENT_X,cy,{width:CONTENT_W,lineGap:3});
    cy+=h;
   }else if(section.type==='skills'){
    const values=section.values,half=(CONTENT_W-17)/2;
    for(let k=0;k<values.length;k+=2){
     const a='•  '+values[k],b=values[k+1]?'•  '+values[k+1]:'';
     doc.font('Helvetica').fontSize(10.3);
     const ha=doc.heightOfString(a,{width:half,lineGap:3});
     const hb=b?doc.heightOfString(b,{width:half,lineGap:3}):0;
     const rh=Math.max(ha,hb,17)+2;
     if(cy+rh>PAGE_BOTTOM){newPage();cy=y;}
     doc.fillColor(INK).text(a,CONTENT_X,cy,{width:half,lineGap:3});
     if(b)doc.text(b,CONTENT_X+half+17,cy,{width:half,lineGap:3});
     cy+=rh;
    }
   }else{
    let priorIsBullet=false;
    for(const raw of section.values){
     const isBullet=/^(?:[•*\-]|\d+[.)])\s+/.test(raw);
     const str=isBullet?'•  '+raw.replace(/^(?:[•*\-]|\d+[.)])\s+/,''):raw.replace(/\s*\|\s*/g,' · ');
     doc.font(isBullet?'Helvetica':'Helvetica').fontSize(10.4);
     const h=doc.heightOfString(str,{width:isBullet?CONTENT_W-12:CONTENT_W,lineGap:3});
     if(cy+h+2>PAGE_BOTTOM){newPage();cy=y;}
     if(isBullet){
      doc.fillColor(INK).text(str,CONTENT_X+11,cy,{width:CONTENT_W-11,lineGap:3});
     }else{
      doc.fillColor(INK).text(str,CONTENT_X,cy,{width:CONTENT_W,lineGap:3});
     }
     cy+=h+(isBullet?2:5);
     priorIsBullet=isBullet;
    }
   }
   y=Math.max(cy,top+16)+22;
  }
  doc.end();
 });
}
export async function createDocument(profileId){
 const p=getProfile(profileId);
 if(!p)throw new Error('Perfil no encontrado.');
 const check=cvReadiness(p.fields);
 if(!check.ok)throw new Error('Todavía faltan datos para completar el CV: '+check.faltantes.map(x=>x.campo).join(', ')+'.');
 const stem=uid(),pdfFile=path.join(DATA_DIR,'cvs',stem+'.pdf'),wordFile=path.join(DATA_DIR,'cvs',stem+'.docx');
 try{
  await renderPdf(pdfFile,p);
  await createWordDocument(wordFile,p);
 }catch(e){
  for(const file of [pdfFile,wordFile])try{fs.unlinkSync(file)}catch{}
  throw e;
 }
 return {pdfFile,wordFile,filename:stem+'.pdf'};
}
