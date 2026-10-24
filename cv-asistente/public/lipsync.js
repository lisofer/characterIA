/* Texto y reloj de audio alineados siguiendo el enfoque de Persona Studio.
 * Sin timestamps fonéticos de Fish, la duración de las palabras se aproxima
 * y se reescala a la duración real del audio. No representa fonemas exactos.
 */
(function(){
 'use strict';
 const wordsOf=text=>[...String(text||'').matchAll(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu)].map(m=>({text:m[0],index:m.index}));
 const normalized=s=>String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ü/g,'u');
 function gestures(word){
  const groups=normalized(word).match(/[aeiou]+/g)||[];
  if(!groups.length)return [0];
  const choices=groups.map(group=>group.includes('a')?2:/[ou]/.test(group)?4:6);
  const primary=choices[Math.max(0,Math.floor((choices.length-1)*.55))];
  if(normalized(word).length>=9&&choices.length>=3&&choices.at(-1)!==primary)return [primary,choices.at(-1)];
  return [primary];
 }
 function build(text){
  const words=wordsOf(text),entries=[];let pos=0;
  for(let i=0;i<words.length;i++){
   const word=words[i], next=words[i+1];
   const duration=Math.max(150,Math.min(800,115+word.text.length*47));
   entries.push({start:pos,duration,gesture:gestures(word.text)});
   pos+=duration;
   if(next){const between=text.slice(word.index+word.text.length,next.index);pos+=/[.!?…]/.test(between)?260:/[,;:]/.test(between)?100:0}
  }
  return {entries,total:Math.max(1,pos)};
 }
 function pose(plan,positionMs,durationMs,opts={}){
  if(!plan?.entries?.length||!Number.isFinite(positionMs))return 0;
  const duration=Number.isFinite(durationMs)&&durationMs>200?durationMs:plan.total;
  const elapsed=(positionMs+(Number(opts.delay)||0))*plan.total/duration;
  let current=null;
  for(const entry of plan.entries){if(elapsed>=entry.start&&elapsed<entry.start+entry.duration){current=entry;break}}
  if(!current)return 0;
  const age=elapsed-current.start, dur=current.duration;
  const intensity=Math.min(.85,Math.max(.2,(Number(opts.intensity)||45)/100));
  const attack=Math.min(62,Math.max(20,dur*.11));
  const hold=Math.min(dur-attack-18,Math.max(95,Math.min(240,dur*(.32+intensity*.2))));
  if(age>=attack&&age<attack+hold)return current.gesture[0]||0;
  if(dur>390&&age>attack+hold+70&&age<Math.min(dur-16,attack+hold+70+Math.min(155,dur*.22)))return current.gesture[1]||current.gesture[0]||0;
  return 0;
 }
 window.PersonaLipSync={build,pose};
})();
