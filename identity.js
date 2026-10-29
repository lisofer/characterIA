const clean=s=>String(s??'').trim().replace(/\s+/g,' ');
const folded=s=>clean(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function normalizedIdentity(fields={}){
 let name=clean(fields.nombre),surname=clean(fields.apellido);
 if(surname&&folded(name).endsWith(' '+folded(surname))){
  name=clean(name.slice(0,name.length-surname.length));
 }
 if(!surname&&name.split(' ').length===2){
  [name,surname]=name.split(' ');
 }
 return {nombre:name,apellido:surname,nombreCompleto:[name,surname].filter(Boolean).join(' ')};
}
export function splitSimpleFullName(raw){
 const parts=clean(raw).split(' ').filter(Boolean);
 if(parts.length===2)return {nombre:parts[0],apellido:parts[1]};
 return null; // Tres o más componentes pueden incluir dos nombres o dos apellidos.
}
