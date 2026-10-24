/* Repeat-safe transcript normalization for Web Speech API (browser + Node tests). */
(function(root){
 'use strict';
 const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
 const key=s=>String(s).toLocaleLowerCase('es-AR').replace(/[.,!?¿¡;:]+/g,'');
 function dedupe(text){
  let words=normalize(text).split(' ').filter(Boolean);
  if(words.length<2)return words.join(' ');
  // The browser may deliver expanding final results ("no" / "no tengo" /
  // "no tengo experiencia") as separate alternatives.
  for(let pass=0;pass<4;pass++){
   let changed=false;
   for(let size=Math.min(12,Math.floor(words.length/2));size>=2;size--){
    for(let start=0;start+size*2<=words.length;start++){
     if(words.slice(start,start+size).every((w,i)=>key(w)===key(words[start+size+i]))){
      words.splice(start+size,size);changed=true;start=Math.max(-1,start-size);
     }
    }
   }
   if(!changed)break;
  }
  // Natural double "no, no" is legitimate. Four+ consecutive identical
  // words generally indicate recognizer feedback or a stalled hypothesis.
  const result=[];
  for(const word of words){
   const last=key(result.at(-1)),previous=key(result.at(-2));
   if(last===key(word)&&previous===key(word))continue;
   result.push(word);
  }
  return result.join(' ').slice(0,850);
 }
 function snapshot(results){
  let segments=[];
  for(let i=0;i<(results?.length||0);i++){
   const piece=normalize(results[i]?.[0]?.transcript);
   if(!piece)continue;
   const lower=key(piece),prior=key(segments.at(-1)||'');
   if(prior&&lower.startsWith(prior)){segments[segments.length-1]=piece;continue}
   if(prior&&prior.startsWith(lower))continue;
   segments.push(piece);
  }
  return dedupe(segments.join(' '));
 }
 const api={dedupe,snapshot};
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root)root.SpeechInput=api;
})(typeof window!=='undefined'?window:null);
