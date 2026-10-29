import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import {DATA_DIR,getProfile,uid} from './db.js';
import {cvReadiness,cvContent,monthLabel} from './cv-layout.js';

// CV ATS de UNA sola página. El perfil completo se conserva en SQLite;
// en el archivo se imprime una selección resumida, sin inventar antecedentes.
const LEFT=51,RIGHT=544,WIDTH=RIGHT-LEFT,TOP=43,BOTTOM=792,INK='#111111';
const tidy=x=>String(x||'').replace(/\s+/g,' ').trim();
const truncate=(text,max)=>{const s=tidy(text);if(s.length<=max)return s;const z=s.slice(0,max);return z.slice(0,z.lastIndexOf(' '))+'…'};
function buildPdf(file,profile){
 const cv=cvContent(profile.fields);
 const roomy=cv.experience.length<=1&&cv.education.length<=1&&cv.skills.length<=4;
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:0,info:{Title:'Currículum vitae - '+cv.name,Author:'NEXO CV'}});
  const out=fs.createWriteStream(file);
  out.on('finish',resolve);out.on('error',reject);doc.on('error',reject);doc.pipe(out);
  let y=TOP;
  const font=(bold=false,size=10)=>doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor(INK);
  const h=(txt,width,size=10,bold=false)=>{font(bold,size);return doc.heightOfString(txt,{width,lineGap:1.6});};
  const fits=(amount)=>y+amount<=BOTTOM;
  const put=(txt,{size=10,bold=false,x=LEFT,width=WIDTH,gap=3,maxLines=3}={})=>{
   let t=tidy(txt);if(!t||!fits(size+2))return false;
   const maxHeight=Math.min(BOTTOM-y-2,Math.ceil(size*1.28*maxLines)+2);
   while(t.length>18&&h(t,width,size,bold)>maxHeight){
    const cut=t.lastIndexOf(' ',t.length-2);
    t=(cut>0?t.slice(0,cut):t.slice(0,-2)).replace(/…$/,'')+'…';
   }
   if(h(t,width,size,bold)>maxHeight)return false;
   font(bold,size).text(t,x,y,{width,lineGap:1.6});
   y+=h(t,width,size,bold)+gap;
   return true;
  };
  const heading=title=>{
   if(!fits(roomy?54:37))return false;
   y+=roomy?18:11;
   doc.moveTo(LEFT,y).lineTo(RIGHT,y).lineWidth(.8).strokeColor(INK).stroke();
   y+=roomy?13:9;
   font(true,roomy?13:12).text(title,LEFT,y,{width:WIDTH});
   y+=roomy?30:21;
   return true;
  };
  const range=(a,b)=>[monthLabel(a),monthLabel(b)].filter(Boolean).join(' - ');
  const dated=(title,period)=>{
   if(!fits(18))return false;
   let role=truncate(title,65);
   const col=WIDTH-200;
   while(role.length>18&&h(role,col,9.8,true)>15)role=truncate(role.slice(0,-3),role.length-3);
   font(true,9.8).text(role,LEFT,y,{width:col,lineGap:1});
   font(false,9.3).text(period,LEFT+col+5,y,{width:195,align:'right',lineGap:1});
   y+=18;return true;
  };
  const bullet=txt=>{
   if(!fits(roomy?20:15))return false;
   const x=LEFT+14,w=WIDTH-14;
   let t=truncate(txt,102);if(!t)return false;
   const size=roomy?10.7:9.6;
   const height=h('•  '+t,w,size);
   if(!fits(height+3))return false;
   font(false,size).text('•  '+t,x,y,{width:w,lineGap:1.6});
   y+=height+(roomy?5:2.5);return true;
  };
  // Cabecera: contexto de cada dato, separado por barra vertical.
  let titleSize=23;font(true,titleSize);
  while(titleSize>16&&doc.widthOfString(cv.name,{fontSize:titleSize})>WIDTH)titleSize--;
  font(true,titleSize).text(cv.name,LEFT,y,{width:WIDTH,align:'center'});
  y=TOP+titleSize+9;
  if(cv.roleLine){font(false,10.2).text(cv.roleLine,LEFT,y,{width:WIDTH,align:'center'});y+=15;}
  const contactLine=(cv.contactParts||[]).join('  |  ');
  if(contactLine){
   let size=9.5;font(false,size);
   const width=WIDTH;
   while(size>8&&doc.widthOfString(contactLine,{fontSize:size})>width)size-=.3;
   const lineHeight=h(contactLine,width,size);
   font(false,size).text(contactLine,LEFT,y,{width,align:'center',lineGap:1.4});
   y+=lineHeight+7;
  }
  y+=10;
  if(heading('PERFIL PROFESIONAL'))put(cv.profile,{size:roomy?11.1:10,maxLines:5,gap:roomy?8:4});
  if(heading('EXPERIENCIA LABORAL')){
   if(cv.firstExperience)put('En búsqueda de primera experiencia laboral.',{size:10,gap:4});
   else for(const job of cv.experience.slice(0,2)){
    if(!dated(job.puesto,range(job.inicio,job.fin)))break;
    put([job.lugar,job.ubicacion].filter(Boolean).join(', '),{size:9.6,gap:3,maxLines:1});
    for(const task of job.actividades.slice(0,cv.experience.length===1?3:2))if(!bullet(task))break;
    y+=fits(roomy?13:5)?(roomy?13:5):0;
   }
  }
  if(heading('EDUCACIÓN')){
   if(cv.education.length){
    for(const school of cv.education.slice(0,2)){
     if(!dated(school.titulo,range(school.inicio,school.fin)))break;
     put(school.institucion,{size:9.6,maxLines:1,gap:2});
     if(school.estado)put(school.estado,{size:9.1,maxLines:1,gap:2});
     y+=fits(roomy?13:5)?(roomy?13:5):0;
    }
   }else for(const line of cv.educationLegacy.slice(0,2))put(line,{size:9.8,maxLines:2,gap:4});
  }
  if(cv.skills.length&&fits(54)&&heading('APTITUDES')){
   // Elegir hasta cuatro, sin largas listas ni habilidades no confirmadas.
   for(const skill of cv.skills.slice(0,4))if(!bullet(skill))break;
  }
  if(cv.courses?.length&&fits(66)&&heading('CURSOS Y TALLERES'))
   for(const course of cv.courses.slice(0,2))if(!bullet(course))break;
  // No se crean páginas extra: los límites de CV resumido y de altura
  // aseguran una hoja con fuente legible, sin espacios que obliguen a paginar.
  doc.end();
 });
}
export async function createDocument(profileId){
 const p=getProfile(profileId);if(!p)throw new Error('Perfil no encontrado.');
 const ready=cvReadiness(p.fields);
 if(!ready.ok)throw new Error('Faltan datos del CV: '+ready.faltantes.map(f=>f.campo).join(', '));
 const stem=uid(),pdfFile=path.join(DATA_DIR,'cvs',stem+'.pdf');
 try{await buildPdf(pdfFile,p);}
 catch(error){try{fs.unlinkSync(pdfFile)}catch{};throw error;}
 return {pdfFile,filename:stem+'.pdf'};
}
