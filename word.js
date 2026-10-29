import fs from 'node:fs/promises';
import {
 Document,Packer,Paragraph,TextRun,Table,TableRow,TableCell,
 AlignmentType,WidthType,BorderStyle
} from 'docx';
import {cvContent,monthLabel} from './cv-layout.js';

// Mismo estilo ATS del PDF: nombre centrado, texto negro, separadores horizontales.
const BLACK='111111',FONT='Arial',RULE='222222',TABLE_WIDTH=9850;
const run=(text,{bold=false,size=21}={})=>new TextRun({text:String(text??''),font:FONT,bold,size,color:BLACK});
const para=(text,{bold=false,size=21,after=95,before=0,align=AlignmentType.LEFT,indent=0}={})=>new Paragraph({
 alignment:align,
 children:[run(text,{bold,size})],
 spacing:{before,after,line:275},
 indent:{left:indent}
});
const heading=(text)=>new Paragraph({
 children:[run(text,{bold:true,size:26})],
 border:{top:{style:BorderStyle.SINGLE,size:9,color:RULE,space:10}},
 spacing:{before:235,after:135,line:285},
 keepNext:true
});
const bullet=(text)=>new Paragraph({
 children:[run('•  '+String(text),{size:21})],
 indent:{left:250,hanging:130},
 spacing:{after:65,line:285}
});
const none={style:BorderStyle.NONE,color:'FFFFFF',size:0};
const borderless={top:none,bottom:none,left:none,right:none,insideHorizontal:none,insideVertical:none};
const cell=(text,width,{bold=false,align=AlignmentType.LEFT}={})=>
 new TableCell({
  width:{size:width,type:WidthType.DXA},
  borders:borderless,
  margins:{top:0,bottom:0,left:0,right:0},
  children:[para(text,{bold,align,after:50,size:21})]
 });
const row=(left,right)=>new Table({
 width:{size:TABLE_WIDTH,type:WidthType.DXA},
 columnWidths:[6000,3850],
 borders:borderless,
 rows:[new TableRow({
  cantSplit:true,
  children:[cell(left,6000,{bold:true}),cell(right,3850,{align:AlignmentType.RIGHT})]
 })]
});
const period=(from,to)=>[monthLabel(from),monthLabel(to)].filter(Boolean).join(' - ');
export async function createWordDocument(file,profile){
 const cv=cvContent(profile.fields),children=[];
 children.push(new Paragraph({
  alignment:AlignmentType.CENTER,
  children:[run(cv.name,{bold:true,size:50})],
  spacing:{before:165,after:95,line:310}
 }));
 if(cv.roleLine)children.push(para(cv.roleLine,{align:AlignmentType.CENTER,size:22,after:35}));
 if(cv.contacts.length)children.push(para(cv.contacts.join(' - '),{align:AlignmentType.CENTER,size:20,after:245}));
 children.push(heading('PERFIL PROFESIONAL'));
 children.push(para(cv.profile,{after:160}));
 if(cv.skills.length){
  children.push(heading('APTITUDES'));
  for(const skill of cv.skills)children.push(bullet(skill));
 }
 children.push(heading('EXPERIENCIA LABORAL'));
 if(cv.firstExperience)children.push(para('En búsqueda de primera experiencia laboral.',{after:130}));
 else for(const exp of cv.experience){
  children.push(row(exp.puesto,period(exp.inicio,exp.fin)));
  const employer=[exp.lugar,exp.ubicacion].filter(Boolean).join(', ');
  if(employer)children.push(para(employer,{size:21,after:70}));
  if(exp.aproximada)children.push(para('Fechas aproximadas, confirmadas por la persona.',{size:17,after:45}));
  for(const task of exp.actividades)children.push(bullet(task));
  children.push(para('',{after:95}));
 }
 children.push(heading('EDUCACIÓN'));
 if(cv.education.length){
  for(const school of cv.education){
   children.push(row(school.titulo,period(school.inicio,school.fin)));
   if(school.institucion)children.push(para(school.institucion,{after:70}));
   if(school.estado)children.push(para(school.estado,{size:19,after:45}));
   if(school.aproximada&&school.inicio)children.push(para('Fechas aproximadas.',{size:17,after:40}));
  }
 }else for(const line of cv.educationLegacy)children.push(para(line,{after:85}));
 children.push(heading('IDIOMAS'));
 for(const language of cv.languages)children.push(bullet(language));
 if(cv.courses.length){
  children.push(heading('CURSOS Y TALLERES'));
  for(const course of cv.courses)children.push(bullet(course));
 }
 if(cv.others.length){
  children.push(heading('INFORMACIÓN ADICIONAL'));
  for(const text of cv.others)children.push(bullet(text));
 }
 const doc=new Document({
  creator:'NEXO CV',
  title:'Currículum vitae - '+cv.name,
  styles:{default:{document:{run:{font:FONT,size:21,color:BLACK},paragraph:{spacing:{line:275}}}}},
  sections:[{
   properties:{page:{size:{width:11906,height:16838},margin:{top:690,right:990,bottom:900,left:990}}},
   children
  }]
 });
 await fs.writeFile(file,await Packer.toBuffer(doc));
}
