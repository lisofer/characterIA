import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import {DATA_DIR,getProfile,saveDoc,uid} from './db.js';
const fieldNames={objetivo:'OBJETIVO LABORAL',perfil_profesional:'PERFIL',formacion:'FORMACIÓN',experiencia:'EXPERIENCIA',habilidades:'HABILIDADES',idiomas:'IDIOMAS',cursos:'CURSOS',otros:'INFORMACIÓN ADICIONAL'};
export async function createDocument(profileId){const p=getProfile(profileId);if(!p)throw new Error('Perfil no encontrado');if(!Object.keys(p.fields).length)throw new Error('No hay datos todavía para crear el CV');
 const filename=uid()+'.pdf';const file=path.join(DATA_DIR,'cvs',filename);
 await new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:55,info:{Title:'Currículum vitae'}});const stream=fs.createWriteStream(file);doc.pipe(stream);stream.on('finish',resolve);stream.on('error',reject);doc.on('error',reject);
  const f=p.fields;doc.fillColor('#16253e').font('Helvetica-Bold').fontSize(24).text([f.nombre,f.apellido].filter(Boolean).join(' ')||'CURRÍCULUM VITAE');doc.moveDown(.35);
  const contacts=[f.localidad,f.direccion,f.telefono,f.correo].filter(Boolean);if(contacts.length)doc.fillColor('#44546a').font('Helvetica').fontSize(10.5).text(contacts.join('  ·  '));
  doc.moveDown(.8).strokeColor('#d6e0ed').moveTo(55,doc.y).lineTo(540,doc.y).stroke();doc.moveDown(.7);
  for(const [key,label]of Object.entries(fieldNames)){if(!f[key])continue;doc.fillColor('#2458a5').font('Helvetica-Bold').fontSize(11).text(label);doc.moveDown(.3);doc.fillColor('#283b56').font('Helvetica').fontSize(10.7).text(f[key],{lineGap:3});doc.moveDown(.9);}
  doc.end();
 });const id=saveDoc(profileId,filename);return {id,file};}
