import fs from 'node:fs/promises';
import {
 Document,Packer,Paragraph,TextRun,Table,TableRow,TableCell,
 AlignmentType,WidthType,BorderStyle
} from 'docx';
import {cvContent} from './cv-layout.js';

const TEAL='476C73',BLACK='22292B';
const none={style:BorderStyle.NONE,size:0,color:'FFFFFF'};
const noBorders={top:none,bottom:none,left:none,right:none,insideHorizontal:none,insideVertical:none};
const t=(value,opts={})=>new TextRun({text:String(value??''),font:'Arial',color:BLACK,size:21,...opts});
const paragraph=(text,{bold=false,after=70,indent=0}={})=>
 new Paragraph({children:[t(text,{bold})],spacing:{after,line:310},indent:{left:indent}});
const label=(text)=>new Paragraph({
 children:[t(text,{bold:true,size:21,color:TEAL})],
 spacing:{after:70,line:310}
});
const cell=(children,width)=>new TableCell({
 children:children.length?children:[paragraph('')],
 width:{size:width,type:WidthType.DXA},
 borders:noBorders,
 margins:{top:135,bottom:155,left:0,right:70}
});
const skillsTable=(arr)=>new Table({
 width:{size:6600,type:WidthType.DXA},columnWidths:[3260,3340],
 borders:noBorders,
 rows:Array.from({length:Math.ceil(arr.length/2)},(_,i)=>{
  const a=arr[2*i],b=arr[2*i+1];
  return new TableRow({children:[
   cell([paragraph('•  '+a,{after:105})],3260),
   cell([paragraph(b?'•  '+b:' ',{after:105})],3340)
  ]});
 })
});
function sectionBody(section){
 if(section.type==='text')return [paragraph(section.text,{after:40})];
 if(section.type==='skills')return [skillsTable(section.values)];
 return section.values.map((line,i)=>{
  const isBullet=/^(?:[•*\-]|\d+[.)])\s+/.test(line);
  const text=isBullet?'•  '+line.replace(/^(?:[•*\-]|\d+[.)])\s+/,''):line.replace(/\s*\|\s*/g,' · ');
  return paragraph(text,{after:isBullet?80:140,indent:isBullet?180:0});
 });
}
export async function createWordDocument(file,profile){
 const {name,contacts,sections}=cvContent(profile.fields);
 const heading=new Paragraph({
  alignment:AlignmentType.CENTER,
  children:[new TextRun({text:name,font:'Arial',bold:true,color:TEAL,size:43,characterSpacing:22})],
  spacing:{after:135,line:300}
 });
 const contact=contacts.map(value=>new Paragraph({
  alignment:AlignmentType.CENTER,children:[t(value,{size:20})],
  spacing:{after:45,line:275}
 }));
 const rows=sections.filter(s=>s.text||s.values?.length).map(section=>new TableRow({
  children:[
   cell([label(section.label)],2910),
   cell(sectionBody(section),6790)
  ]
 }));
 const grid=new Table({
  rows,
  borders:noBorders,
  width:{size:9700,type:WidthType.DXA},
  columnWidths:[2910,6790]
 });
 const doc=new Document({
  creator:'NEXO CV',
  title:'Currículum vitae - '+name,
  styles:{default:{document:{run:{font:'Arial',size:21,color:BLACK},paragraph:{spacing:{line:310}}}}},
  sections:[{
   properties:{page:{size:{width:11906,height:16838},margin:{top:650,right:1010,bottom:800,left:1196}}},
   children:[
    heading,...contact,
    new Paragraph({text:'',spacing:{after:200,line:80}}),
    grid
   ]
  }]
 });
 const bytes=await Packer.toBuffer(doc);
 await fs.writeFile(file,bytes);
}
