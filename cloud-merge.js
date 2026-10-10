/* Safe snapshot merge for the same private Persona Studio workspace. */
(function(){
 'use strict';
 const PROFILE='persona-studio-profiles-v3', INDEX='persona-studio-profile-index-v3';
 const TOPICS='persona-studio-duels-v1', BACKGROUNDS='persona-studio-backgrounds-v1';
 const GLOBAL='persona-studio-global-v3', MUSIC='music:background';
 const deep=value=>JSON.parse(JSON.stringify(value));
 const parse=(kv,key,fallback)=>{try{const value=JSON.parse(kv?.[key]||'null');return value===null?deep(fallback):value}catch{return deep(fallback)}};
 const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const has= (obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
 function meaningful(snapshot){
  if(!snapshot)return false;
  if(Object.keys(snapshot.assets||{}).length)return true;
  const kv=snapshot.kv||{},profiles=parse(kv,PROFILE,{}),index=parse(kv,INDEX,[]);
  if(index.some(p=>p.id!=='default'||(p.name&&p.name!=='Mi personaje')))return true;
  const def='Sos un personaje con una voz y una personalidad propias. Hablá de forma natural.';
  for(const [id,p] of Object.entries(profiles)){
   const cfg=p?.settings||{};
   if(id!=='default'||p?.history?.length)return true;
   if(cfg.persona&&cfg.persona!==def)return true;
   if(cfg.characterName&&cfg.characterName!=='Mi personaje')return true;
   if(cfg.fishTranscript||cfg.backgroundId||cfg.duelScale||cfg.voiceReferenceId||
      cfg.fishReferenceId||cfg.referenceId||cfg.referenceText)return true;
   if(cfg.voiceProvider&&cfg.voiceProvider!=='fish')return true;
   if(cfg.rate&&Number(cfg.rate)!==1)return true;
   if(cfg.pitch&&Number(cfg.pitch)!==1)return true;
  }
  const duels=parse(kv,TOPICS,{topics:[]});
  if(duels.topics?.some(t=>t.theme||t.messages?.length||t.left||t.right||(t.title&&t.title!=='Nueva temática')))return true;
  if(parse(kv,BACKGROUNDS,[]).length)return true;
  if(parse(kv,GLOBAL,{}).music?.name)return true;
  return false;
 }
 function merge(remote,local,options={}){
  // The remote version remains the canonical one. Conflicting local records are
  // preserved under new IDs instead of silently replacing originals.
  if(!remote)return {state:deep(local),forks:0};
  if(!local||(!options.base&&!meaningful(local)))return {state:deep(remote),forks:0};
  const result=deep(remote),lkv=local.kv||{},rkv=result.kv||{};
  result.kv=rkv;result.assets=result.assets||{};
  const ra=result.assets,la=local.assets||{};
  const rid=()=>('sync_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10));
  let forks=0;
  const rp=parse(rkv,PROFILE,{}),lp=parse(lkv,PROFILE,{});
  const brp=parse(options.base?.kv,PROFILE,{}),bra=options.base?.assets||{};
  const ri=parse(rkv,INDEX,[]),li=parse(lkv,INDEX,[]);
  const rb=parse(rkv,BACKGROUNDS,[]),lb=parse(lkv,BACKGROUNDS,[]);
  const rt=parse(rkv,TOPICS,{topics:[],activeId:null}),lt=parse(lkv,TOPICS,{topics:[],activeId:null});
  const bgMap={},profileMap={},topicMap={};
  const lAssetOf=id=>Object.keys(la).filter(k=>k.startsWith(id+':')).sort().map(k=>[k.slice(id.length+1),la[k]?.hash]);
  const rAssetOf=id=>Object.keys(ra).filter(k=>k.startsWith(id+':')).sort().map(k=>[k.slice(id.length+1),ra[k]?.hash]);
  for(const bg of lb){
   let id=bg.id;const existing=rb.find(item=>item.id===id);
   if(existing&&!equal(existing,bg)){
    if(!ra['bg:'+id])Object.assign(existing,deep(bg));
    else {id=rid();forks++}
   }
   bgMap[bg.id]=id;
   if(!rb.some(item=>item.id===id))rb.push({...deep(bg),id});
   const asset=la['bg:'+bg.id];
   if(asset&&(!ra['bg:'+id]||ra['bg:'+id].hash===asset.hash))ra['bg:'+id]=deep(asset);
   else if(asset&&ra['bg:'+id].hash!==asset.hash){
    const newId=rid();bgMap[bg.id]=newId;rb.push({...deep(bg),id:newId});ra['bg:'+newId]=deep(asset);forks++;
   }
  }
  const lindex=new Map(li.map(x=>[x.id,x]));
  const rindex=new Map(ri.map(x=>[x.id,x]));
  for(const [id,profile] of Object.entries(lp)){
   let target=id;
   if(has(rp,id)&&(!equal(rp[id],profile)||!equal(rAssetOf(id),lAssetOf(id)))){
    const cloudUnchanged=options.base&&equal(rp[id],brp[id])&&
     Object.keys(ra).filter(k=>k.startsWith(id+':')).every(k=>equal(ra[k],bra[k]));
    const existingEmpty=(!rp[id]?.history?.length)&&!Object.keys(rp[id]?.settings||{}).some(k=>['persona','fishTranscript','backgroundId'].includes(k)&&rp[id].settings[k]&&rp[id].settings[k]!=='Sos un personaje con una voz y una personalidad propias. Hablá de forma natural.');
    if(cloudUnchanged||(existingEmpty&&rAssetOf(id).length===0)){
     target=id;
    }else{
     target=rid();forks++;
    }
   }
   profileMap[id]=target;
   const copy=deep(profile);
   if(copy.settings?.backgroundId)copy.settings.backgroundId=bgMap[copy.settings.backgroundId]||copy.settings.backgroundId;
   if(target===id&&!has(rp,id))rp[id]=copy;
   else if(target!==id)rp[target]=copy;
   else if(!equal(rp[id],profile)&&(rAssetOf(id).length===0||
    (options.base&&equal(rp[id],brp[id]))))rp[id]=copy;
   const old=lindex.get(id)||{name:copy.settings?.characterName||'Personaje'};
   if(!rindex.has(target)){
    const item={...deep(old),id:target,name:target===id?old.name:((old.name||'Personaje')+' (otro dispositivo)').slice(0,75)};
    ri.push(item);rindex.set(target,item);
   }else if(target===id&&ri.find(x=>x.id===id)?.name==='Mi personaje'&&old.name!=='Mi personaje'){
    rindex.get(id).name=old.name;
   }
  }
  // Profiles can exist in the index even when there is no history/settings yet.
  for(const item of li){
   if(profileMap[item.id])continue;
   profileMap[item.id]=item.id;
   if(!rindex.has(item.id)){const copy=deep(item);ri.push(copy);rindex.set(copy.id,copy)}
  }
  for(const [key,asset] of Object.entries(la)){
   if(key===MUSIC)continue; // La música nunca crea versiones duplicadas.
   let target=key;
   if(key.startsWith('bg:')){
    const id=key.slice(3);target='bg:'+(bgMap[id]||id);
   }else{
    const split=key.indexOf(':');
    if(split>0){
     const id=key.slice(0,split);if(profileMap[id])target=profileMap[id]+key.slice(split);
    }else if(['aClosed','aOpen','idleClosed','idleOpen','oClosed','oOpen','eClosed','eOpen','voiceSample'].includes(key)){
     // Compatibility with legacy sprites saved without "default:" prefix.
     target=profileMap.default&&profileMap.default!=='default'?profileMap.default+':'+key:key;
    }
   }
   if(!has(ra,target)||ra[target]?.hash===asset.hash||
      (options.base&&equal(ra[target],bra[target])))ra[target]=deep(asset);
   else if(target===key){
    // Only possible if both devices used the same binary slot; keep both originals.
    const backup='archive_'+rid()+':'+key.replace(/[^a-zA-Z0-9_:-]/g,'_');
    ra[backup]=deep(asset);forks++;
   }
  }
  for(const topic of lt.topics||[]){
   let target=topic.id;const existing=(rt.topics||[]).find(x=>x.id===target);
   if(existing&&!equal(existing,topic)){
    const old=parse(options.base?.kv,TOPICS,{topics:[]}).topics?.find(t=>t.id===topic.id);
    if(!options.base||!equal(existing,old)){target=rid();forks++}
   }
   topicMap[topic.id]=target;
   if(existing&&target===topic.id){
    Object.assign(existing,deep(topic));
    if(existing.left)existing.left=profileMap[existing.left]||existing.left;
    if(existing.right)existing.right=profileMap[existing.right]||existing.right;
    continue;
   }
   const copy=deep(topic);copy.id=target;
   if(copy.left)copy.left=profileMap[copy.left]||copy.left;
   if(copy.right)copy.right=profileMap[copy.right]||copy.right;
   if(copy.leftBackgroundId)copy.leftBackgroundId=bgMap[copy.leftBackgroundId]||copy.leftBackgroundId;
   if(copy.rightBackgroundId)copy.rightBackgroundId=bgMap[copy.rightBackgroundId]||copy.rightBackgroundId;
   if(copy.stageBackgroundId)copy.stageBackgroundId=bgMap[copy.stageBackgroundId]||copy.stageBackgroundId;
   if(target!==topic.id)copy.title=((topic.title||'Tema')+' (otro dispositivo)').slice(0,100);
   rt.topics=rt.topics||[];rt.topics.push(copy);
  }
  if(!rt.activeId&&lt.activeId)rt.activeId=topicMap[lt.activeId]||lt.activeId;
  rkv[PROFILE]=JSON.stringify(rp);rkv[INDEX]=JSON.stringify(ri);
  rkv[TOPICS]=JSON.stringify(rt);rkv[BACKGROUNDS]=JSON.stringify(rb);
  for(const [k,v] of Object.entries(lkv)){
   if(!has(rkv,k)||options.base&&!has([PROFILE,INDEX,TOPICS,BACKGROUNDS].reduce((o,x)=>(o[x]=true,o),{}),k)&&
       (rkv[k]===options.base.kv?.[k]))rkv[k]=v;
  }
  // Pista global única: reemplazar o borrar según la última actualización.
  if(has(lkv,GLOBAL)){
   const localMusic=parse(lkv,GLOBAL,{}).music;
   if(localMusic&&typeof localMusic==='object'){
    const oldMusic=parse(options.base?.kv,GLOBAL,{}).music;
    const remoteMusic=parse(remote.kv,GLOBAL,{}).music;
    const changed=!options.base||!equal(localMusic,oldMusic)||
     (has(la,MUSIC)&&!equal(la[MUSIC],options.base.assets?.[MUSIC]));
    if(changed&&(Number(localMusic.updatedAt)||0)>=(Number(remoteMusic?.updatedAt)||0)){
     const settings=parse(rkv,GLOBAL,{});
     settings.music=deep(localMusic);rkv[GLOBAL]=JSON.stringify(settings);
     if(!localMusic.name)delete ra[MUSIC];
     else if(has(la,MUSIC))ra[MUSIC]=deep(la[MUSIC]);
    }
   }
  }
  return {state:result,forks};
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={merge,meaningful};
 if(typeof window!=='undefined')window.PERSONA_CLOUD_MERGE={merge,meaningful};
})();