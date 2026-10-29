import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import {DATA_DIR,getProfile,uid} from './db.js';
import {cvReadiness,cvContent,monthLabel} from './cv-layout.js';
import {createWordDocument} from './word.js';

// Modelo ATS: una columna, tipografía negra, nombre centrado y líneas divisorias.
const INK='#111111',LEFT=52,RIGHT=543,WIDTH=RIGHT-LEFT,BOTTOM=788;
function renderPdf(file,profile){
 const cv=cvContent(profile.fields);
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:0,info:{Title:'Currículum vitae - '+cv.name,Author:'NEXO CV'}});
  const stream=fs.createWriteStream(file);doc.pipe(stream);
  stream.on('finish',resolve);stream.on('error',reject);doc.on('error',reject);
  const font=(bold=false,size=10.5)=>doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor(INK);
  let y=0;
  const more=(h=20)=>{
   if(y+h<=BOTTOM)return;
   doc.addPage();y=55;
  };
  const height=(text,w=WIDTH,size=10.5)=>{font(false,size);return doc.heightOfString(String(text),{width:w,lineGap:2});};
  const paragraph=(text,indent=0,size=10.5,extra=7)=>{
   const t=String(text||'').trim();if(!t)return;
   const w=WIDTH-indent,h=height(t,w,size);more(h+3);
   font(false,size).text(t,LEFT+indent,y,{width:w,lineGap:2});
   y+=h+extra;
  };
  const heading=(title)=>{
   more(62);
   doc.moveTo(LEFT,y).lineTo(RIGHT,y).strokeColor(INK).lineWidth(.9).stroke();
   y+=12;
   font(true,13.4).text(title,LEFT,y,{width:WIDTH});
   y+=30;
  };
  const period=(a,b)=>[monthLabel(a),monthLabel(b)].filter(Boolean).join(' - ');
  const dated=(title,dates)=>{
   const datesWidth=218,titleWidth=WIDTH-datesWidth-10;
   font(true,10.6);
   const h=doc.heightOfString(title,{width:titleWidth,lineGap:2});
   more(Math.max(h,18)+3);
   const rowY=y;
   font(true,10.6).text(title,LEFT,rowY,{width:titleWidth,lineGap:2});
   if(dates)font(false,10.2).text(dates,RIGHT-datesWidth,rowY,{width:datesWidth,align:'right',lineGap:2});
   y+=Math.max(h,15)+3;
  };
  const bullet=(text)=>{
   const t=String(text||'').trim();if(!t)return;
   const w=WIDTH-29,h=height(t,w,10.2);
   more(h+2);
   font(false,10.4).text('•',LEFT+7,y,{width:12});
   font(false,10.2).text(t,LEFT+26,y,{width:w,lineGap:2});
   y+=h+3;
  };
  // Cabecera visual del modelo aportado.
  const name=cv.name||'CURRÍCULUM VITAE';
  font(true,25);
  let size=25;while(size>16&&doc.widthOfString(name,{fontSize:size})>WIDTH)size--;
  doc.fontSize(size).text(name,LEFT,48,{width:WIDTH,align:'center'});
  y=48+size+10;
  if(cv.roleLine){font(false,11.1).text(cv.roleLine,LEFT,y,{width:WIDTH,align:'center'});y=doc.y+1;}
  if(cv.contacts.length){font(false,10.3).text(cv.contacts.join(' - '),LEFT,y,{width:WIDTH,align:'center'});y=doc.y+3;}
  y=Math.max(y+22,132);
  heading('PERFIL PROFESIONAL');
  paragraph(cv.profile,0,10.5,10);
  // El modelo no tiene aptitudes, pero se conserva la información de accesibilidad
  // recogida por el asistente, en el mismo estilo ATS.
  if(cv.skills.length){
   heading('APTITUDES');
   for(const skill of cv.skills)bullet(skill);
   y+=8;
  }
  heading('EXPERIENCIA LABORAL');
  if(cv.firstExperience){
   paragraph('En búsqueda de primera experiencia laboral.',0,10.5,10);
  }else{
   for(const exp of cv.experience){
    const dates=period(exp.inicio,exp.fin);
    dated(exp.puesto,dates);
    const place=[exp.lugar,exp.ubicacion].filter(Boolean).join(', ');
    if(place)paragraph(place,0,10.2,4);
    if(exp.aproximada)paragraph('Fechas aproximadas, confirmadas por la persona.',0,8.3,3);
    for(const task of exp.actividades)bullet(task);
    y+=13;
   }
  }
  heading('EDUCACIÓN');
  if(cv.education.length){
   for(const education of cv.education){
    dated(education.titulo,period(education.inicio,education.fin));
    if(education.institucion)paragraph(education.institucion,0,10.3,3);
    if(education.estado)paragraph(education.estado,0,9.7,3);
    if(education.aproximada&&education.inicio)paragraph('Fechas aproximadas.',0,8.3,3);
    y+=11;
   }
  }else{
   for(const line of cv.educationLegacy)paragraph(line,0,10.5,5);
  }
  heading('IDIOMAS');
  for(const language of cv.languages)bullet(language);
  y+=9;
  if(cv.courses.length){heading('CURSOS Y TALLERES');for(const course of cv.courses)bullet(course);y+=10;}
  if(cv.others.length){heading('INFORMACIÓN ADICIONAL');for(const extra of cv.others)bullet(extra);}
  doc.end();
 });
}
export async function createDocument(profileId){
 const p=getProfile(profileId);
 if(!p)throw new Error('Perfil no encontrado.');
 const readiness=cvReadiness(p.fields);
 if(!readiness.ok)throw new Error('Faltan datos para completar el CV: '+readiness.faltantes.map(x=>x.campo).join(', ')+'.');
 const stem=uid(),pdfFile=path.join(DATA_DIR,'cvs',stem+'.pdf'),wordFile=path.join(DATA_DIR,'cvs',stem+'.docx');
 try{
  await renderPdf(pdfFile,p);
  await createWordDocument(wordFile,p);
 }catch(err){
  for(const file of [pdfFile,wordFile])try{fs.unlinkSync(file)}catch{}
  throw err;
 }
 return {pdfFile,wordFile,filename:stem+'.pdf'};
}
