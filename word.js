import fs from 'node:fs/promises';
import {Document,Packer,Paragraph,TextRun,Table,TableRow,TableCell,AlignmentType,WidthType,BorderStyle} from 'docx';
import {cvContent,monthLabel} from './cv-layout.js';

// Word editable: mismo resumen ATS, sin foto, pensado para UNA página A4.
const BLACK='111111',FONT='Arial',W=9900;
const run=(value,{bold=false,size=20}={})=>new TextRun({text:String(value??''),font:FONT,color:BLACK,bold,size});
const p=(txt,{bold=false,size=20,after=65,before=0,align=AlignmentType.LEFT,left=0}={})=>
 new Paragraph({alignment:align,children:[run(txt,{bold,size})],spacing:{before,after,line:260},indent:{left},widowControl:true});
const heading=(txt)=>new Paragraph({
 children:[run(txt,{bold:true,size:23})],keepNext:true,
 border:{top:{style:BorderStyle.SINGLE,size:6,color:BLACK,space:5}},
 spacing:{before:135,after:70,line:270}
});
const bullet=txt=>p('•  '+txt,{size:19,after:35,left:220});
const none={style:BorderStyle.NONE,color:'FFFFFF',size:0};
const noBorders={top:none,bottom:none,left:none,right:none,insideHorizontal:none,insideVertical:none};
const cell=(txt,width,{bold=false,align=AlignmentType.LEFT}={})=>new TableCell({
 width:{size:width,type:WidthType.DXA},borders:noBorders,
 margins:{top:0,bottom:0,left:0,right:0},
 children:[p(txt,{bold,align,after:25,size:19})]
});
const dated=(left,right)=>new Table({
 width:{size:W,type:WidthType.DXA},columnWidths:[6100,3800],borders:noBorders,
 rows:[new TableRow({cantSplit:true,children:[
  cell(left,6100,{bold:true}),cell(right,3800,{align:AlignmentType.RIGHT})
 ]})]
});
const range=(s,e)=>[monthLabel(s),monthLabel(e)].filter(Boolean).join(' - ');
export async function createWordDocument(file,profile){
 const cv=cvContent(profile.fields),parts=[];
 parts.push(p(cv.name,{bold:true,size:43,align:AlignmentType.CENTER,after:60,before:80}));
 if(cv.roleLine)parts.push(p(cv.roleLine,{size:19,align:AlignmentType.CENTER,after:35}));
 if(cv.contactParts?.length)parts.push(p(cv.contactParts.join('  |  '),{size:17,align:AlignmentType.CENTER,after:140}));
 parts.push(heading('PERFIL PROFESIONAL'));
 parts.push(p(cv.profile,{size:19,after:80}));
 parts.push(heading('EXPERIENCIA LABORAL'));
 if(cv.firstExperience)parts.push(p('En búsqueda de primera experiencia laboral.',{size:19}));
 else for(const job of cv.experience.slice(0,2)){
  parts.push(dated(job.puesto,range(job.inicio,job.fin)));
  parts.push(p([job.lugar,job.ubicacion].filter(Boolean).join(', '),{size:19,after:45}));
  for(const task of job.actividades.slice(0,cv.experience.length===1?3:2))parts.push(bullet(task));
 }
 parts.push(heading('EDUCACIÓN'));
 if(cv.education.length)for(const school of cv.education.slice(0,2)){
  parts.push(dated(school.titulo,range(school.inicio,school.fin)));
  parts.push(p(school.institucion,{size:19,after:30}));
  if(school.estado)parts.push(p(school.estado,{size:18,after:40}));
 }else for(const line of cv.educationLegacy.slice(0,2))parts.push(p(line,{size:19,after:45}));
 if(cv.skills.length){
  parts.push(heading('APTITUDES'));
  for(const skill of cv.skills.slice(0,4))parts.push(bullet(skill));
 }
 if(cv.courses.length){
  parts.push(heading('CURSOS Y TALLERES'));
  for(const course of cv.courses.slice(0,2))parts.push(bullet(course));
 }
 const doc=new Document({
  creator:'NEXO CV',title:'Currículum vitae - '+cv.name,
  styles:{default:{document:{run:{font:FONT,size:19,color:BLACK},paragraph:{spacing:{line:260}}}}},
  sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:650,right:1000,bottom:650,left:1000}}},children:parts}]
 });
 await fs.writeFile(file,await Packer.toBuffer(doc));
}
