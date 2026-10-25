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
   entries.push({start:pos,duration,gesture:gestures(word.text),word:word.text,endIndex:word.index+word.text.length,index:word.index});
   pos+=duration;
   if(next){const between=text.slice(word.index+word.text.length,next.index);pos+=/[.!?…]/.test(between)?260:/[,;:]/.test(between)?100:0}
  }
  return {entries,total:Math.max(1,pos),text:String(text||'')};
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
 function captions(plan){
  const entries=plan?.entries||[];if(!entries.length)return [];
  const chunks=[];let words=[],begin=0;
  function finish(i){
   if(!words.length)return;
   const first=entries[begin],last=entries[i];
   const raw=plan.text.slice(first.index,last.endIndex).trim().replace(/\s+/g,' ');
   chunks.push({start:first.start,end:last.start+last.duration,text:raw});
   words=[];begin=i+1;
  }
  for(let i=0;i<entries.length;i++){
   const entry=entries[i],candidate=[...words,entry.word];
   if(words.length&&((candidate.join(' ').length>65)||words.length>=11))finish(i-1);
   if(!words.length)begin=i;
   words.push(entry.word);
   const between=(plan.text||'').slice(entry.endIndex,entries[i+1]?.index??(plan.text||'').length);
   if(i===entries.length-1||/[.!?…]\s*$/.test(between)&&words.join(' ').length>=25)finish(i);
  }
  return chunks;
 }
 function caption(plan,elapsedMs,totalMs){
  if(!plan?.entries?.length)return '';
  const groups=plan.captions||(plan.captions=captions(plan));
  if(!groups.length)return '';
  const duration=Number.isFinite(totalMs)&&totalMs>200?totalMs:plan.total;
  const logical=Math.max(0,elapsedMs)*(plan.total/duration);
  const chunk=groups.find(g=>logical>=g.start&&logical<=g.end)
   ||(logical<groups[0].start?groups[0]:groups.reduce((p,g)=>g.start<=logical?g:p,groups[0]));
  return chunk.text;
 }
 /*
  Subtítulos compactos de máximo dos líneas: cada palabra se hace visible cuando
  comienza su tiempo estimado dentro del MP3 de Fish. El avance usa
  HTMLAudioElement.currentTime y la duración real del clip, por lo que ni
  Fish ni Gemini necesitan marcas por palabra (que la API no entrega aquí).
  El ancho se mide con la fuente real para evitar los "..." y palabras cortadas.
 */
 function subtitlePages(plan,widthPx=300,measure){
  const items=plan?.entries||[];
  if(!items.length)return [];
  const width=Math.max(130,Number(widthPx)||300);
  if(plan.subtitleLayout?.width===width&&plan.subtitleLayout.pages)return plan.subtitleLayout.pages;
  const measureWidth=typeof measure==='function'?measure:s=>s.length*8.5;
  const lines=[];let line=[],current='';
  for(let i=0;i<items.length;i++){
   const entry=items[i],next=items[i+1];
   const suffix=(plan.text.slice(entry.endIndex,next?.index??plan.text.length).match(/^\s*[,;:.!?…¿¡]+/)||[])[0]||'';
   const token=entry.word+suffix.trim();
   const test=current?current+' '+token:token;
   if(line.length&&measureWidth(test)>width){
    lines.push(line);line=[];current='';
   }
   line.push({index:i,token});
   current=current?current+' '+token:token;
  }
  if(line.length)lines.push(line);
  const pages=[];
  for(let i=0;i<lines.length;i+=2){
   const part=lines.slice(i,i+2),first=part[0][0].index;
   const lastLine=part.at(-1),last=lastLine.at(-1).index;
   pages.push({first,last,lines:part});
  }
  plan.subtitleLayout={width,pages};
  return pages;
 }
 function subtitleAt(plan,positionMs,totalMs,widthPx,measure){
  const entries=plan?.entries||[];
  if(!entries.length)return '';
  const pages=subtitlePages(plan,widthPx,measure);
  const duration=Number.isFinite(totalMs)&&totalMs>250?totalMs:plan.total;
  const logical=Math.max(0,Number(positionMs)||0)*plan.total/duration;
  let current=0;
  for(let i=1;i<entries.length;i++){
   if(entries[i].start>logical)break;
   current=i;
  }
  const page=pages.find(p=>current>=p.first&&current<=p.last)||pages.at(-1);
  return page.lines.map(line=>line.filter(token=>token.index<=current).map(x=>x.token).join(' ')).filter(Boolean).join('\n');
 }
 window.PersonaLipSync={build,pose,caption,captions,subtitleAt,subtitlePages};
})();
