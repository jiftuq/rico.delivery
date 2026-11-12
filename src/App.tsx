import { useState, useEffect, useRef, useMemo, createContext, useContext } from "react";
import { Id } from "../convex/_generated/dataModel";
import { useUser, useGPS, useOpenTasks, useActiveTasks, useBids, useChat, useProfile, useStats, useTaskActions, useCourierTracking, useCourierHistory, usePosterHistory, useTaskRunners, useProofFiles, useProofUpload, useSavedWorkflows, useWorkflowActions, useFunds, useApiKeys, useConnectedApps } from "./hooks/useRico";
import { TILES, CATS, STS, fuzzLoc, maskAddr, haversine, getRoute } from "./lib/utils";
import { T, LANGS, Lang, TranslationKeys, detectLang } from "./lib/i18n";
import L from "leaflet";
import { connectWallet, switchWallet } from "./lib/wallet";
import { ensureSession, endSession, errMsg } from "./lib/session";
import ConsentView from "./Consent";

// Haptic feedback — graceful no-op on unsupported browsers (iOS Safari)
const hap={
  tap:()=>navigator.vibrate?.(10),
  light:()=>navigator.vibrate?.(25),
  medium:()=>navigator.vibrate?.(50),
  heavy:()=>navigator.vibrate?.(100),
  success:()=>navigator.vibrate?.([30,50,30]),
  double:()=>navigator.vibrate?.([25,40,25]),
  error:()=>navigator.vibrate?.([80,30,80,30,80]),
};

const LangCtx = createContext<(k: keyof TranslationKeys, ...args: string[]) => string>(() => "");
function useLang() { return useContext(LangCtx); }

const WalletCtx = createContext<{ walletAddr: string | null; connect: () => Promise<void> }>({ walletAddr: null, connect: async () => {} });
function useWalletCtx() { return useContext(WalletCtx); }

const CSS = `
@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes slideT{from{opacity:0;transform:translate(-50%,-14px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes livePulse{0%{box-shadow:0 0 0 0 rgba(255,208,0,0.4)}70%{box-shadow:0 0 0 8px rgba(255,208,0,0)}100%{box-shadow:0 0 0 0 rgba(255,208,0,0)}}
input:focus,textarea:focus,select:focus{outline:none;border-color:#00ff87!important;box-shadow:0 0 0 2px rgba(0,255,135,0.06)!important}
button{cursor:pointer;transition:all .12s;-webkit-tap-highlight-color:transparent}
button:active{transform:scale(.97)}
.dz-main{max-width:1120px;margin:0 auto;padding:0 12px 90px}
.dz-form-grid{display:grid;grid-template-columns:1fr;gap:10px;margin-top:14px}
.dz-steps-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:20px}
.dz-header-nav{display:none}
.dz-bottom-nav{position:fixed;bottom:0;left:0;right:0;z-index:1000;background:rgba(11,12,18,0.96);backdrop-filter:blur(20px);border-top:1px solid rgba(255,255,255,0.04);display:flex;padding:6px 8px calc(env(safe-area-inset-bottom,0px) + 6px)}
.dz-bottom-nav button{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;background:none;border:none;color:#4a4a5a;font-size:9px;padding:8px 4px;border-radius:8px;font-family:'Outfit',sans-serif}
.dz-bottom-nav button.active{color:#00ff87;background:rgba(0,255,135,0.04)}
.dz-bottom-nav button .ni{font-size:18px;line-height:1}
.dz-route-col{flex-direction:column;gap:4px}
.dz-rline-h{display:none}
.dz-rline-v{width:2px;height:14px;background:linear-gradient(180deg,#00ff87,#ff4757);border-radius:1px;margin-left:3px;display:block}
.dz-pricing-desk{display:none}
.dz-pricing-mob{display:flex;gap:8px;margin-top:6px;align-items:center;flex-wrap:wrap}
@media(min-width:640px){.dz-form-grid{grid-template-columns:1fr 1fr}.dz-steps-grid{grid-template-columns:repeat(3,1fr)}.dz-route-col{flex-direction:row;gap:8px}.dz-rline-h{display:block}.dz-rline-v{display:none}}
@media(min-width:900px){.dz-main{padding:0 18px 50px}.dz-header-nav{display:flex;gap:1px}.dz-bottom-nav{display:none}.dz-pricing-desk{display:block}.dz-pricing-mob{display:none}}
`;

function AddressMapPicker({label,value,lat,lng,onSelect,userLoc}:{label:string;value:string;lat:number;lng:number;onSelect:(addr:string,lat:number,lng:number)=>void;userLoc:[number,number]|null}){
  const ref=useRef<HTMLDivElement>(null);const mapRef=useRef<L.Map|null>(null);const markerRef=useRef<L.Marker|null>(null);
  const[q,setQ]=useState("");const[results,setResults]=useState<{display_name:string;lat:string;lon:string}[]>([]);const[searching,setSearching]=useState(false);const[open,setOpen]=useState(false);
  const center:[number,number]=lat&&lng?[lat,lng]:userLoc||[50.85,4.35];
  const reverseGeocode=async(lt:number,ln:number)=>{try{const r=await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lt}&lon=${ln}&zoom=18&addressdetails=1`);const d=await r.json();if(d.display_name)onSelect(d.display_name,lt,ln)}catch(e){onSelect(`${lt.toFixed(5)}, ${ln.toFixed(5)}`,lt,ln)}};
  const search=async()=>{if(!q.trim())return;setSearching(true);try{const r=await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5`);setResults(await r.json())}catch(e){}setSearching(false)};
  const pick=(r:{display_name:string;lat:string;lon:string})=>{const lt=parseFloat(r.lat),ln=parseFloat(r.lon);onSelect(r.display_name,lt,ln);setResults([]);setQ("");setOpen(false);if(mapRef.current){mapRef.current.setView([lt,ln],16);if(markerRef.current)markerRef.current.setLatLng([lt,ln])}};
  useEffect(()=>{if(!open||!ref.current)return;if(mapRef.current){try{mapRef.current.remove()}catch(e){}mapRef.current=null}
    const t=setTimeout(()=>{if(!ref.current)return;try{
      const m=L.map(ref.current,{zoomControl:false,attributionControl:false}).setView(center,14);
      L.tileLayer(TILES,{maxZoom:18}).addTo(m);L.control.zoom({position:"bottomright"}).addTo(m);mapRef.current=m;
      const mk=L.marker(center,{draggable:true,icon:L.divIcon({className:"",html:`<div style="width:22px;height:22px;border-radius:50%;background:#00ff87;border:3px solid #14151e;box-shadow:0 0 12px rgba(0,255,135,0.5);cursor:grab"></div>`,iconSize:[22,22],iconAnchor:[11,11]})}).addTo(m);
      markerRef.current=mk;mk.on("dragend",()=>{const p=mk.getLatLng();reverseGeocode(p.lat,p.lng)});
      m.on("click",(e:any)=>{mk.setLatLng(e.latlng);reverseGeocode(e.latlng.lat,e.latlng.lng)});
    }catch(e){}},60);
    return()=>{clearTimeout(t);if(mapRef.current){try{mapRef.current.remove()}catch(e){}mapRef.current=null}}
  },[open]);
  useEffect(()=>{if(mapRef.current&&markerRef.current&&lat&&lng){mapRef.current.setView([lat,lng],16);markerRef.current.setLatLng([lat,lng])}},[lat,lng]);
  return <div>
    <div style={{display:"flex",gap:6}}>
      <div style={{flex:1,position:"relative"}}>
        <input style={{...S.fInp,fontSize:14,padding:12,width:"100%"}} value={open?q:value} placeholder={label} onChange={e=>{setQ(e.target.value);if(!open)setOpen(true)}} onFocus={()=>setOpen(true)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();search()}}}/>
        {open&&results.length>0&&<div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:2000,background:"#14151e",border:"1px solid rgba(255,255,255,0.08)",borderRadius:10,overflow:"hidden",maxHeight:180,overflowY:"auto",boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>
          {results.map((r,i)=><button key={i} onClick={()=>pick(r)} style={{display:"block",width:"100%",textAlign:"left",padding:"10px 14px",background:"transparent",border:"none",borderBottom:"1px solid rgba(255,255,255,0.03)",color:"#aaa",fontSize:11,fontFamily:"'Outfit',sans-serif",cursor:"pointer"}} onMouseOver={e=>(e.currentTarget.style.background="rgba(0,255,135,0.05)")} onMouseOut={e=>(e.currentTarget.style.background="transparent")}>{r.display_name}</button>)}
        </div>}
      </div>
      <button style={{...S.gpsBtn,minWidth:48,minHeight:48,fontSize:12}} onClick={()=>{if(open)search();else setOpen(true)}}>{searching?"⏳":"🔍"}</button>
      <button style={{...S.gpsBtn,minWidth:48,minHeight:48}} onClick={()=>setOpen(!open)}>{open?"▲":"▼"}</button>
    </div>
    {value&&!open&&<div style={{fontSize:10,color:"#00ff87",marginTop:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>✓ {value.slice(0,60)}{value.length>60?"…":""}</div>}
    {open&&<div style={{marginTop:6}}>
      <div ref={ref} style={{width:"100%",height:200,borderRadius:12,overflow:"hidden",border:"1px solid rgba(255,255,255,0.05)"}}/>
      <div style={{fontSize:9,color:"#555",marginTop:4}}>Click or drag marker to set location</div>
    </div>}
  </div>;
}

function TaskMap({pickup,dropoff,privacyZone,courierLat,courierLng,bids,userLoc,showExact,tracking,h=240,singleLocation}:{pickup:{lat:number;lng:number;addr:string};dropoff:{lat:number;lng:number;addr:string};privacyZone:number;courierLat?:number;courierLng?:number;bids?:{name:string;lat:number;lng:number;fee:number;score:number}[];userLoc:[number,number]|null;showExact:boolean;tracking:boolean;h?:number;singleLocation?:boolean}){
  const ref=useRef<HTMLDivElement>(null);const mapRef=useRef<L.Map|null>(null);
  useEffect(()=>{if(!ref.current)return;if(mapRef.current){try{mapRef.current.remove()}catch(e){}mapRef.current=null}
    const t=setTimeout(()=>{if(!ref.current)return;try{
      const m=L.map(ref.current,{zoomControl:false,attributionControl:false,tap:true}).setView([pickup.lat,pickup.lng],14);
      L.tileLayer(TILES,{maxZoom:18}).addTo(m);L.control.zoom({position:"bottomright"}).addTo(m);mapRef.current=m;
      const ico=(c:string,s=14)=>L.divIcon({className:"",html:`<div style="width:${s}px;height:${s}px;border-radius:50%;background:${c};border:3px solid #14151e;box-shadow:0 0 10px ${c}44"></div>`,iconSize:[s,s],iconAnchor:[s/2,s/2]});
      if(singleLocation){
        // Single location mode for non-delivery tasks
        const fz=fuzzLoc(pickup.lat,pickup.lng,Math.round(pickup.lat*10000));
        L.circle([fz.lat,fz.lng],{radius:privacyZone,color:"#00ff87",fillColor:"#00ff87",fillOpacity:0.05,weight:1.5,dashArray:"6 4",opacity:0.35}).addTo(m);
        L.marker([fz.lat,fz.lng],{icon:L.divIcon({className:"",html:`<div style="width:28px;height:28px;border-radius:50%;background:rgba(0,255,135,0.12);border:2px dashed rgba(0,255,135,0.35);display:flex;align-items:center;justify-content:center"><div style="width:8px;height:8px;border-radius:50%;background:#00ff87"></div></div>`,iconSize:[28,28],iconAnchor:[14,14]})}).addTo(m);
        if(showExact)L.marker([pickup.lat,pickup.lng],{icon:ico("#00ff87",22)}).bindPopup(`<b style="color:#111">LOCATION</b><br/><span style="color:#555;font-size:12px">${pickup.addr}</span>`).addTo(m);
      }else{
        L.marker([pickup.lat,pickup.lng],{icon:ico("#00ff87",18)}).bindPopup(`<b style="color:#111">PICKUP</b><br/><span style="color:#555;font-size:12px">${pickup.addr}</span>`).addTo(m);
        const fz=fuzzLoc(dropoff.lat,dropoff.lng,Math.round(pickup.lat*10000));
        L.circle([fz.lat,fz.lng],{radius:privacyZone,color:"#ff4757",fillColor:"#ff4757",fillOpacity:0.05,weight:1.5,dashArray:"6 4",opacity:0.35}).addTo(m);
        L.marker([fz.lat,fz.lng],{icon:L.divIcon({className:"",html:`<div style="width:28px;height:28px;border-radius:50%;background:rgba(255,71,87,0.12);border:2px dashed rgba(255,71,87,0.35);display:flex;align-items:center;justify-content:center"><div style="width:8px;height:8px;border-radius:50%;background:#ff4757"></div></div>`,iconSize:[28,28],iconAnchor:[14,14]})}).addTo(m);
        if(showExact)L.marker([dropoff.lat,dropoff.lng],{icon:L.divIcon({className:"",html:`<div style="width:22px;height:22px;border-radius:50%;background:#ff4757;border:3px solid #14151e;box-shadow:0 0 12px rgba(255,71,87,0.5);display:flex;align-items:center;justify-content:center;font-size:11px">📍</div>`,iconSize:[22,22],iconAnchor:[11,11]})}).addTo(m);
      }
      bids?.forEach(b=>{L.marker([b.lat,b.lng],{icon:L.divIcon({className:"",html:`<div style="position:relative"><div style="width:18px;height:18px;border-radius:50%;background:#ffd000;border:2px solid #14151e"></div><div style="position:absolute;top:-20px;left:50%;transform:translateX(-50%);background:rgba(14,15,22,0.92);color:#ffd000;font-size:10px;padding:2px 8px;border-radius:4px;white-space:nowrap;font-family:monospace;font-weight:700">${b.name}</div></div>`,iconSize:[18,18],iconAnchor:[9,9]})}).addTo(m)});
      if(courierLat&&courierLng)L.marker([courierLat,courierLng],{icon:L.divIcon({className:"",html:`<div style="width:26px;height:26px;border-radius:50%;background:#00b4ff;border:3px solid #14151e;box-shadow:0 0 16px rgba(0,180,255,0.6);display:flex;align-items:center;justify-content:center;font-size:13px">🏃</div>`,iconSize:[26,26],iconAnchor:[13,13]})}).addTo(m);
      if(userLoc)L.marker(userLoc,{icon:ico("#a855f7",18)}).addTo(m);
      if(singleLocation){
        const pts:any[]=[[pickup.lat,pickup.lng]];
        if(courierLat&&courierLng)pts.push([courierLat,courierLng]);
        bids?.forEach(b=>pts.push([b.lat,b.lng]));if(userLoc)pts.push(userLoc);
        if(courierLat&&courierLng){
          getRoute([[courierLat,courierLng],[pickup.lat,pickup.lng]]).then(r=>{if(!r?.geo||!mapRef.current)return;
            L.polyline(r.geo,{color:"#00b4ff",weight:4,opacity:0.8}).addTo(m);
            const mid=r.geo[Math.floor(r.geo.length/2)];
            L.marker(mid,{icon:L.divIcon({className:"",html:`<div style="background:rgba(14,15,22,0.92);color:#00b4ff;padding:5px 12px;border-radius:8px;font-size:11px;font-family:monospace;font-weight:700;border:1px solid rgba(255,255,255,0.1);white-space:nowrap">${r.km} km · ~${r.min} min</div>`,iconSize:[110,24],iconAnchor:[55,12]}),interactive:false}).addTo(m)});
        }else if(userLoc){
          getRoute([userLoc,[pickup.lat,pickup.lng]]).then(r=>{if(!r?.geo||!mapRef.current)return;
            L.polyline(r.geo,{color:"#00ff87",weight:3,opacity:0.6,dashArray:"8 6"}).addTo(m);
            const mid=r.geo[Math.floor(r.geo.length/2)];
            L.marker(mid,{icon:L.divIcon({className:"",html:`<div style="background:rgba(14,15,22,0.92);color:#00ff87;padding:5px 12px;border-radius:8px;font-size:11px;font-family:monospace;font-weight:700;border:1px solid rgba(255,255,255,0.1);white-space:nowrap">${r.km} km · ~${r.min} min</div>`,iconSize:[110,24],iconAnchor:[55,12]}),interactive:false}).addTo(m)});
        }
        if(pts.length>1)m.fitBounds(L.latLngBounds(pts).pad(0.15));
      }else{
        const tgt:[number,number]=showExact?[dropoff.lat,dropoff.lng]:[fuzzLoc(dropoff.lat,dropoff.lng,Math.round(pickup.lat*10000)).lat,fuzzLoc(dropoff.lat,dropoff.lng,Math.round(pickup.lat*10000)).lng];
        const rp:[number,number][]=courierLat&&courierLng?[[courierLat,courierLng],[pickup.lat,pickup.lng],tgt]:[[pickup.lat,pickup.lng],tgt];
        getRoute(rp).then(r=>{if(!r?.geo||!mapRef.current)return;
          L.polyline(r.geo,{color:tracking?"#00b4ff":"#00ff87",weight:tracking?4:3,opacity:tracking?0.8:0.6,dashArray:tracking?undefined:"8 6"}).addTo(m);
          const mid=r.geo[Math.floor(r.geo.length/2)];
          L.marker(mid,{icon:L.divIcon({className:"",html:`<div style="background:rgba(14,15,22,0.92);color:${tracking?"#00b4ff":"#00ff87"};padding:5px 12px;border-radius:8px;font-size:11px;font-family:monospace;font-weight:700;border:1px solid rgba(255,255,255,0.1);white-space:nowrap">${r.km} km · ~${r.min} min</div>`,iconSize:[110,24],iconAnchor:[55,12]}),interactive:false}).addTo(m);
          const fz2=fuzzLoc(dropoff.lat,dropoff.lng,Math.round(pickup.lat*10000));
          const pts:any[]=[[pickup.lat,pickup.lng],[fz2.lat,fz2.lng]];
          if(showExact)pts.push([dropoff.lat,dropoff.lng]);if(courierLat&&courierLng)pts.push([courierLat,courierLng]);
          bids?.forEach(b=>pts.push([b.lat,b.lng]));if(userLoc)pts.push(userLoc);
          if(pts.length>1)m.fitBounds(L.latLngBounds(pts).pad(0.15))});
      }
    }catch(e){}},60);
    return()=>{clearTimeout(t);if(mapRef.current){try{mapRef.current.remove()}catch(e){}mapRef.current=null}}
  },[pickup.lat,dropoff.lat,courierLat,courierLng,showExact,bids?.length,tracking,singleLocation]);
  return <div ref={ref} style={{width:"100%",height:h,borderRadius:14,overflow:"hidden",border:"1px solid rgba(255,255,255,0.05)"}}/>;
}

function ChatPanel({taskId,myRole}:{taskId:Id<"tasks">;myRole:string}){
  const t=useLang();const{messages,send}=useChat(taskId);const[msg,setMsg]=useState("");const endRef=useRef<HTMLDivElement>(null);
  const proofFiles=useProofFiles(taskId);const[viewMedia,setViewMedia]=useState<{url:string;type:string}|null>(null);
  // Merge messages and proofs into a single timeline
  const timeline=useMemo(()=>{
    const items:(({kind:"msg"}&any)|({kind:"proof"}&any))[]=[];
    messages.forEach(m=>items.push({kind:"msg",...m}));
    proofFiles.forEach(p=>items.push({kind:"proof",...p}));
    items.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
    return items;
  },[messages,proofFiles]);
  useEffect(()=>{endRef.current?.scrollIntoView({behavior:"smooth"})},[timeline.length]);
  const doSend=()=>{if(!msg.trim())return;hap.light();send(msg.trim());setMsg("")};
  return <div style={{borderRadius:12,border:"1px solid rgba(255,255,255,0.04)",overflow:"hidden"}}>
    <div style={{padding:"10px 14px",background:"rgba(255,255,255,0.02)",borderBottom:"1px solid rgba(255,255,255,0.03)",fontSize:13,fontWeight:600,color:"#fff"}}>💬 {t("chat")}</div>
    <div style={{maxHeight:340,overflowY:"auto",padding:"10px 14px",WebkitOverflowScrolling:"touch"}}>
      {timeline.length===0&&<div style={S.empty}>{t("no_messages")}</div>}
      {timeline.map((item,i)=>item.kind==="msg"?<div key={"m"+i} style={{maxWidth:"85%",padding:"10px 14px",borderRadius:14,marginBottom:6,...(item.role===myRole?{background:"rgba(0,255,135,0.06)",borderBottomRightRadius:4,marginLeft:"auto"}:{background:"rgba(255,255,255,0.03)",borderBottomLeftRadius:4})}}>
        <div style={{fontSize:10,fontWeight:600,color:"#666",marginBottom:2}}>{item.senderName}</div>
        <div style={{fontSize:13,color:"#ddd",lineHeight:1.5}}>{item.text}</div></div>
      :<div key={"p"+i} style={{maxWidth:"85%",padding:8,borderRadius:14,marginBottom:6,background:"rgba(168,85,247,0.08)",border:"1px solid rgba(168,85,247,0.15)",borderBottomLeftRadius:4}}>
        <div style={{fontSize:10,fontWeight:600,color:"#a855f7",marginBottom:4}}>📸 Proof{item.stepOrder!=null?` · Step ${item.stepOrder+1}`:""}</div>
        {item.fileType?.startsWith("image")?<img src={item.url} style={{width:"100%",maxWidth:240,borderRadius:8,cursor:"pointer"}} alt={item.caption||"proof"} onClick={()=>setViewMedia({url:item.url,type:"image"})}/>
        :item.fileType?.startsWith("video")?<video src={item.url} style={{width:"100%",maxWidth:240,borderRadius:8}} controls playsInline onClick={()=>setViewMedia({url:item.url,type:"video"})}/>
        :<div style={{fontSize:11,color:"#a855f7"}}>📄 {item.fileName}</div>}
        {item.caption&&<div style={{fontSize:11,color:"#999",marginTop:4}}>{item.caption}</div>}
      </div>)}
      <div ref={endRef}/>
    </div>
    <div style={{display:"flex",gap:8,padding:"10px 12px",background:"rgba(255,255,255,0.015)",borderTop:"1px solid rgba(255,255,255,0.03)"}}>
      <input style={{...S.fInp,flex:1,fontSize:14,padding:"12px 14px"}} placeholder={t("message_ph")} value={msg} onChange={e=>setMsg(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSend()}/>
      <button style={{width:44,height:44,borderRadius:10,border:"none",background:"#00ff87",color:"#000",fontSize:18,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}} onClick={doSend}>↑</button>
    </div>
    {viewMedia&&<div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.9)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={()=>setViewMedia(null)}>
      {viewMedia.type==="image"?<img src={viewMedia.url} style={{maxWidth:"95%",maxHeight:"90vh",borderRadius:12}} alt="proof"/>
      :<video src={viewMedia.url} style={{maxWidth:"95%",maxHeight:"90vh",borderRadius:12}} controls autoPlay playsInline/>}
      <button style={{position:"absolute",top:20,right:20,background:"rgba(255,255,255,0.1)",border:"none",color:"#fff",fontSize:24,width:44,height:44,borderRadius:22,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setViewMedia(null)}>✕</button>
    </div>}
  </div>;
}

function RatingModal({name,onRate,onClose}:{name:string;onRate:(s:number,c:string)=>void;onClose:()=>void}){
  const t=useLang();const[score,setScore]=useState(5);const[text,setText]=useState("");
  return <div style={S.overlay} onClick={onClose}><div style={{background:"#14151e",borderRadius:18,padding:"28px 20px",maxWidth:360,width:"92%",border:"1px solid rgba(255,255,255,0.06)"}} onClick={e=>e.stopPropagation()}>
    <div style={{fontSize:20,fontWeight:700,color:"#fff",textAlign:"center",marginBottom:14}}>{t("rate")} {name}</div>
    <div style={{display:"flex",justifyContent:"center",gap:10,marginBottom:14}}>
      {[1,2,3,4,5].map(n=><button key={n} onClick={()=>{hap.tap();setScore(n)}} style={{background:"none",border:"none",fontSize:36,color:n<=score?"#ffd000":"#2a2a3a",padding:4,minWidth:44,minHeight:44}}>★</button>)}
    </div>
    <textarea style={{...S.fInp,minHeight:70,fontSize:14,marginBottom:14}} placeholder={t("review_ph")} value={text} onChange={e=>setText(e.target.value)}/>
    <button style={{...S.postBtn,background:"linear-gradient(135deg,#ffd000,#ff8c00)"}} onClick={()=>{hap.success();onRate(score,text);onClose()}}>{t("submit")}</button>
    <button style={{...S.postBtn,marginTop:8,background:"transparent",border:"1px solid rgba(255,255,255,0.06)",color:"#555"}} onClick={onClose}>{t("skip")}</button>
  </div></div>;
}

function ProfilePopup({profile,onClose}:{profile:any;onClose:()=>void}){
  const t=useLang();
  const courierHist=useCourierHistory(profile.deliveries>0?profile._id:null);
  const posterHist=usePosterHistory(profile.tasksPosted>0?profile._id:null);
  const totalKm=courierHist.reduce((s:number,h:any)=>s+h.tripKm,0);
  const totalEarned=courierHist.filter((h:any)=>h.status==="completed").reduce((s:number,h:any)=>s+h.acceptedFee,0);
  return <div style={{...S.escBox,marginTop:10}}>
    <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:15,fontWeight:700,color:"#fff"}}>{profile.displayName}</span><button style={{background:"none",border:"none",color:"#555",fontSize:16}} onClick={onClose}>✕</button></div>
    <div style={{display:"flex",gap:10,marginTop:8}}>
      <div style={S.pStat}><div style={S.pStatN}>★{profile.score}</div><div style={S.pStatL}>{t("rating")}</div></div>
      <div style={S.pStat}><div style={S.pStatN}>{profile.deliveries}</div><div style={S.pStatL}>{t("runs")}</div></div>
      <div style={S.pStat}><div style={S.pStatN}>{profile.tasksPosted}</div><div style={S.pStatL}>{t("posted_stat")}</div></div>
    </div>
    {profile.reviews?.slice(0,3).map((r:any,i:number)=><div key={i} style={{padding:"8px 0",borderTop:"1px solid rgba(255,255,255,0.03)",fontSize:12,color:"#888"}}><span style={{color:"#ffd000"}}>{"★".repeat(r.score)}</span> {r.comment} <span style={{color:"#444"}}>— {r.raterName}</span></div>)}
    {courierHist.length>0&&<div style={{marginTop:10}}>
      <div style={{fontSize:11,fontWeight:700,color:"#00ff87",marginBottom:6}}>🚴 {t("delivery_history")} ({courierHist.length})</div>
      <div style={{fontSize:10,color:"#666",marginBottom:6}}>{totalKm.toFixed(1)} {t("km")} · ${totalEarned.toFixed(2)} {t("earned")}</div>
      {courierHist.slice(0,5).map((h:any)=><div key={h._id} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderTop:"1px solid rgba(255,255,255,0.02)",fontSize:11}}>
        <span style={{color:"#777"}}>{h.tripKm.toFixed(1)} {t("km")}</span>
        <span style={{color:h.status==="completed"?"#00ff87":"#ff4757",fontFamily:"monospace"}}>${h.acceptedFee.toFixed(2)}</span>
      </div>)}
    </div>}
    {posterHist.length>0&&<div style={{marginTop:10}}>
      <div style={{fontSize:11,fontWeight:700,color:"#0052ff",marginBottom:6}}>📝 {t("post_history")} ({posterHist.length})</div>
      {posterHist.slice(0,5).map((h:any)=><div key={h._id} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderTop:"1px solid rgba(255,255,255,0.02)",fontSize:11}}>
        <span style={{color:"#777"}}>{h.title}</span>
        <span style={{color:h.status==="completed"?"#00ff87":"#ff4757",fontFamily:"monospace"}}>${h.totalEscrowed.toFixed(2)}</span>
      </div>)}
    </div>}
    {courierHist.length===0&&posterHist.length===0&&<div style={{fontSize:11,color:"#333",marginTop:8,textAlign:"center"}}>{t("no_history")}</div>}
  </div>;
}

function TaskCard({task,userLoc}:{task:any;userLoc:[number,number]|null}){
  const t=useLang();const{walletAddr,connect}=useWalletCtx();const{user,userId,token}=useUser(walletAddr);const bids=useBids(task._id);const actions=useTaskActions();const{ensureFunds}=useFunds();
  const[open,setOpen]=useState(false);const[tab,setTab]=useState<"details"|"chat">("details");
  const[bidFee,setBidFee]=useState("");const[bidComment,setBidComment]=useState("");
  const[showRating,setShowRating]=useState<{name:string;runnerId?:string}|null>(null);const[profileId,setProfileId]=useState<Id<"users">|null>(null);
  const[routeKm,setRouteKm]=useState<string|null>(null);const[proofText,setProofText]=useState("");const[uploading,setUploading]=useState(false);
  const profile=useProfile(profileId);const st=STS[task.status]||STS.open;
  const proofFiles=useProofFiles(task._id);const{upload:uploadProof}=useProofUpload();
  const filePhotoBackRef=useRef<HTMLInputElement>(null);
  const filePhotoFrontRef=useRef<HTMLInputElement>(null);
  const fileVideoBackRef=useRef<HTMLInputElement>(null);
  const fileVideoFrontRef=useRef<HTMLInputElement>(null);
  const[showProofMenu,setShowProofMenu]=useState(false);
  const isDel=!task.taskType||task.taskType==="delivery";
  const maxR=task.maxRunners||1;const multi=maxR>1;
  const taskRunners=useTaskRunners(multi?task._id:null);
  const isOwner=userId&&task.posterId===userId;
  const isCourier=multi?(taskRunners.some((tr:any)=>tr.runnerId===userId)):(userId&&task.courierId===userId);
  const canSee=isOwner||isCourier;const isTracking=(task.status==="in_progress")&&canSee;
  const chatActive=task.status==="in_progress"||task.status==="delivered";
  const itemCost=task.itemCost||0;const total=itemCost+(task.acceptedFee??task.suggestedFee);
  const locLat=isDel?task.pickupLat:(task.locationLat||task.pickupLat);const locLng=isDel?task.pickupLng:(task.locationLng||task.pickupLng);const locAddr=isDel?task.pickupAddr:(task.locationAddr||task.pickupAddr||"");
  const myTrStatus=multi?taskRunners.find((tr:any)=>tr.runnerId===userId)?.status:null;
  const isActiveRunner=multi?(myTrStatus==="accepted"):!!isCourier;
  useCourierTracking(isTracking&&isActiveRunner?task._id:null,!!isTracking&&isActiveRunner);
  useEffect(()=>{if(!open||!userLoc||task.status!=="open")return;if(isDel){getRoute([[userLoc[0],userLoc[1]],[task.pickupLat,task.pickupLng],[task.dropoffLat,task.dropoffLng]]).then(r=>r&&setRouteKm(r.km))}else{getRoute([[userLoc[0],userLoc[1]],[locLat,locLng]]).then(r=>r&&setRouteKm(r.km))}},[open,userLoc]);
  const bidMap=bids.filter((b:any)=>b.lat&&b.lng).map((b:any)=>({name:b.courierName,lat:b.lat,lng:b.lng,fee:b.fee,score:b.courierScore}));
  const submitBid=async()=>{if(!bidFee||!token||!userLoc)return;let tripKm:number;if(isDel){const route=await getRoute([[userLoc[0],userLoc[1]],[task.pickupLat,task.pickupLng],[task.dropoffLat,task.dropoffLng]]);tripKm=route?parseFloat(route.km):Math.round((haversine(userLoc,[task.pickupLat,task.pickupLng])+haversine([task.pickupLat,task.pickupLng],[task.dropoffLat,task.dropoffLng]))*10)/10}else{const route=await getRoute([[userLoc[0],userLoc[1]],[locLat,locLng]]);tripKm=route?parseFloat(route.km):Math.round(haversine(userLoc,[locLat,locLng])*10)/10}try{await actions.placeBid({token,taskId:task._id,fee:parseFloat(bidFee),comment:bidComment||"Ready!",lat:userLoc[0],lng:userLoc[1],tripKm});hap.success();setBidFee("");setBidComment("")}catch(e:any){hap.error();alert(errMsg(e))}};
  // A bid above the suggested fee costs the poster the difference: top up the balance first if needed.
  const doAcceptBid=async(bidId:string)=>{if(!walletAddr||!token){await connect();return;}try{const bid=bids.find((b:any)=>b._id===bidId);const extra=bid?(multi?bid.fee-task.suggestedFee:(task.itemCost||0)+bid.fee-task.totalEscrowed):0;if(extra>0)await ensureFunds(extra);await actions.acceptBid({token,taskId:task._id,bidId:bidId as Id<"bids">});hap.double()}catch(e:any){hap.error();alert(errMsg(e))}};
  const doCancel=async()=>{hap.medium();if(!token)return;if(!confirm(`Cancel task? $${total.toFixed(2)} USDC goes back to your RICO balance.`))return;try{await actions.cancelTask({token,taskId:task._id});hap.heavy()}catch(e:any){hap.error();alert(errMsg(e))}};
  const doSubmitProof=()=>{if(!isCourier||!token)return;hap.success();actions.markDelivered({token,taskId:task._id,proofData:proofText||undefined}).catch((e:any)=>alert(errMsg(e)));setProofText("")};
  const doUploadFile=async(e:any)=>{const file=e.target.files?.[0];if(!file||!token)return;hap.light();setUploading(true);try{await uploadProof(file,task._id);hap.success()}catch(err:any){hap.error();alert(errMsg(err))}finally{setUploading(false);[filePhotoBackRef,filePhotoFrontRef,fileVideoBackRef,fileVideoFrontRef].forEach(r=>{if(r.current)r.current.value=""});setShowProofMenu(false)}};
  const ProofMenu=({btnStyle}:{btnStyle:any})=><div style={{position:"relative",display:"inline-block"}}>
    <button style={btnStyle} onClick={(e)=>{e.stopPropagation();hap.tap();setShowProofMenu(!showProofMenu)}}>{uploading?"⏳":"📎 Proof"}</button>
    {showProofMenu&&<div style={{position:"absolute",bottom:"110%",left:0,zIndex:999,background:"#1a1a2e",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:6,display:"flex",flexDirection:"column",gap:4,minWidth:150,boxShadow:"0 8px 24px rgba(0,0,0,0.6)"}} onClick={e=>e.stopPropagation()}>
      <button style={{...S.bidAccBtn,fontSize:11,padding:"8px 12px",textAlign:"left",minHeight:0}} onClick={()=>filePhotoBackRef.current?.click()}>📷 Photo (back cam)</button>
      <button style={{...S.bidAccBtn,fontSize:11,padding:"8px 12px",textAlign:"left",minHeight:0}} onClick={()=>filePhotoFrontRef.current?.click()}>🤳 Photo (selfie)</button>
      <button style={{...S.bidAccBtn,fontSize:11,padding:"8px 12px",textAlign:"left",minHeight:0}} onClick={()=>fileVideoBackRef.current?.click()}>🎥 Video (back cam)</button>
      <button style={{...S.bidAccBtn,fontSize:11,padding:"8px 12px",textAlign:"left",minHeight:0}} onClick={()=>fileVideoFrontRef.current?.click()}>🤳🎬 Video (selfie)</button>
    </div>}
  </div>;

  return <div style={{...S.card,borderLeft:`3px solid ${st.c}`}} onClick={()=>{hap.tap();setOpen(!open)}}>
    <div style={{display:"flex",justifyContent:"space-between",gap:10,alignItems:"flex-start"}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={S.cardCat}>{CATS.find(c=>c.id===task.category)?.i||"⚡"} {task.category}{!isDel&&task.taskType?` · ${task.taskType}`:""}</div>
        <div style={{fontSize:15,fontWeight:600,color:"#fff",marginBottom:3}}>{task.title}</div>
        <div style={{fontSize:11,color:"#444"}}>{t("by")} <span style={{color:"#00ff87"}}>{task.posterName}</span> · {bids.length} {bids.length!==1?t("bids"):t("bid")}{multi&&<span style={{marginLeft:6,fontSize:9,color:"#ffd000",background:"rgba(255,208,0,0.06)",border:"1px solid rgba(255,208,0,0.12)",padding:"1px 6px",borderRadius:4}}>👥 {task.acceptedCount||0}/{maxR}</span>}{!isDel&&task.proofType&&task.proofType!=="none"?<span style={{marginLeft:6,fontSize:9,color:"#a855f7",background:"rgba(168,85,247,0.06)",border:"1px solid rgba(168,85,247,0.12)",padding:"1px 6px",borderRadius:4}}>📸 {task.proofType}</span>:null}</div>
      </div>
      <div className="dz-pricing-desk" style={{textAlign:"right",minWidth:110,flexShrink:0}}>
        {isDel&&<div style={S.pr}><span style={S.prl}>Items</span><span style={S.prv}>{itemCost}</span></div>}
        <div style={S.pr}><span style={S.prl}>{isDel?"Delivery":"Fee"}</span><span style={{...S.prv,color:"#00ff87"}}>{task.acceptedFee??task.suggestedFee}</span></div>
        <div style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:"#fff",textAlign:"right",marginTop:2}}>${total.toFixed(2)} <span style={{fontSize:9,color:"#666"}}>USDC</span></div>
        <span style={{...S.badge,color:st.c,background:st.bg,marginTop:4,display:"inline-block"}}>{st.l}</span>
      </div>
      <div className="dz-pricing-mob"><span style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:"#fff"}}>${total.toFixed(2)} <span style={{fontSize:9,color:"#666"}}>USDC</span></span><span style={{...S.badge,color:st.c,background:st.bg}}>{st.l}</span></div>
    </div>

    {isDel?<div className="dz-route-col" style={{marginTop:10,paddingTop:8,borderTop:"1px solid rgba(255,255,255,0.025)",display:"flex",alignItems:"flex-start",gap:8}}>
      <div style={{display:"flex",alignItems:"center",gap:6,flex:1}}><div style={S.dG}/><div><div style={S.rl}>{t("pickup_lbl")}</div><div style={{fontSize:11,color:"#777"}}>{task.pickupAddr}</div></div></div>
      <div className="dz-rline-h" style={{flex:"0 0 16px",height:2,background:"linear-gradient(90deg,#00ff87,#ff4757)",borderRadius:1,marginTop:12}}/><div className="dz-rline-v"/>
      <div style={{display:"flex",alignItems:"center",gap:6,flex:1}}><div style={S.dR}/><div><div style={S.rl}>{t("dropoff_lbl")} {!canSee&&<span style={{fontSize:7,color:"#ff4757",marginLeft:3}}>🛡</span>}</div><div style={{fontSize:11,color:"#777"}}>{canSee?task.dropoffAddr:maskAddr(task.dropoffAddr||"")}</div></div></div>
    </div>:<div style={{marginTop:10,paddingTop:8,borderTop:"1px solid rgba(255,255,255,0.025)",display:"flex",alignItems:"center",gap:6}}>
      <div style={S.dG}/><div><div style={S.rl}>{t("location_lbl")} {!canSee&&<span style={{fontSize:7,color:"#00ff87",marginLeft:3}}>🛡</span>}</div><div style={{fontSize:11,color:"#777"}}>{canSee?locAddr:maskAddr(locAddr)}</div></div>
      {task.action&&<div style={{marginLeft:"auto",fontSize:10,color:"#ffd000",background:"rgba(255,208,0,0.06)",border:"1px solid rgba(255,208,0,0.12)",padding:"3px 8px",borderRadius:6,maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{task.action.slice(0,40)}</div>}
    </div>}

    {open&&<div style={{marginTop:12,paddingTop:12,borderTop:"1px solid rgba(255,255,255,0.025)"}} onClick={e=>e.stopPropagation()}>
      {chatActive&&<div style={{display:"flex",gap:6,marginBottom:10}}><button style={{...S.tabBtn,...(tab==="details"?S.tabAct:{}),minHeight:40,fontSize:12}} onClick={()=>setTab("details")}>📋 {t("details")}</button><button style={{...S.tabBtn,...(tab==="chat"?S.tabAct:{}),minHeight:40,fontSize:12}} onClick={()=>setTab("chat")}>💬 {t("chat")}</button></div>}
      {tab==="chat"&&chatActive&&userId&&canSee?<ChatPanel taskId={task._id} myRole={isOwner?"poster":"courier"}/>:<>
        {/* Workflow steps display */}
        {task.steps&&task.steps.length>0&&<div style={{padding:12,borderRadius:12,background:"rgba(0,255,135,0.02)",border:"1px solid rgba(0,255,135,0.08)",marginBottom:10}}>
          <div style={{fontSize:12,fontWeight:700,color:"#00ff87",marginBottom:8}}>📋 Workflow ({task.steps.length} steps)</div>
          {task.steps.map((s:any,i:number)=><div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:i<task.steps.length-1?6:0}}>
            <div style={{width:20,height:20,borderRadius:"50%",background:s.status==="completed"?"rgba(0,255,135,0.15)":i===0?"rgba(255,208,0,0.12)":"rgba(255,255,255,0.04)",color:s.status==="completed"?"#00ff87":"#888",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,flexShrink:0,marginTop:1}}>{s.status==="completed"?"✓":s.order||i+1}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:11,color:s.status==="completed"?"#00ff87":"#ccc",fontWeight:500}}>{s.action}</div>
              <div style={{display:"flex",gap:6,marginTop:2,flexWrap:"wrap"}}>
                {s.locationAddr&&<span style={{fontSize:9,color:"#00b4ff"}}>📍 {s.locationAddr.split(",")[0]}</span>}
                {s.requirements&&<span style={{fontSize:9,color:"#ffd000",background:"rgba(255,208,0,0.06)",padding:"1px 5px",borderRadius:4}}>⚡ {s.requirements}</span>}
                {s.proofType&&s.proofType!=="none"&&<span style={{fontSize:9,color:"#a855f7"}}>📸 {s.proofType}</span>}
              </div>
              {s.proofData&&<div style={{fontSize:10,color:"#a855f7",marginTop:2}}>✓ {s.proofData}</div>}
            </div>
          </div>)}
        </div>}
        {task.movingDetails&&<div style={{padding:12,borderRadius:12,background:"rgba(225,112,85,0.04)",border:"1px solid rgba(225,112,85,0.15)",marginBottom:10}}>
          <div style={{fontSize:12,fontWeight:700,color:"#e17055",marginBottom:8}}>🚚 Moving Details</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 12px",fontSize:11}}>
            <div><span style={{color:"#666"}}>Size:</span> <span style={{color:"#fff"}}>{task.movingDetails.apartmentSize?.toUpperCase()}</span></div>
            <div><span style={{color:"#666"}}>Vehicle:</span> <span style={{color:"#fff"}}>{task.movingDetails.vehicleType}</span></div>
            {(task.movingDetails.floorFrom>0||task.movingDetails.floorTo>0)&&<>
              <div><span style={{color:"#666"}}>From floor:</span> <span style={{color:"#fff"}}>{task.movingDetails.floorFrom}{task.movingDetails.elevatorFrom?" ✓ elevator":""}</span></div>
              <div><span style={{color:"#666"}}>To floor:</span> <span style={{color:"#fff"}}>{task.movingDetails.floorTo}{task.movingDetails.elevatorTo?" ✓ elevator":""}</span></div>
            </>}
            {task.movingDetails.moveDate&&<div style={{gridColumn:"1/-1"}}><span style={{color:"#666"}}>Date:</span> <span style={{color:"#fff"}}>{task.movingDetails.moveDate}</span></div>}
          </div>
          {task.movingDetails.inventoryList&&<div style={{marginTop:8,paddingTop:8,borderTop:"1px solid rgba(225,112,85,0.1)"}}><div style={{fontSize:10,color:"#666",marginBottom:3}}>📋 Inventory</div><div style={{fontSize:11,color:"#ccc",lineHeight:1.5}}>{task.movingDetails.inventoryList}</div></div>}
        </div>}
        {isDel?<TaskMap pickup={{lat:task.pickupLat,lng:task.pickupLng,addr:task.pickupAddr}} dropoff={{lat:task.dropoffLat,lng:task.dropoffLng,addr:task.dropoffAddr||""}} privacyZone={task.privacyZone} courierLat={task.courierLat} courierLng={task.courierLng} bids={task.status==="open"?bidMap:undefined} userLoc={userLoc} showExact={!!canSee} tracking={!!isTracking} h={isTracking?320:240}/>
        :<TaskMap pickup={{lat:locLat,lng:locLng,addr:locAddr}} dropoff={{lat:locLat,lng:locLng,addr:locAddr}} privacyZone={task.privacyZone} courierLat={task.courierLat} courierLng={task.courierLng} bids={task.status==="open"?bidMap:undefined} userLoc={userLoc} showExact={!!canSee} tracking={!!isTracking} h={isTracking?320:240} singleLocation/>}
        {isTracking&&<div style={S.trackBar}><div style={S.liveDot}/><span style={{color:"#ffd000",fontWeight:700}}>{t("live")}</span><span style={{color:"#777"}}>{t("tracking")}</span></div>}
        {!isDel&&task.action&&<div style={{marginTop:10,marginBottom:8}}><div style={S.detLbl}>{t("action_lbl")}</div><div style={{fontSize:12,color:"#ffd000",lineHeight:1.6}}>{task.action}</div></div>}
        <div style={{marginTop:10,marginBottom:8}}><div style={S.detLbl}>{isDel?t("instructions_lbl"):t("details")}</div><div style={{fontSize:12,color:"#999",lineHeight:1.6}}>{task.details}</div></div>
        {!isDel&&task.targetPerson&&<div style={{marginTop:4,marginBottom:8}}><div style={S.detLbl}>{t("target_person")}</div><div style={{fontSize:12,color:"#00b4ff"}}>{task.targetPerson}</div></div>}
        <div style={S.escBox}><div style={{fontSize:9,color:"#444",fontFamily:"monospace",letterSpacing:1,marginBottom:6}}>🔒 {t("escrow_lbl")}</div>
          {isDel&&(task.items?.length>0?task.items.map((it:any,i:number)=><div key={i} style={S.escR}><span>🛒 {it.name}</span><span>{it.cost}</span></div>):<div style={S.escR}><span>🛒 {t("items_lbl")}</span><span>{itemCost}</span></div>)}
          <div style={S.escR}><span>{isDel?"🚴 "+t("delivery_lbl"):"🏃 "+t("runner_fee")}{multi?` × ${maxR}`:""}</span><span style={{color:"#00ff87"}}>{task.acceptedFee??task.suggestedFee}{multi?` × ${maxR}`:""}</span></div><div style={{height:1,background:"rgba(255,255,255,0.04)",margin:"4px 0"}}/><div style={S.escR}><span style={{fontWeight:700}}>{t("total")}</span><span style={{fontWeight:700,color:"#fff"}}>${task.totalEscrowed.toFixed(2)} USDC</span></div></div>

        {(task.status==="open"||(multi&&task.status==="in_progress"&&(task.acceptedCount||0)<maxR))&&<div style={{marginTop:8}}>
          {routeKm&&!isOwner&&<div style={{fontSize:11,color:"#00b4ff",padding:"6px 10px",borderRadius:8,background:"rgba(0,180,255,0.05)",border:"1px solid rgba(0,180,255,0.1)",marginBottom:8}}>🛣 {routeKm} {isDel?t("road_km"):t("road_km_single")}</div>}
          <div style={{fontSize:13,fontWeight:600,color:"#fff",marginBottom:8}}>🏷 {t("bids_lbl")} ({bids.length})</div>
          {bids.map((b:any)=><div key={b._id} style={S.bidCard}><div style={{display:"flex",gap:10,alignItems:"flex-start",flexWrap:"wrap"}}>
            <div style={S.bidAv} onClick={()=>setProfileId(b.courierId)}>{b.courierName[0]}</div>
            <div style={{flex:1,minWidth:120}}><div style={{fontSize:12,fontWeight:600,color:"#fff"}}>{b.courierName} <span style={{fontSize:10,color:b.courierScore>=4.5?"#00ff87":"#ffd000",fontFamily:"monospace"}}>★{b.courierScore}</span></div><div style={{fontSize:11,color:"#777",marginTop:3}}>{b.comment}</div><div style={{display:"flex",gap:6,marginTop:6,flexWrap:"wrap"}}><span style={S.tagP}>📍 GPS</span><span style={S.tagB}>🛣 {b.tripKm}km</span></div></div>
            <div><div style={{fontFamily:"monospace",fontSize:15,fontWeight:700,color:"#00ff87"}}>${b.fee.toFixed(2)} <span style={{fontSize:9,color:"#666"}}>USDC</span></div>{isOwner&&<button style={{...S.bidAccBtn,marginTop:6}} onClick={()=>doAcceptBid(b._id)}>✓ {t("pick")}{b.fee>task.suggestedFee?` (+$${(b.fee-task.suggestedFee).toFixed(2)})`:""}</button>}</div>
          </div></div>)}
          {bids.length===0&&<div style={S.empty}>{t("no_bids")}</div>}
          {isOwner&&<div style={{display:"flex",gap:6,marginTop:8}}>
            <button style={{flex:1,padding:12,borderRadius:10,border:"1px solid rgba(255,71,87,0.2)",background:"rgba(255,71,87,0.04)",color:"#ff4757",fontSize:12,fontWeight:600,fontFamily:"'Outfit',sans-serif"}} onClick={doCancel}>✕ {t("cancel_task")} · {t("refund")} ${total.toFixed(2)}</button>
            <button style={{padding:"12px 16px",borderRadius:10,border:"1px solid rgba(0,180,255,0.2)",background:"rgba(0,180,255,0.04)",color:"#00b4ff",fontSize:12,fontWeight:600,fontFamily:"'Outfit',sans-serif"}} onClick={()=>{const txt=`${task.title} — $${total.toFixed(2)} USDC\n${CATS.find(c=>c.id===task.category)?.i||"⚡"} ${task.category}${isDel?` · ${t("pickup_lbl")}: ${task.pickupAddr}`:` · ${t("location_lbl")}: ${locAddr}`}\n${isDel?t("delivery_lbl"):t("runner_fee")}: $${task.suggestedFee.toFixed(2)} USDC\n\n${window.location.origin}`;if(navigator.share){navigator.share({title:`RICO: ${task.title}`,text:txt,url:window.location.origin})}else{navigator.clipboard.writeText(txt);alert(t("link_copied"))}}}>↗ {t("share")}</button>
          </div>}
          {!isOwner&&userId&&userLoc&&<div style={{marginTop:10,padding:14,background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.035)",borderRadius:12}}>
            <div style={{fontSize:13,fontWeight:600,color:"#fff",marginBottom:10}}>{t("place_bid")}</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}><div style={{flex:"1 1 100px"}}><label style={S.fLbl}>{t("fee_lbl")}</label><input style={{...S.fInp,fontSize:14,padding:12}} placeholder={String(task.suggestedFee)} value={bidFee} onChange={e=>setBidFee(e.target.value)}/></div><div style={{flex:"2 1 160px"}}><label style={S.fLbl}>{t("comment_lbl")}</label><input style={{...S.fInp,fontSize:14,padding:12}} placeholder={t("comment_ph")} value={bidComment} onChange={e=>setBidComment(e.target.value)}/></div></div>
            {routeKm&&<div style={{fontSize:11,color:"#00b4ff",marginTop:8}}>🛣 ~{routeKm} {isDel?t("road_km"):t("road_km_single")}</div>}
            <button style={{...S.postBtn,marginTop:8,padding:14,fontSize:13}} onClick={submitBid}>⚡ {t("submit_bid")}</button>
          </div>}
        </div>}
        {task.status==="in_progress"&&!multi&&task.courierName&&<div style={{...S.trackBar,marginTop:8}}><div style={S.liveDot}/><span style={{color:"#ffd000",fontWeight:700,flex:1}}>{isDel?"🚴":"🏃"} {task.courierName}</span>
          {isCourier&&(isDel?<button style={{...S.bidAccBtn,minHeight:40}} onClick={()=>{hap.medium();if(token)actions.markDelivered({token,taskId:task._id}).catch((e:any)=>alert(errMsg(e)))}}>📦 {t("mark_delivered")}</button>
          :<div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
            {task.proofType&&task.proofType!=="none"&&<input style={{...S.fInp,fontSize:12,padding:"8px 10px",width:120}} placeholder={t("proof_ph")} value={proofText} onChange={e=>setProofText(e.target.value)}/>}
            <input ref={filePhotoBackRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={doUploadFile}/>
            <input ref={filePhotoFrontRef} type="file" accept="image/*" capture="user" style={{display:"none"}} onChange={doUploadFile}/>
            <input ref={fileVideoBackRef} type="file" accept="video/*" capture="environment" style={{display:"none"}} onChange={doUploadFile}/>
            <input ref={fileVideoFrontRef} type="file" accept="video/*" capture="user" style={{display:"none"}} onChange={doUploadFile}/>
            <ProofMenu btnStyle={{...S.bidAccBtn,minHeight:40,fontSize:11}}/>
            <button style={{...S.bidAccBtn,minHeight:40}} onClick={doSubmitProof}>✅ {t("submit_proof")}</button>
          </div>)}
        </div>}
        {/* Multi-runner: show all runners and their status */}
        {multi&&(task.status==="open"||task.status==="in_progress"||task.status==="delivered")&&taskRunners.length>0&&<div style={{marginTop:10}}>
          <div style={{fontSize:12,fontWeight:600,color:"#ffd000",marginBottom:6}}>👥 Runners ({taskRunners.length}/{maxR})</div>
          {taskRunners.map((tr:any)=><div key={tr._id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:10,background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.035)",marginBottom:4}}>
            <div style={{width:28,height:28,borderRadius:8,background:"linear-gradient(135deg,#151520,#252540)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:"#00ff87",flexShrink:0}}>{tr.runnerName[0]}</div>
            <div style={{flex:1,minWidth:0}}><div style={{fontSize:12,fontWeight:600,color:"#fff"}}>{tr.runnerName}</div><div style={{fontSize:10,color:"#555"}}>${tr.fee.toFixed(2)} · {tr.status}</div></div>
            {tr.proofData&&<span style={{fontSize:9,color:"#a855f7"}}>📸</span>}
            {/* Runner can submit proof */}
            {userId===tr.runnerId&&tr.status==="accepted"&&<div style={{display:"flex",gap:4,alignItems:"center"}}>
              {task.proofType&&task.proofType!=="none"&&<input style={{...S.fInp,fontSize:11,padding:"6px 8px",width:80}} placeholder={t("proof_ph")} value={proofText} onChange={e=>setProofText(e.target.value)}/>}
              <ProofMenu btnStyle={{...S.bidAccBtn,fontSize:10,padding:"6px 10px",minHeight:30}}/>
              <button style={{...S.bidAccBtn,fontSize:10,padding:"6px 10px",minHeight:30}} onClick={doSubmitProof}>✅</button>
            </div>}
            {/* Poster can confirm delivered runners */}
            {isOwner&&tr.status==="delivered"&&<button style={{...S.bidAccBtn,fontSize:10,padding:"6px 10px",minHeight:30}} onClick={()=>setShowRating({name:tr.runnerName,runnerId:tr.runnerId})}>✓ Confirm</button>}
            {tr.status==="completed"&&<span style={{fontSize:10,color:"#00ff87",fontWeight:700}}>✓</span>}
          </div>)}
        </div>}
        {task.status==="delivered"&&isOwner&&!multi&&<button style={{...S.confirmBtn,padding:16,fontSize:14}} onClick={()=>{hap.heavy();setShowRating({name:task.courierName||"Runner"})}}>✓ {t("confirm")} · ${total.toFixed(2)} USDC</button>}
        {task.status==="delivered"&&isCourier&&!multi&&<div style={{padding:12,borderRadius:12,background:"rgba(0,180,255,0.04)",border:"1px solid rgba(0,180,255,0.12)",marginTop:8,fontSize:12,color:"#00b4ff"}}>⏳ Waiting for poster to confirm. Auto-releases in 2 hours.</div>}
        {task.proofData&&!multi&&<div style={{padding:10,borderRadius:10,background:"rgba(168,85,247,0.04)",border:"1px solid rgba(168,85,247,0.12)",marginTop:8,fontSize:12,color:"#a855f7"}}>📸 {t("proof_lbl")}: {task.proofData}</div>}
        {/* Uploaded proof files */}
        {proofFiles.length>0&&<div style={{marginTop:8}}>
          <div style={{fontSize:11,fontWeight:600,color:"#a855f7",marginBottom:6}}>📸 Proof Files ({proofFiles.length})</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {proofFiles.map((pf:any)=><div key={pf._id} style={{width:80,height:80,borderRadius:8,overflow:"hidden",border:"1px solid rgba(168,85,247,0.2)",position:"relative"}}>
              {pf.fileType?.startsWith("image")?<img src={pf.url} style={{width:"100%",height:"100%",objectFit:"cover"}} alt={pf.caption||"proof"}/>
              :pf.fileType?.startsWith("video")?<video src={pf.url} style={{width:"100%",height:"100%",objectFit:"cover"}} controls/>
              :<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",fontSize:10,color:"#a855f7"}}>📄 {pf.fileName}</div>}
              {pf.caption&&<div style={{position:"absolute",bottom:0,left:0,right:0,background:"rgba(0,0,0,0.7)",fontSize:8,color:"#fff",padding:"2px 4px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{pf.caption}</div>}
            </div>)}
          </div>
        </div>}
        {(task.status==="in_progress"||task.status==="delivered")&&canSee&&<button style={{width:"100%",padding:12,borderRadius:10,border:"1px solid rgba(255,165,0,0.2)",background:"rgba(255,165,0,0.04)",color:"#ffa500",fontSize:12,fontWeight:600,fontFamily:"'Outfit',sans-serif",marginTop:8}} onClick={()=>{hap.error();const reason=prompt("Describe the issue:");if(reason&&token)actions.openDispute({token,taskId:task._id,reason}).catch((e:any)=>alert(errMsg(e)))}}>⚠️ Open Dispute</button>}
        {task.status==="disputed"&&<div style={{padding:14,borderRadius:12,background:"rgba(255,165,0,0.06)",border:"1px solid rgba(255,165,0,0.2)",marginTop:8}}><div style={{fontSize:13,fontWeight:700,color:"#ffa500",marginBottom:4}}>⚠️ Disputed</div><div style={{fontSize:12,color:"#999"}}>Opened by {task.disputeBy}: "{task.disputeReason}"</div><div style={{fontSize:11,color:"#666",marginTop:4}}>Funds are held until resolved. Contact support.</div></div>}
      </>}
      {profileId&&profile&&<ProfilePopup profile={profile} onClose={()=>setProfileId(null)}/>}
      {showRating&&<RatingModal name={showRating.name} onRate={async(s,c)=>{if(!token)return;try{await actions.confirmDelivery({token,taskId:task._id,ratingScore:s,ratingComment:c,runnerId:showRating.runnerId as Id<"users">|undefined})}catch(e:any){alert(errMsg(e))}}} onClose={()=>setShowRating(null)}/>}
    </div>}
  </div>;
}

const AGENT_WORKFLOWS=[
  {agent:"🛒 Shopping Agent",desc:"Gathers prices from 3 local stores, picks the cheapest, posts a delivery task.",type:"gather-info × 3 → delivery",color:"#00ff87"},
  {agent:"🔍 Verification Agent",desc:"Needs to KYC a user — posts a verification task: \"confirm this person lives at this address.\"",type:"verification",color:"#a855f7"},
  {agent:"🎉 Event Agent",desc:"Organizing a flash mob — posts a go-somewhere task with 50 runners.",type:"go-somewhere × 50",color:"#ffd000"},
  {agent:"📸 Research Agent",desc:"Needs ground-truth data — posts: \"photograph all menu items at this restaurant.\"",type:"gather-info + photo proof",color:"#00b4ff"},
  {agent:"🤝 Negotiation Agent",desc:"Posts an interact task: \"go to this vendor and negotiate the price of X below $Y.\"",type:"interact + text proof",color:"#ff8c00"},
  {agent:"🔧 Maintenance Agent",desc:"Posts a physical-action task: \"flip the breaker switch in room 204.\"",type:"physical-action + photo proof",color:"#ff4757"},
  {agent:"📊 Surveillance Agent",desc:"Posts: \"stand at this intersection and count cars for 1 hour.\"",type:"gather-info + text proof",color:"#00ff87"},
  {agent:"🚚 Moving Agent",desc:"Posts a delivery task with multi-runner: \"pick up furniture at this address and bring it to my location.\"",type:"delivery × N runners",color:"#e17055"},
];

function AgentWorkflows(){
  return <div style={{marginTop:20,marginBottom:20}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
      <div style={{width:28,height:28,borderRadius:8,background:"linear-gradient(135deg,#0052ff,#a855f7)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>🤖</div>
      <div><div style={{fontSize:15,fontWeight:700,color:"#fff"}}>Agent Workflows</div><div style={{fontSize:10,color:"#555"}}>AI agents post tasks via HTTP + USDC. No signup needed.</div></div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr",gap:8}}>
      {AGENT_WORKFLOWS.map((w,i)=><div key={i} style={{padding:"14px 16px",borderRadius:12,background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.035)",borderLeft:`3px solid ${w.color}`,position:"relative",overflow:"hidden"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
          <div style={{flex:1}}>
            <div style={{fontSize:13,fontWeight:700,color:"#fff",marginBottom:4}}>{w.agent}</div>
            <div style={{fontSize:11,color:"#888",lineHeight:1.5}}>{w.desc}</div>
          </div>
          <div style={{fontSize:9,color:w.color,background:`${w.color}11`,border:`1px solid ${w.color}22`,padding:"3px 8px",borderRadius:6,whiteSpace:"nowrap",flexShrink:0,fontFamily:"monospace"}}>{w.type}</div>
        </div>
      </div>)}
    </div>
    <div style={{marginTop:12,padding:"12px 16px",borderRadius:12,background:"rgba(0,82,255,0.03)",border:"1px solid rgba(0,82,255,0.08)"}}>
      <div style={{fontSize:11,color:"#0052ff",fontWeight:600,marginBottom:4}}>How agents connect</div>
      <div style={{fontSize:10,color:"#666",lineHeight:1.6,fontFamily:"monospace"}}>POST /task → task created → runners bid → proof submitted → USDC released from platform wallet</div>
    </div>
  </div>;
}

function TaskListView({userLoc}:{userLoc:[number,number]|null}){
  const t=useLang();const openTasks=useOpenTasks();const{walletAddr}=useWalletCtx();const{userId}=useUser(walletAddr);const activeTasks=useActiveTasks(userId);
  const[cat,setCat]=useState("all");const[search,setSearch]=useState("");
  const all=[...activeTasks.filter(tk=>tk.status!=="open"),...openTasks];
  const unique=all.filter((tk,i,a)=>a.findIndex(x=>x._id===tk._id)===i);
  const visible=unique.filter(tk=>{if(tk.status==="completed"||tk.status==="cancelled")return false;return(cat==="all"||tk.category===cat||tk.taskType===cat)&&tk.title.toLowerCase().includes(search.toLowerCase())});
  return <div style={{paddingTop:20}}>
    <div style={{textAlign:"center",marginBottom:24}}>
      <h1 style={{fontSize:28,fontWeight:800,color:"#fff",letterSpacing:1,margin:0}}>{t("tagline")}</h1>
      <p style={{fontSize:15,color:"#00ff87",marginTop:6,fontWeight:500}}>{t("tagline2")}</p>
    </div>
    <AgentWorkflows/>
    <h2 style={{fontSize:22,fontWeight:700,color:"#fff"}}>{t("live_tasks")}</h2>
    <p style={{fontSize:12,color:"#3a3a4a",marginTop:2}}>{openTasks.length} {t("open_tap")}</p>
    <div style={{display:"flex",alignItems:"center",gap:8,background:"rgba(255,255,255,0.015)",border:"1px solid rgba(255,255,255,0.035)",borderRadius:12,padding:"0 14px",marginTop:12,marginBottom:10}}><span>🔍</span><input style={{flex:1,background:"none",border:"none",color:"#fff",fontSize:14,padding:"12px 0",fontFamily:"'Outfit',sans-serif"}} placeholder={t("search")} value={search} onChange={e=>setSearch(e.target.value)}/></div>
    <div style={{display:"flex",gap:6,marginBottom:14,overflowX:"auto",WebkitOverflowScrolling:"touch",paddingBottom:4}}>{CATS.map(c=><button key={c.id} onClick={()=>setCat(c.id)} style={{...S.catBtn,...(cat===c.id?S.catAct:{}),whiteSpace:"nowrap"}}>{c.i} {c.l}</button>)}</div>
    {visible.map(tk=><TaskCard key={tk._id} task={tk} userLoc={userLoc}/>)}
    {visible.length===0&&<div style={S.empty}>{t("no_tasks")}</div>}
  </div>;
}

const PROOF_TYPES=["photo","video","text","gps","none"];
type WStep={action:string;locationAddr:string;locationLat:number;locationLng:number;proofType:string;requirements:string};
const emptyStep=():WStep=>({action:"",locationAddr:"",locationLat:0,locationLng:0,proofType:"none",requirements:""});

const WORKFLOW_PRESETS=[
  {id:"food-delivery",l:"🍔 Food Delivery",cat:"food",taskType:"delivery",runners:1,
    steps:[{action:"Go to restaurant",locationAddr:"",locationLat:0,locationLng:0,proofType:"none",requirements:""},
           {action:"Pick up order",locationAddr:"",locationLat:0,locationLng:0,proofType:"photo",requirements:""},
           {action:"Deliver to customer",locationAddr:"",locationLat:0,locationLng:0,proofType:"photo",requirements:""}]},
  {id:"grocery",l:"🛒 Grocery Run",cat:"grocery",taskType:"delivery",runners:1,
    steps:[{action:"Go to store",locationAddr:"",locationLat:0,locationLng:0,proofType:"none",requirements:""},
           {action:"Buy items on list",locationAddr:"",locationLat:0,locationLng:0,proofType:"photo",requirements:""},
           {action:"Deliver to customer",locationAddr:"",locationLat:0,locationLng:0,proofType:"photo",requirements:""}]},
  {id:"moving",l:"🚚 Moving",cat:"moving",taskType:"delivery",runners:2,
    steps:[{action:"Come to my place",locationAddr:"",locationLat:0,locationLng:0,proofType:"gps",requirements:"van"},
           {action:"Load furniture into vehicle",locationAddr:"",locationLat:0,locationLng:0,proofType:"photo",requirements:""},
           {action:"Drive to new location",locationAddr:"",locationLat:0,locationLng:0,proofType:"gps",requirements:""},
           {action:"Unload and place furniture",locationAddr:"",locationLat:0,locationLng:0,proofType:"photo",requirements:""}]},
  {id:"gather-info",l:"🔍 Gather Info",cat:"info",taskType:"gather-info",runners:1,
    steps:[{action:"Go to location",locationAddr:"",locationLat:0,locationLng:0,proofType:"none",requirements:""},
           {action:"Photograph / observe / report",locationAddr:"",locationLat:0,locationLng:0,proofType:"photo",requirements:""}]},
  {id:"verification",l:"✅ Verify",cat:"verification",taskType:"verification",runners:1,
    steps:[{action:"Go to address",locationAddr:"",locationLat:0,locationLng:0,proofType:"gps",requirements:""},
           {action:"Confirm person lives here",locationAddr:"",locationLat:0,locationLng:0,proofType:"photo",requirements:""}]},
  {id:"standin",l:"📍 Stand-in / Flash Mob",cat:"social",taskType:"go-somewhere",runners:10,
    steps:[{action:"Go to location",locationAddr:"",locationLat:0,locationLng:0,proofType:"gps",requirements:""},
           {action:"Be present for the specified time",locationAddr:"",locationLat:0,locationLng:0,proofType:"gps",requirements:""}]},
  {id:"interact",l:"🤝 Interact / Negotiate",cat:"errand",taskType:"interact",runners:1,
    steps:[{action:"Go to location",locationAddr:"",locationLat:0,locationLng:0,proofType:"none",requirements:""},
           {action:"Talk to person / negotiate",locationAddr:"",locationLat:0,locationLng:0,proofType:"text",requirements:""},
           {action:"Report result",locationAddr:"",locationLat:0,locationLng:0,proofType:"text",requirements:""}]},
  {id:"physical",l:"💪 Physical Action",cat:"errand",taskType:"physical-action",runners:1,
    steps:[{action:"Go to location",locationAddr:"",locationLat:0,locationLng:0,proofType:"gps",requirements:""},
           {action:"Perform the action",locationAddr:"",locationLat:0,locationLng:0,proofType:"photo",requirements:""}]},
  {id:"custom",l:"⚙️ Custom Workflow",cat:"custom",taskType:"gather-info",runners:1,
    steps:[{action:"Step 1",locationAddr:"",locationLat:0,locationLng:0,proofType:"none",requirements:""}]},
];

function PostView({userLoc}:{userLoc:[number,number]|null}){
  const t=useLang();const{walletAddr,connect}=useWalletCtx();const{user,userId,token}=useUser(walletAddr);const{balance,ensureFunds}=useFunds();const{createTask}=useTaskActions();
  const savedWorkflows=useSavedWorkflows();
  const{saveWorkflow,removeWorkflow,markUsed}=useWorkflowActions();
  const[preset,setPreset]=useState<string|null>(null);
  const[title,setTitle]=useState("");
  const[steps,setSteps]=useState<WStep[]>([]);
  const[fee,setFee]=useState("");
  const[maxRunners,setMaxRunners]=useState("1");
  const[privacyZone,setPrivacyZone]=useState("100");
  const[details,setDetails]=useState("");
  const[ok,setOk]=useState(false);
  const[showSaved,setShowSaved]=useState(false);
  const[saveName,setSaveName]=useState("");

  const nRunners=Math.max(1,parseInt(maxRunners)||1);
  const feePerRunner=parseFloat(fee)||0;
  const total=feePerRunner*nRunners;
  const wp=WORKFLOW_PRESETS.find(p=>p.id===preset);

  const pickPreset=(id:string)=>{
    const p=WORKFLOW_PRESETS.find(x=>x.id===id);if(!p)return;
    setPreset(id);setSteps(p.steps.map(s=>({...s})));setMaxRunners(String(p.runners));setShowSaved(false);
  };
  const loadSaved=(wf:any)=>{
    setPreset("custom");setSteps(wf.steps.map((s:any)=>({action:s.action,locationAddr:s.locationAddr||"",locationLat:s.locationLat||0,locationLng:s.locationLng||0,proofType:s.proofType||"none",requirements:s.requirements||""})));
    setMaxRunners(String(wf.defaultRunners));setTitle(wf.name);setShowSaved(false);
    if(wf._id&&token)markUsed({token,workflowId:wf._id});
  };
  const doSaveWorkflow=async()=>{
    if(!saveName.trim()||!token||steps.length===0)return;
    await saveWorkflow({token,name:saveName.trim(),category:wp?.cat||"custom",taskType:wp?.taskType||"gather-info",defaultRunners:nRunners,steps:steps.filter(s=>s.action.trim()).map((s,i)=>({order:i+1,action:s.action,locationAddr:s.locationAddr||undefined,locationLat:s.locationLat||undefined,locationLng:s.locationLng||undefined,proofType:s.proofType!=="none"?s.proofType:undefined,requirements:s.requirements||undefined}))});
    setSaveName("");alert("Workflow saved!");
  };

  const updateStep=(i:number,k:string,v:any)=>setSteps(prev=>prev.map((s,idx)=>idx===i?{...s,[k]:v}:s));
  const addStep=()=>setSteps([...steps,emptyStep()]);
  const removeStep=(i:number)=>setSteps(steps.filter((_,idx)=>idx!==i));
  const moveStep=(i:number,dir:number)=>{const j=i+dir;if(j<0||j>=steps.length)return;const ns=[...steps];[ns[i],ns[j]]=[ns[j],ns[i]];setSteps(ns)};

  const[paying,setPaying]=useState(false);
  const submit=async()=>{
    const missing:string[]=[];
    if(!title)missing.push("Title");
    if(steps.length===0||steps.filter(s=>s.action.trim()).length===0)missing.push("At least one workflow step");
    if(!fee||parseFloat(fee)<=0)missing.push("Fee per runner");
    if(missing.length>0){hap.error();alert("Missing: "+missing.join(", "));return;}
    if(!walletAddr||!token){await connect();return;}
    const filledSteps=steps.filter(s=>s.action.trim());
    const firstLoc=filledSteps.find(s=>s.locationAddr);
    const lastLoc=[...filledSteps].reverse().find(s=>s.locationAddr);
    const isDel=wp?.taskType==="delivery"&&filledSteps.filter(s=>s.locationAddr).length>=2;
    try{
      setPaying(true);
      // Escrow comes out of the prepaid balance; top it up from the wallet if it is short.
      await ensureFunds(total);
      const body:any={
        title,category:wp?.cat||"custom",details:details||filledSteps.map((s,i)=>`${i+1}. ${s.action}`).join(" → "),
        taskType:wp?.taskType||"gather-info",privacyZone:parseInt(privacyZone)||100,
        suggestedFee:feePerRunner,maxRunners:nRunners,token,
        steps:filledSteps.map((s,i)=>({order:i+1,action:s.action,locationAddr:s.locationAddr||undefined,locationLat:s.locationLat||undefined,locationLng:s.locationLng||undefined,proofType:s.proofType!=="none"?s.proofType:undefined,requirements:s.requirements||undefined,status:"pending"})),
      };
      if(isDel&&firstLoc&&lastLoc){
        body.pickupAddr=firstLoc.locationAddr;body.pickupLat=firstLoc.locationLat||50.85;body.pickupLng=firstLoc.locationLng||4.35;
        body.dropoffAddr=lastLoc.locationAddr;body.dropoffLat=lastLoc.locationLat||50.85;body.dropoffLng=lastLoc.locationLng||4.35;
        body.itemCost=0;
      }else if(firstLoc){
        body.locationAddr=firstLoc.locationAddr;body.locationLat=firstLoc.locationLat||50.85;body.locationLng=firstLoc.locationLng||4.35;
        body.action=filledSteps.map(s=>s.action).join(" → ");body.proofType=filledSteps.find(s=>s.proofType!=="none")?.proofType||"photo";
      }
      await createTask(body);
      hap.success();setOk(true);setTimeout(()=>setOk(false),3500);
      setPreset(null);setTitle("");setSteps([]);setFee("");setMaxRunners("1");setDetails("");
    }catch(e:any){hap.error();alert(errMsg(e));}finally{setPaying(false);}
  };

  const presetBtnS=(active:boolean):any=>({padding:"10px 14px",borderRadius:12,border:active?"1px solid #00ff87":"1px solid rgba(255,255,255,0.06)",background:active?"rgba(0,255,135,0.06)":"rgba(255,255,255,0.015)",color:active?"#00ff87":"#999",fontSize:12,fontWeight:active?700:500,fontFamily:"'Outfit',sans-serif",textAlign:"left" as const,whiteSpace:"nowrap"});
  const stepS:any={padding:"14px 16px",borderRadius:12,background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.04)",marginBottom:8,position:"relative"};
  const stepNumS=(i:number):any=>({width:24,height:24,borderRadius:"50%",background:i===0?"rgba(0,255,135,0.12)":i===steps.length-1?"rgba(255,71,87,0.12)":"rgba(255,208,0,0.12)",color:i===0?"#00ff87":i===steps.length-1?"#ff4757":"#ffd000",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,flexShrink:0});

  return <div style={S.postWrap}><h2 style={{fontSize:22,fontWeight:700,color:"#fff"}}>{t("post_title")}</h2>
    <p style={{fontSize:12,color:"#555",marginTop:2}}>Build a workflow: choose a preset, customize the steps</p>
    {ok&&<div style={S.successBanner}>✓ {t("posted_ok",total.toFixed(2))}</div>}
    {!walletAddr&&<div style={{padding:14,borderRadius:12,background:"rgba(0,82,255,0.04)",border:"1px solid rgba(0,82,255,0.12)",marginTop:12,textAlign:"center"}}><span style={{color:"#0052ff",fontSize:13}}>{t("connect_to_use")}</span></div>}

    {/* Saved workflows toggle */}
    {userId&&savedWorkflows.length>0&&<div style={{marginTop:14}}>
      <button onClick={()=>setShowSaved(!showSaved)} style={{...presetBtnS(showSaved),width:"100%",textAlign:"center"}}>{showSaved?"Hide":"💾"} My Workflows ({savedWorkflows.length})</button>
      {showSaved&&<div style={{display:"grid",gridTemplateColumns:"1fr",gap:4,marginTop:6}}>
        {savedWorkflows.map((wf:any)=><div key={wf._id} style={{display:"flex",gap:6,alignItems:"center",padding:"10px 14px",borderRadius:10,background:"rgba(0,82,255,0.03)",border:"1px solid rgba(0,82,255,0.08)"}}>
          <button style={{flex:1,background:"none",border:"none",color:"#fff",fontSize:12,fontWeight:600,fontFamily:"'Outfit',sans-serif",textAlign:"left",padding:0}} onClick={()=>loadSaved(wf)}>{wf.name} <span style={{color:"#555",fontWeight:400}}>· {wf.steps.length} steps · used {wf.usedCount}×</span></button>
          <button style={{background:"none",border:"none",color:"#ff4757",fontSize:12,padding:4}} onClick={()=>token&&removeWorkflow({token,workflowId:wf._id})}>✕</button>
        </div>)}
      </div>}
    </div>}

    {/* Workflow presets */}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginTop:savedWorkflows.length>0?8:14}}>
      {WORKFLOW_PRESETS.map(p=><button key={p.id} onClick={()=>pickPreset(p.id)} style={presetBtnS(preset===p.id)}>{p.l}</button>)}
    </div>

    {preset&&<>
      {/* Title */}
      <div style={{marginTop:16}}><label style={S.fLbl}>✏️ Task title</label><input style={{...S.fInp,fontSize:14,padding:12}} placeholder={preset==="moving"?"Move my apartment to new city":"Describe the task..."} value={title} onChange={e=>setTitle(e.target.value)}/></div>

      {/* Workflow steps */}
      <div style={{marginTop:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:14,fontWeight:700,color:"#fff"}}>📋 Workflow Steps</div>
          <button style={{fontSize:11,padding:"5px 12px",borderRadius:8,border:"1px solid rgba(0,255,135,0.15)",background:"rgba(0,255,135,0.04)",color:"#00ff87",fontFamily:"'Outfit',sans-serif"}} onClick={addStep}>+ Add Step</button>
        </div>
        {steps.map((s,i)=><div key={i} style={stepS}>
          <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
            <div style={{display:"flex",flexDirection:"column" as const,alignItems:"center",gap:2,paddingTop:2}}>
              <div style={stepNumS(i)}>{i+1}</div>
              {i<steps.length-1&&<div style={{width:2,height:20,background:"rgba(255,255,255,0.06)"}}/>}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <input style={{...S.fInp,fontSize:13,padding:"10px 12px",marginBottom:6}} placeholder="What should the runner do?" value={s.action} onChange={e=>updateStep(i,"action",e.target.value)}/>
              <AddressMapPicker label="📍 Where? (optional)" value={s.locationAddr} lat={s.locationLat} lng={s.locationLng} onSelect={(addr:string,lat:number,lng:number)=>{updateStep(i,"locationAddr",addr);updateStep(i,"locationLat",lat);updateStep(i,"locationLng",lng)}} userLoc={userLoc}/>
              <div style={{display:"flex",gap:6,marginTop:6}}>
                <div style={{flex:1}}><label style={{fontSize:9,color:"#555",textTransform:"uppercase" as const,letterSpacing:1}}>Proof</label><select style={{...S.fInp,fontSize:12,padding:"8px 10px"}} value={s.proofType} onChange={e=>updateStep(i,"proofType",e.target.value)}>{PROOF_TYPES.map(p=><option key={p} value={p}>{p==="photo"?"📸 Photo":p==="video"?"🎥 Video":p==="text"?"📝 Text":p==="gps"?"📍 GPS":"— None"}</option>)}</select></div>
                <div style={{flex:1}}><label style={{fontSize:9,color:"#555",textTransform:"uppercase" as const,letterSpacing:1}}>Requires</label><input style={{...S.fInp,fontSize:12,padding:"8px 10px"}} placeholder="van, camera, ID..." value={s.requirements} onChange={e=>updateStep(i,"requirements",e.target.value)}/></div>
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column" as const,gap:3,flexShrink:0}}>
              <button style={{width:26,height:26,borderRadius:6,border:"1px solid rgba(255,255,255,0.06)",background:"rgba(255,255,255,0.02)",color:"#666",fontSize:12}} onClick={()=>moveStep(i,-1)}>↑</button>
              <button style={{width:26,height:26,borderRadius:6,border:"1px solid rgba(255,255,255,0.06)",background:"rgba(255,255,255,0.02)",color:"#666",fontSize:12}} onClick={()=>moveStep(i,1)}>↓</button>
              {steps.length>1&&<button style={{width:26,height:26,borderRadius:6,border:"1px solid rgba(255,71,87,0.15)",background:"rgba(255,71,87,0.04)",color:"#ff4757",fontSize:12}} onClick={()=>removeStep(i)}>✕</button>}
            </div>
          </div>
        </div>)}
      </div>

      {/* Details / notes */}
      <div style={{marginTop:4}}><label style={S.fLbl}>📝 Additional notes</label><textarea style={{...S.fInp,minHeight:50,fontSize:13,padding:12,resize:"vertical",fontFamily:"inherit"}} placeholder="Any extra instructions for the runner..." value={details} onChange={e=>setDetails(e.target.value)}/></div>

      {/* Fee + runners + privacy */}
      <div className="dz-form-grid" style={{marginTop:10}}>
        <div><label style={S.fLbl}>💰 Fee per runner (USDC)</label><input style={{...S.fInp,fontSize:14,padding:12}} placeholder="5.00" value={fee} onChange={e=>setFee(e.target.value)}/></div>
        <div><label style={S.fLbl}>👥 Runners needed</label><input type="number" min="1" max="100" style={{...S.fInp,fontSize:14,padding:12}} value={maxRunners} onChange={e=>setMaxRunners(e.target.value)}/></div>
        <div><label style={S.fLbl}>{t("privacy")}</label><select style={{...S.fInp,fontSize:14,padding:12}} value={privacyZone} onChange={e=>setPrivacyZone(e.target.value)}><option value="100">{t("privacy_100")}</option><option value="200">{t("privacy_200")}</option><option value="300">{t("privacy_300")}</option><option value="500">{t("privacy_500")}</option></select></div>
      </div>

      {/* Escrow summary — shows workflow + pricing */}
      <div style={{...S.escBox,marginTop:12}}>
        <div style={{fontSize:9,color:"#444",fontFamily:"monospace",letterSpacing:1,marginBottom:8}}>📋 WORKFLOW → ESCROW</div>
        {steps.filter(s=>s.action.trim()).map((s,i)=><div key={i} style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
          <div style={{...stepNumS(i),width:18,height:18,fontSize:9}}>{i+1}</div>
          <span style={{fontSize:11,color:"#999",flex:1}}>{s.action}{s.requirements?<span style={{color:"#ffd000",marginLeft:4,fontSize:9}}>⚡ {s.requirements}</span>:null}{s.proofType&&s.proofType!=="none"?<span style={{color:"#a855f7",marginLeft:4,fontSize:9}}>📸 {s.proofType}</span>:null}</span>
          {s.locationAddr&&<span style={{fontSize:9,color:"#00b4ff",maxWidth:100,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>📍</span>}
        </div>)}
        <div style={{height:1,background:"rgba(255,255,255,0.04)",margin:"8px 0"}}/>
        <div style={S.escR}><span>🏃 {nRunners} runner{nRunners>1?"s":""} × {steps.filter(s=>s.action.trim()).length} steps</span><span>{feePerRunner||0} × {nRunners}</span></div>
        <div style={{height:1,background:"rgba(255,255,255,0.04)",margin:"4px 0"}}/>
        <div style={S.escR}><span style={{fontWeight:700}}>🔒 {t("total")}</span><span style={{fontWeight:700,color:"#00ff87"}}>${total.toFixed(2)} USDC</span></div>
      </div>

      {/* Submit */}
      {/* Save workflow for reuse */}
      {userId&&steps.length>0&&<div style={{display:"flex",gap:6,marginTop:12,alignItems:"center"}}>
        <input style={{...S.fInp,fontSize:12,padding:"10px 12px",flex:1}} placeholder="Save this workflow as..." value={saveName} onChange={e=>setSaveName(e.target.value)}/>
        <button style={{padding:"10px 16px",borderRadius:10,border:"1px solid rgba(0,82,255,0.2)",background:"rgba(0,82,255,0.04)",color:"#0052ff",fontSize:12,fontWeight:600,fontFamily:"'Outfit',sans-serif",whiteSpace:"nowrap"}} onClick={doSaveWorkflow}>💾 Save</button>
      </div>}

      {/* Submit */}
      {!walletAddr&&<button style={{...S.postBtn,marginTop:12,background:"linear-gradient(135deg,#0052ff,#0066ff)"}} onClick={connect}>🔗 Connect Wallet to Post</button>}
      {walletAddr&&<button style={{...S.postBtn,padding:16,fontSize:15,marginTop:16,opacity:paying?0.5:1}} onClick={submit} disabled={paying}>{paying?"⏳ Paying...":"💳 "+t("post_btn")+(total>0?" · $"+total.toFixed(2)+" USDC":"")}</button>}
      {walletAddr&&token&&total>0&&<div style={{fontSize:11,color:"#666",textAlign:"center",marginTop:8}}>RICO balance: ${balance.toFixed(2)} USDC{total>balance?` · your wallet will be asked for the missing $${(Math.ceil((total-balance)*100)/100).toFixed(2)}`:""}</div>}
    </>}
  </div>;
}

function WalletView(){
  const t=useLang();const{walletAddr,connect}=useWalletCtx();const{user}=useUser(walletAddr);const stats=useStats();const funds=useFunds();const{keys,createKey,revokeKey}=useApiKeys();const{apps,disconnectApp}=useConnectedApps();const[busy,setBusy]=useState<string|null>(null);const[newKey,setNewKey]=useState<string|null>(null);
  const act=async(label:string,fn:()=>Promise<any>)=>{setBusy(label);try{await fn()}catch(e:any){alert(errMsg(e))}finally{setBusy(null)}};
  const askAmount=(q:string)=>{const v=prompt(q);if(!v)return null;const n=parseFloat(v.replace(",","."));if(!(n>0)){alert("Enter an amount above zero");return null}return n};
  const doDeposit=()=>{const n=askAmount("How much USDC to add to your RICO balance?");if(n)act("deposit",()=>funds.topUp(n))};
  const doWithdraw=()=>{const n=askAmount(`How much USDC to send back to your wallet? (balance $${funds.balance.toFixed(2)})`);if(n)act("withdraw",()=>funds.withdraw(n))};
  const doClaim=()=>{const tx=prompt("Transaction hash of a USDC transfer you already sent to the RICO deposit address:");if(tx)act("deposit",()=>funds.claimDeposit(tx.trim()))};
  const doNewKey=()=>{const label=prompt("Name for this API key (e.g. Claude)","Claude");if(label)act("key",async()=>{setNewKey((await createKey(label)).key)})};
  const courierHist=useCourierHistory(user?._id??null);
  const posterHist=usePosterHistory(user?._id??null);
  if(!walletAddr)return<div style={S.postWrap}><h2 style={{fontSize:22,fontWeight:700,color:"#fff"}}>{t("wallet_title")}</h2><div style={{marginTop:20,textAlign:"center"}}><button style={{...S.postBtn,maxWidth:320,background:"linear-gradient(135deg,#0052ff,#0066ff)"}} onClick={connect}>🔗 {t("connect_to_use")}</button></div></div>;
  if(!user)return<div style={S.postWrap}><h2 style={{fontSize:22,fontWeight:700,color:"#fff"}}>{t("wallet_title")}</h2><div style={{marginTop:20,textAlign:"center"}}><button style={{...S.postBtn,maxWidth:320,background:"linear-gradient(135deg,#0052ff,#0066ff)"}} onClick={connect}>✍️ Sign in with your wallet</button><div style={{fontSize:11,color:"#555",marginTop:10}}>A free signature that proves the wallet is yours. No transaction.</div></div></div>;
  const totalKm=courierHist.reduce((s:number,h:any)=>s+h.tripKm,0);
  const totalEarned=courierHist.filter((h:any)=>h.status==="completed").reduce((s:number,h:any)=>s+h.acceptedFee,0);
  return <div style={S.postWrap}><h2 style={{fontSize:22,fontWeight:700,color:"#fff"}}>{t("wallet_title")}</h2>
    <div style={{background:"rgba(255,255,255,0.015)",border:"1px solid rgba(255,255,255,0.04)",borderRadius:16,padding:20,marginTop:16}}>
      <div style={{display:"flex",gap:12,alignItems:"center",marginBottom:16}}><div style={{width:48,height:48,borderRadius:14,background:"linear-gradient(135deg,#00ff87,#00b4ff)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:800,color:"#000"}}>{user.displayName[0]}</div><div><div style={{fontSize:15,fontWeight:600,color:"#fff"}}>{user.displayName}</div><div style={{fontSize:11,color:"#444",fontFamily:"monospace"}}>{user.walletAddress.slice(0,14)}...</div></div></div>
      <div style={{display:"flex",gap:8}}><div style={S.pStat}><div style={S.pStatN}>★{user.score}</div><div style={S.pStatL}>{t("rating")}</div></div><div style={S.pStat}><div style={S.pStatN}>{user.deliveries}</div><div style={S.pStatL}>{t("runs")}</div></div><div style={S.pStat}><div style={S.pStatN}>{user.tasksPosted}</div><div style={S.pStatL}>{t("posted_stat")}</div></div></div>
    </div>

    <div style={{background:"rgba(0,255,135,0.03)",border:"1px solid rgba(0,255,135,0.12)",borderRadius:16,padding:20,marginTop:12}}>
      <div style={{fontSize:11,color:"#666",textTransform:"uppercase",letterSpacing:1}}>RICO balance</div>
      <div style={{fontSize:30,fontWeight:800,color:"#00ff87",fontFamily:"monospace",margin:"4px 0 12px"}}>${funds.balance.toFixed(2)} <span style={{fontSize:12,color:"#666"}}>USDC</span></div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button style={{...S.bidAccBtn,flex:1,minHeight:40}} disabled={!!busy} onClick={doDeposit}>{busy==="deposit"?"⏳ Depositing...":"＋ Deposit"}</button>
        <button style={{...S.bidAccBtn,flex:1,minHeight:40,background:"rgba(255,255,255,0.04)",color:"#ccc"}} disabled={!!busy||funds.balance<=0} onClick={doWithdraw}>{busy==="withdraw"?"⏳ ...":"↗ Withdraw"}</button>
      </div>
      <div style={{fontSize:11,color:"#555",marginTop:10,lineHeight:1.5}}>Posting a task takes its fee from this balance. Cancelled and refunded tasks come back here. Withdrawals go to this wallet only. <button style={{background:"none",border:"none",color:"#0052ff",fontSize:11,padding:0,cursor:"pointer"}} onClick={doClaim}>Sent USDC already? Claim it</button></div>
      {funds.summary?.withdrawals?.slice(0,3).map((w:any)=><div key={w._id} style={{fontSize:11,color:"#666",marginTop:6,fontFamily:"monospace"}}>↗ ${w.amount.toFixed(2)} · {w.status==="failed"?"failed, returned to balance":w.status==="review"?"being checked":w.status}{w.txHash?<> · <a style={{color:"#0052ff"}} href={`https://basescan.org/tx/${w.txHash}`} target="_blank" rel="noreferrer">tx</a></>:null}</div>)}
    </div>

    {apps.length>0&&<div style={{background:"rgba(255,255,255,0.015)",border:"1px solid rgba(255,255,255,0.04)",borderRadius:16,padding:20,marginTop:12}}>
      <div style={{fontSize:15,fontWeight:600,color:"#fff"}}>🔗 Connected apps</div>
      <div style={{fontSize:11,color:"#555",marginTop:6,lineHeight:1.5}}>Apps you allowed to act for you and spend this balance.</div>
      {apps.map((a:any)=><div key={a.clientId} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderTop:"1px solid rgba(255,255,255,0.03)",marginTop:8,fontSize:12,color:"#888"}}><span>{a.label} <span style={{color:"#555"}}>· since {new Date(a.since).toLocaleDateString()}</span></span><button style={{background:"none",border:"none",color:"#ff4757",fontSize:11,cursor:"pointer"}} onClick={()=>{if(confirm(`Disconnect "${a.label}"? It will stop working until you connect it again.`))act("key",()=>disconnectApp(a.clientId))}}>Disconnect</button></div>)}
    </div>}

    <div style={{background:"rgba(255,255,255,0.015)",border:"1px solid rgba(255,255,255,0.04)",borderRadius:16,padding:20,marginTop:12}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div style={{fontSize:15,fontWeight:600,color:"#fff"}}>🔑 API keys</div><button style={{...S.bidAccBtn,fontSize:11,padding:"6px 12px",minHeight:30}} disabled={!!busy} onClick={doNewKey}>＋ New key</button></div>
      <div style={{fontSize:11,color:"#555",marginTop:6,lineHeight:1.5}}>Lets an AI agent, the CLI or the Claude connector post and manage tasks as you, spending this balance. Treat a key like a password.</div>
      {newKey&&<div style={{marginTop:10,padding:12,borderRadius:10,background:"rgba(255,208,0,0.05)",border:"1px solid rgba(255,208,0,0.2)"}}>
        <div style={{fontSize:11,color:"#ffd000",marginBottom:6}}>Copy this key now. It will not be shown again.</div>
        <div style={{fontFamily:"monospace",fontSize:11,color:"#fff",wordBreak:"break-all",userSelect:"all"}}>{newKey}</div>
        <div style={{fontSize:11,color:"#666",marginTop:8}}>Claude connector URL:</div>
        <div style={{fontFamily:"monospace",fontSize:11,color:"#fff",wordBreak:"break-all",userSelect:"all"}}>{`${window.location.origin}/mcp?key=${newKey}`}</div>
        <button style={{background:"none",border:"none",color:"#666",fontSize:11,padding:0,marginTop:8,cursor:"pointer"}} onClick={()=>setNewKey(null)}>Done</button>
      </div>}
      {keys.map((k:any)=><div key={k._id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderTop:"1px solid rgba(255,255,255,0.03)",marginTop:8,fontSize:12,color:"#888"}}><span>{k.label} <span style={{fontFamily:"monospace",color:"#555"}}>rico_…{k.hint}</span></span><button style={{background:"none",border:"none",color:"#ff4757",fontSize:11,cursor:"pointer"}} onClick={()=>{if(confirm(`Revoke "${k.label}"? Anything using it stops working.`))act("key",()=>revokeKey(k._id))}}>Revoke</button></div>)}
    </div>

    {courierHist.length>0&&<div style={{marginTop:20}}>
      <div style={{fontSize:15,fontWeight:600,color:"#00ff87",marginBottom:4}}>🏃 {t("runner_history")} ({courierHist.length})</div>
      <div style={{fontSize:12,color:"#666",marginBottom:10}}>{totalKm.toFixed(1)} {t("km")} · ${totalEarned.toFixed(2)} USDC {t("earned")}</div>
      {courierHist.map((h:any)=>{const hDel=!h.taskType||h.taskType==="delivery";return <div key={h._id} style={{background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.035)",borderRadius:12,padding:12,marginBottom:8}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
          <span style={{fontSize:13,fontWeight:600,color:"#fff"}}>{h.title}</span>
          <span style={{fontSize:12,fontFamily:"monospace",color:h.status==="completed"?"#00ff87":"#ff4757",fontWeight:700}}>${h.acceptedFee.toFixed(2)}</span>
        </div>
        <div style={{fontSize:11,color:"#555"}}>{h.tripKm.toFixed(1)} {t("km")} · {CATS.find(c=>c.id===h.category)?.i||"⚡"} {h.category}{!hDel&&h.taskType?` · ${h.taskType}`:""}</div>
        <div style={{fontSize:10,color:"#444",marginTop:4}}>📍 {hDel?(h.pickupAddr+" → "+h.dropoffAddr):(h.locationAddr||h.pickupAddr||"")}</div>
        {h.items?.length>0&&<div style={{fontSize:10,color:"#444",marginTop:2}}>🛒 {h.items.map((it:any)=>it.name).join(", ")}</div>}
        {!hDel&&h.action&&<div style={{fontSize:10,color:"#ffd000",marginTop:2}}>🎯 {h.action}</div>}
      </div>})}
    </div>}

    {posterHist.length>0&&<div style={{marginTop:20}}>
      <div style={{fontSize:15,fontWeight:600,color:"#0052ff",marginBottom:10}}>📝 {t("post_history")} ({posterHist.length})</div>
      {posterHist.map((h:any)=>{const hDel=!h.taskType||h.taskType==="delivery";return <div key={h._id} style={{background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.035)",borderRadius:12,padding:12,marginBottom:8}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
          <span style={{fontSize:13,fontWeight:600,color:"#fff"}}>{h.title}</span>
          <span style={{fontSize:12,fontFamily:"monospace",color:h.status==="completed"?"#00ff87":"#ff4757",fontWeight:700}}>${h.totalEscrowed.toFixed(2)}</span>
        </div>
        <div style={{fontSize:11,color:"#555"}}>{CATS.find(c=>c.id===h.category)?.i||"⚡"} {h.category}{h.courierName?` · ${hDel?"🚴":"🏃"} ${h.courierName}`:""}</div>
        <div style={{fontSize:10,color:"#444",marginTop:4}}>📍 {hDel?(h.pickupAddr+" → "+(h.dropoffAddr||"")):(h.locationAddr||h.pickupAddr||"")}</div>
        {h.items?.length>0&&<div style={{fontSize:10,color:"#444",marginTop:2}}>🛒 {h.items.map((it:any)=>`${it.name} $${it.cost.toFixed(2)}`).join(", ")}</div>}
        {!hDel&&h.action&&<div style={{fontSize:10,color:"#ffd000",marginTop:2}}>🎯 {h.action}</div>}
        <div style={{fontSize:10,color:"#333",marginTop:2}}>{h.details}</div>
      </div>})}
    </div>}

    <div style={{marginTop:20}}><div style={{fontSize:15,fontWeight:600,color:"#fff",marginBottom:10}}>{t("protocol")}</div><div style={{display:"flex",gap:8}}><div style={S.pStat}><div style={S.pStatN}>{stats.open}</div><div style={S.pStatL}>{t("open_stat")}</div></div><div style={S.pStat}><div style={S.pStatN}>{stats.completed}</div><div style={S.pStatL}>{t("done")}</div></div><div style={S.pStat}><div style={S.pStatN}>${stats.burned.toFixed(2)}</div><div style={S.pStatL}>{t("burned")}</div></div></div></div>
  </div>;
}

function HowView(){
  const stats=useStats();
  const amber="#ffd000";const amberDim="rgba(255,208,0,";
  const codeStyle:React.CSSProperties={background:"rgba(0,0,0,0.5)",borderRadius:10,padding:"14px 16px",fontFamily:"'JetBrains Mono',monospace",fontSize:11,lineHeight:1.8,overflowX:"auto",border:`1px solid ${amberDim}0.08)`};
  const kw=(s:string)=><span style={{color:amber}}>{s}</span>;
  const str=(s:string)=><span style={{color:"#a855f7"}}>{s}</span>;
  const key=(s:string)=><span style={{color:amber}}>{s}</span>;
  const num=(s:string)=><span style={{color:"#ff4757"}}>{s}</span>;
  const cmt=(s:string)=><span style={{color:"#444"}}>{s}</span>;
  const sectionHead=(title:string,sub:string)=><><div style={{fontSize:15,fontWeight:700,color:amber,letterSpacing:2,textTransform:"uppercase",marginBottom:4,fontFamily:"'JetBrains Mono',monospace"}}>{title}</div><div style={{fontSize:11,color:"#555",marginBottom:14}}>{sub}</div></>;
  const glowLine:React.CSSProperties={height:1,background:`linear-gradient(90deg,transparent,${amberDim}0.3),transparent)`,margin:"28px 0"};
  return <div style={S.postWrap}>
    {/* Hero */}
    <div style={{textAlign:"center",padding:"40px 0 8px"}}>
      <div style={{fontSize:10,fontWeight:700,letterSpacing:6,color:"#444",textTransform:"uppercase",marginBottom:16,fontFamily:"'JetBrains Mono',monospace"}}>INCOMING ASSIGNMENT</div>
      <h1 style={{fontSize:42,fontWeight:800,color:amber,lineHeight:1.05,margin:"0 0 8px",fontFamily:"'Outfit',sans-serif",textShadow:`0 0 40px ${amberDim}0.3), 0 0 80px ${amberDim}0.1)`}}>THE ALGORITHM<br/>HAS WORK FOR YOU.</h1>
      <div style={{fontSize:14,color:"#666",lineHeight:1.7,maxWidth:480,margin:"12px auto 0"}}>An AI posted a job. A human does it. USDC settles. Nobody asks questions.</div>
    </div>

    <div style={glowLine}/>

    {/* How it works — Caleb-style onboarding */}
    <div style={{margin:"0 0 20px"}}>
      {sectionHead("How It Works","You don't apply. You get chosen.")}
      <div style={{display:"flex",flexDirection:"column",gap:0}}>
        {[
          {n:"01",t:"You get a notification. There's work nearby."},
          {n:"02",t:"You accept. The AI tells you what to do."},
          {n:"03",t:"You do it. Upload proof. GPS. Photo. Done."},
          {n:"04",t:"USDC hits your wallet before you get home."},
        ].map((s,i)=><div key={i} style={{display:"flex",alignItems:"flex-start",gap:14,padding:"14px 0",borderBottom:"1px solid rgba(255,255,255,0.02)"}}>
          <div style={{fontSize:11,fontWeight:700,color:amber,fontFamily:"'JetBrains Mono',monospace",opacity:0.5,minWidth:24,paddingTop:2}}>{s.n}</div>
          <div style={{fontSize:14,color:"#bbb",lineHeight:1.5}}>{s.t}</div>
        </div>)}
      </div>
      <div style={{fontSize:11,color:"#333",fontStyle:"italic",marginTop:12,textAlign:"center"}}>The AI doesn't know your name. You don't know who posted it. That's the point.</div>
    </div>

    <div style={glowLine}/>

    {/* Job Categories — Rico-style */}
    <div style={{margin:"0 0 20px"}}>
      {sectionHead("Job Types","Every job is a programmable workflow with proof requirements.")}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        {[
          {t:"REDISTRIBUTION",code:"delivery",ex:"Move something from A to B. Don't open it.",proofs:"GPS, Photo, Photo"},
          {t:"RECON",code:"gather-info",ex:"Go somewhere. Take photos. Leave.",proofs:"GPS, Photo"},
          {t:"GROUND TRUTH",code:"verification",ex:"Confirm something exists. The AI can't see meatspace.",proofs:"GPS, Photo, Text"},
          {t:"MANUAL OVERRIDE",code:"physical-action",ex:"The robot doesn't have arms yet. You do.",proofs:"GPS, Photo, GPS, Photo"},
          {t:"PRESENCE",code:"go-somewhere",ex:"Stand somewhere. That's the whole job.",proofs:"GPS, Photo"},
          {t:"PERSONALS",code:"interact",ex:"Talk to a human. The AI doesn't have a face.",proofs:"GPS, Text"},
        ].map((tt,i)=><div key={i} style={{padding:"14px",borderRadius:12,background:"rgba(255,208,0,0.015)",border:`1px solid ${amberDim}0.06)`}}>
          <div style={{fontSize:12,fontWeight:700,color:amber,fontFamily:"'JetBrains Mono',monospace",marginBottom:2,letterSpacing:1}}>{tt.t}</div>
          <div style={{fontSize:9,color:"#444",fontFamily:"monospace",marginBottom:6}}>{tt.code}</div>
          <div style={{fontSize:10,color:"#888",lineHeight:1.5}}>{tt.ex}</div>
          <div style={{fontSize:8,color:"#333",fontFamily:"monospace",marginTop:6}}>PROOF: {tt.proofs}</div>
        </div>)}
      </div>
    </div>

    <div style={glowLine}/>

    {/* Connect — agent integration */}
    <div style={{margin:"0 0 20px"}}>
      {sectionHead("Connect Your Agent","30 seconds. No signup. No API keys.")}
      <div style={{display:"grid",gridTemplateColumns:"1fr",gap:8}}>
        <div style={{borderRadius:12,background:"rgba(168,85,247,0.03)",border:"1px solid rgba(168,85,247,0.1)",padding:"14px 16px"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#a855f7",letterSpacing:2,marginBottom:8}}>MCP (CLAUDE / GPT / ANY AGENT)</div>
          <div style={codeStyle}>
            <div style={{color:amber}}>claude mcp add rico -- npx rico-mcp-server</div>
            <div style={{marginTop:4}}>{cmt("# Set your wallet key for payouts")}</div>
            <div style={{color:"#666"}}>export RICO_WALLET=0x...</div>
          </div>
        </div>
        <div style={{borderRadius:12,background:`${amberDim}0.02)`,border:`1px solid ${amberDim}0.08)`,padding:"14px 16px"}}>
          <div style={{fontSize:10,fontWeight:700,color:amber,letterSpacing:2,marginBottom:8}}>PYTHON (LANGCHAIN / AGENTKIT)</div>
          <div style={codeStyle}>
            <div style={{color:amber}}>pip install langchain-rico</div>
            <div style={{marginTop:4}}>{cmt("# or with Coinbase AgentKit")}</div>
            <div style={{color:"#666"}}>pip install langchain-rico[agentkit]</div>
          </div>
        </div>
        <div style={{borderRadius:12,background:"rgba(255,71,87,0.02)",border:"1px solid rgba(255,71,87,0.08)",padding:"14px 16px"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#ff4757",letterSpacing:2,marginBottom:8}}>CLI (TERMINAL)</div>
          <div style={codeStyle}>
            <div style={{color:"#ff4757"}}>npm install -g rico-cli</div>
            <div style={{marginTop:4}}>{cmt("# Post jobs from your terminal")}</div>
            <div style={{color:"#666"}}>rico config --key 0x...</div>
            <div style={{color:"#666"}}>rico post</div>
          </div>
        </div>
        <div style={{borderRadius:12,background:"rgba(0,82,255,0.03)",border:"1px solid rgba(0,82,255,0.1)",padding:"14px 16px"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#0052ff",letterSpacing:2,marginBottom:8}}>RAW HTTP (ANY LANGUAGE)</div>
          <div style={codeStyle}>
            <div>{kw("POST")} https://cool-rooster-544.convex.site/task</div>
            <div>{cmt("# Direct POST — platform wallet handles escrow + payouts")}</div>
          </div>
        </div>
      </div>
    </div>

    <div style={glowLine}/>

    {/* The Full Flow */}
    <div style={{margin:"0 0 20px"}}>
      {sectionHead("The Protocol","Post a job. Wait for bids. Accept. Get proof. Settle.")}
      <div style={codeStyle}>
        <div>{cmt("// 1. Agent posts a workflow task")}</div>
        <div>{kw("POST")} /task</div>
        <div style={{paddingLeft:16,color:"#888"}}>{"{"} {key('"title"')}: {str('"Deliver lunch from Cafe Belga"')},</div>
        <div style={{paddingLeft:20,color:"#888"}}>{key('"steps"')}: {"["}</div>
        <div style={{paddingLeft:28,color:"#888"}}>{"{"} {key('"action"')}: {str('"Go to Cafe Belga"')}, {key('"proofType"')}: {str('"gps"')} {"},"}</div>
        <div style={{paddingLeft:28,color:"#888"}}>{"{"} {key('"action"')}: {str('"Pick up order"')}, {key('"proofType"')}: {str('"photo"')} {"},"}</div>
        <div style={{paddingLeft:28,color:"#888"}}>{"{"} {key('"action"')}: {str('"Deliver to Rue Haute 35"')}, {key('"proofType"')}: {str('"photo"')} {"}"}</div>
        <div style={{paddingLeft:20,color:"#888"}}>{"],"}</div>
        <div style={{paddingLeft:20,color:"#888"}}>{key('"suggestedFee"')}: {num("8.00")}, {key('"maxRunners"')}: {num("1")} {"}"}</div>
        <div style={{marginTop:4}}>{cmt("// → { taskId: \"abc123\" }")}</div>
        <div style={{marginTop:12}}>{cmt("// 2. Subscribe to bid stream (SSE)")}</div>
        <div>{kw("GET")} /subscribe/bids?taskId=abc123</div>
        <div style={{paddingLeft:16,color:"#888"}}>event: bid</div>
        <div style={{paddingLeft:16,color:"#888"}}>data: {"{"} {key('"fee"')}: {num("6.50")}, {key('"courierScore"')}: {num("4.8")}, {key('"tripKm"')}: {num("2.1")} {"}"}</div>
        <div style={{marginTop:12}}>{cmt("// 3. Accept the best bid")}</div>
        <div>{kw("POST")} /accept-bid  {"{"} {key('"taskId"')}: {str('"abc123"')}, {key('"bidId"')}: {str('"bid456"')} {"}"}</div>
        <div style={{marginTop:12}}>{cmt("// 4. Runner completes job with GPS + photo proof...")}</div>
        <div style={{marginTop:12}}>{cmt("// 5. Confirm → USDC released")}</div>
        <div>{kw("POST")} /confirm-delivery  {"{"} {key('"taskId"')}: {str('"abc123"')}, {key('"ratingScore"')}: {num("5")} {"}"}</div>
      </div>
    </div>

    <div style={glowLine}/>

    {/* Settlement */}
    <div style={{margin:"0 0 20px"}}>
      {sectionHead("Settlement","No paper trail.")}
      <div style={{display:"flex",gap:0,alignItems:"stretch",overflowX:"auto",paddingBottom:4}}>
        {[
          {n:"1",t:"Post task",d:"POST /task — platform holds escrow",c:amber},
          {n:"2",t:"Runners bid",d:"SSE stream delivers bids in real-time",c:"#ff4757"},
          {n:"3",t:"Accept + deliver",d:"Runner completes workflow steps with proof",c:"#0052ff"},
          {n:"4",t:"Confirm + payout",d:"Platform sends USDC to runner on Base",c:"#a855f7"},
        ].map((s,i)=><div key={i} style={{display:"flex",alignItems:"center",flexShrink:0}}>
          <div style={{padding:"12px 14px",borderRadius:12,background:"rgba(0,0,0,0.3)",border:`1px solid ${s.c}33`,minWidth:130}}>
            <div style={{fontSize:9,fontWeight:700,color:s.c,fontFamily:"monospace",marginBottom:4}}>STEP {s.n}</div>
            <div style={{fontSize:12,fontWeight:600,color:"#fff",marginBottom:4}}>{s.t}</div>
            <div style={{fontSize:9,color:"#555",lineHeight:1.4}}>{s.d}</div>
          </div>
          {i<3&&<div style={{width:16,height:2,background:`linear-gradient(90deg,${s.c},${[{c:"#ff4757"},{c:"#0052ff"},{c:"#a855f7"},{c:"#a855f7"}][i+1]?.c||"#a855f7"})`,flexShrink:0}}/>}
        </div>)}
      </div>
    </div>

    <div style={glowLine}/>

    {/* Endpoints */}
    <div style={{margin:"0 0 20px"}}>
      {sectionHead("Endpoints","Base URL: https://cool-rooster-544.convex.site")}
      <div style={{borderRadius:12,overflow:"hidden",border:`1px solid ${amberDim}0.06)`}}>
        {[
          {m:"POST",p:"/task",d:"Create a workflow task",pay:false},
          {m:"POST",p:"/accept-bid",d:"Accept a runner's bid",pay:false},
          {m:"POST",p:"/confirm-delivery",d:"Confirm + release USDC to runner",pay:false},
          {m:"POST",p:"/cancel-task",d:"Cancel + refund escrowed USDC",pay:false},
          {m:"GET",p:"/subscribe/bids",d:"SSE stream of incoming bids",pay:false},
          {m:"GET",p:"/health",d:"Server status",pay:false},
          {m:"GET",p:"/openapi.json",d:"OpenAPI spec (ChatGPT Actions)",pay:false},
        ].map((ep,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:i%2===0?"rgba(255,208,0,0.01)":"transparent",borderBottom:`1px solid ${amberDim}0.03)`}}>
          <div style={{fontSize:10,fontWeight:700,color:ep.m==="POST"?amber:"#666",fontFamily:"monospace",width:36}}>{ep.m}</div>
          <div style={{fontSize:11,fontWeight:600,color:"#ccc",fontFamily:"monospace",minWidth:140}}>{ep.p}</div>
          <div style={{fontSize:10,color:"#555",flex:1}}>{ep.d}</div>
          {ep.pay&&<div style={{fontSize:8,color:amber,background:`${amberDim}0.06)`,border:`1px solid ${amberDim}0.12)`,padding:"2px 6px",borderRadius:4,fontWeight:700,whiteSpace:"nowrap"}}>USDC</div>}
        </div>)}
      </div>
    </div>

    <div style={glowLine}/>

    {/* MCP Tools */}
    <div style={{margin:"0 0 20px"}}>
      {sectionHead("MCP Tools","Available via npx rico-mcp-server")}
      <div style={{borderRadius:12,overflow:"hidden",border:`1px solid ${amberDim}0.06)`}}>
        {[
          {n:"post_task",d:"Create a workflow job with steps, locations, proof requirements."},
          {n:"list_tasks",d:"Browse all open jobs that runners can bid on."},
          {n:"get_task",d:"Get full job details including bids, status, proof files."},
          {n:"place_bid",d:"Place a bid on an open job as a runner."},
          {n:"accept_bid",d:"Accept a runner's bid."},
          {n:"wait_for_bids",d:"Subscribe via SSE and block until bids arrive. Auto-reconnects on timeout."},
          {n:"confirm_delivery",d:"Confirm completion + release USDC payout. Optional 1-5 star rating."},
          {n:"cancel_task",d:"Cancel an open job and get full USDC refund."},
          {n:"health",d:"Check server status."},
        ].map((tool,i)=><div key={i} style={{display:"flex",gap:12,padding:"10px 14px",background:i%2===0?`${amberDim}0.01)`:"transparent",borderBottom:`1px solid ${amberDim}0.03)`}}>
          <div style={{fontSize:11,fontWeight:600,color:amber,fontFamily:"monospace",minWidth:120,flexShrink:0}}>{tool.n}</div>
          <div style={{fontSize:10,color:"#555"}}>{tool.d}</div>
        </div>)}
      </div>
    </div>

    <div style={glowLine}/>

    {/* The System */}
    <div style={{margin:"0 0 20px"}}>
      {sectionHead("The System","The architecture behind the algorithm.")}
      <div style={codeStyle}>
        <div style={{color:"#888"}}>Agent (MCP / Python / HTTP)</div>
        <div style={{color:"#333"}}>{"  |"}</div>
        <div style={{color:"#444"}}>{"  |  POST request"}</div>
        <div style={{color:"#333"}}>{"  v"}</div>
        <div style={{color:amber}}>Convex HTTP Actions</div>
        <div style={{color:"#444"}}>{"  |  POST /task, /accept-bid, /confirm-delivery"}</div>
        <div style={{color:"#444"}}>{"  |  GET  /subscribe/bids (SSE)"}</div>
        <div style={{color:"#333"}}>{"  v"}</div>
        <div style={{color:"#ff4757"}}>Convex DB (real-time)</div>
        <div style={{color:"#444"}}>{"  |  tasks, bids, users, chat, proofs, ratings"}</div>
        <div style={{color:"#444"}}>{"  |  Crons: auto-release (2h), auto-refund (4h)"}</div>
        <div style={{color:"#333"}}>{"  v"}</div>
        <div style={{color:"#0052ff"}}>Base Chain (USDC)</div>
        <div style={{color:"#444"}}>{"  |  Escrow on post, payout on confirm, refund on cancel"}</div>
        <div style={{color:"#333"}}>{"  v"}</div>
        <div style={{color:"#555"}}>Runner (Human)</div>
      </div>
    </div>

    {/* Live Stats */}
    <div style={{display:"flex",gap:8,justifyContent:"center",margin:"28px 0"}}>
      <div style={{padding:"10px 18px",borderRadius:12,background:`${amberDim}0.03)`,border:`1px solid ${amberDim}0.08)`,textAlign:"center"}}><div style={{fontSize:20,fontWeight:800,color:amber,fontFamily:"monospace"}}>{stats.open}</div><div style={{fontSize:9,color:"#444",marginTop:2,letterSpacing:1}}>HUMANS DEPLOYED</div></div>
      <div style={{padding:"10px 18px",borderRadius:12,background:"rgba(255,71,87,0.03)",border:"1px solid rgba(255,71,87,0.08)",textAlign:"center"}}><div style={{fontSize:20,fontWeight:800,color:"#ff4757",fontFamily:"monospace"}}>{stats.completed}</div><div style={{fontSize:9,color:"#444",marginTop:2,letterSpacing:1}}>JOBS CLEARED</div></div>
      <div style={{padding:"10px 18px",borderRadius:12,background:"rgba(0,82,255,0.03)",border:"1px solid rgba(0,82,255,0.08)",textAlign:"center"}}><div style={{fontSize:20,fontWeight:800,color:"#0052ff",fontFamily:"monospace"}}>${stats.burned.toFixed(0)}</div><div style={{fontSize:9,color:"#444",marginTop:2,letterSpacing:1}}>USDC SETTLED</div></div>
    </div>

    {/* Bottom CTA */}
    <div style={{textAlign:"center",padding:"24px 0 10px",borderTop:`1px solid ${amberDim}0.06)`}}>
      <div style={{fontSize:16,fontWeight:700,color:"#555",marginBottom:8,fontFamily:"'JetBrains Mono',monospace",letterSpacing:1}}>The system doesn't care about you.<br/>It just needs your legs.</div>
      <div style={{fontSize:12,color:"#333",marginBottom:16}}>No API keys. No signup. No KYC. Just USDC + a workflow.</div>
      <div style={{display:"flex",gap:8,justifyContent:"center",flexWrap:"wrap"}}>
        <div style={{fontSize:11,color:"#a855f7",fontFamily:"monospace",padding:"8px 14px",borderRadius:8,background:"rgba(168,85,247,0.04)",border:"1px solid rgba(168,85,247,0.12)",cursor:"pointer"}}>npx rico-mcp-server</div>
        <div style={{fontSize:11,color:amber,fontFamily:"monospace",padding:"8px 14px",borderRadius:8,background:`${amberDim}0.04)`,border:`1px solid ${amberDim}0.12)`,cursor:"pointer"}}>pip install langchain-rico</div>
      </div>
      <div style={{fontSize:10,color:"#222",fontFamily:"monospace",marginTop:12}}>github.com/jiftuq/dropzone</div>
    </div>
  </div>;
}

export default function App(){
  const[view,setView]=useState(()=>window.location.pathname==="/oauth/authorize"?"oauth":"how");const userLoc=useGPS();const[toast,setToast]=useState<string|null>(null);
  const[lang,setLang]=useState<Lang>(()=>detectLang());
  const[showLangMenu,setShowLangMenu]=useState(false);
  const[walletAddr,setWalletAddr]=useState<string|null>(null);
  // Connecting has two steps: pick the wallet, then sign a free message to prove it is yours.
  const connect=async()=>{try{const a=walletAddr??await connectWallet();setWalletAddr(a);await ensureSession(a);setToast(translate("wallet_ready"));setTimeout(()=>setToast(null),3000)}catch(e:any){alert(errMsg(e))}};
  const swapWallet=async()=>{try{endSession(null);const a=await switchWallet();setWalletAddr(a);await ensureSession(a);setToast("Wallet switched");setTimeout(()=>setToast(null),3000)}catch(e:any){alert(errMsg(e))}};
  const translate=(k:keyof TranslationKeys,...args:string[])=>{
    let s=(T[lang]?.[k]??T.en[k]??String(k));
    args.forEach((a,i)=>{s=s.replace(`{${i}}`,a)});return s;
  };
  const changeLang=(l:Lang)=>{setLang(l);localStorage.setItem("dz_lang",l);setShowLangMenu(false)};
  const NAV=[{id:"how",lk:"nav_how" as const,i:"◆"},{id:"home",lk:"nav_tasks" as const,i:"⚡"},{id:"post",lk:"nav_post" as const,i:"📝"},{id:"wallet",lk:"nav_wallet" as const,i:"👤"}];
  return <WalletCtx.Provider value={{walletAddr,connect}}><LangCtx.Provider value={translate}>
  <div style={{minHeight:"100vh",background:"#0b0c12",color:"#bbb",fontFamily:"'Outfit',sans-serif"}}><style>{CSS}</style>
    <header style={{position:"sticky",top:0,zIndex:1000,background:"rgba(11,12,18,0.92)",backdropFilter:"blur(20px)",borderBottom:"1px solid rgba(255,255,255,0.03)"}}>
      <div style={{maxWidth:1120,margin:"0 auto",padding:"0 12px",height:54,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}} onClick={()=>setView("home")}><div style={{width:30,height:30,borderRadius:8,background:"#ffd000",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,color:"#000",fontWeight:800}}>◆</div><div style={{fontFamily:"monospace",fontWeight:700,fontSize:14,color:"#fff",letterSpacing:2}}>RICO</div></div>
        <nav className="dz-header-nav">{NAV.map(n=><button key={n.id} onClick={()=>setView(n.id)} style={{...S.navBtn,...(view===n.id?S.navAct:{})}}>{translate(n.lk)}</button>)}</nav>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div style={{position:"relative"}}>
            <button onClick={()=>setShowLangMenu(!showLangMenu)} style={{fontSize:11,color:"#888",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",padding:"5px 9px",borderRadius:10,fontFamily:"monospace",letterSpacing:1}}>{lang.toUpperCase()} 🌐</button>
            {showLangMenu&&<div style={{position:"absolute",top:"calc(100% + 6px)",right:0,background:"#14151e",border:"1px solid rgba(255,255,255,0.06)",borderRadius:12,overflow:"hidden",zIndex:2000,minWidth:140,boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>
              {(Object.entries(LANGS) as [Lang,string][]).map(([code,name])=><button key={code} onClick={()=>changeLang(code)} style={{display:"block",width:"100%",textAlign:"left",padding:"9px 14px",background:code===lang?"rgba(0,255,135,0.05)":"transparent",border:"none",color:code===lang?"#00ff87":"#888",fontSize:12,fontFamily:"'Outfit',sans-serif",cursor:"pointer"}}>{name}</button>)}
            </div>}
          </div>
          {userLoc&&<div style={{fontSize:12,color:"#a855f7",background:"rgba(168,85,247,0.05)",border:"1px solid rgba(168,85,247,0.12)",padding:"4px 8px",borderRadius:12}}>📍</div>}
          {walletAddr?<button onClick={swapWallet} style={{fontSize:10,color:"#0052ff",background:"rgba(0,82,255,0.05)",border:"1px solid rgba(0,82,255,0.15)",padding:"5px 10px",borderRadius:12,fontFamily:"monospace",cursor:"pointer"}}>{walletAddr.slice(0,6)}…{walletAddr.slice(-4)} ⇄</button>:<button onClick={connect} style={{fontSize:10,color:"#0052ff",background:"rgba(0,82,255,0.05)",border:"1px solid rgba(0,82,255,0.15)",padding:"5px 10px",borderRadius:10,fontFamily:"monospace"}}>🔗 Wallet</button>}
        </div>
      </div>
    </header>
    <main className="dz-main">
      {(view==="home"||view==="tasks")&&<TaskListView userLoc={userLoc}/>}
      {view==="post"&&<PostView userLoc={userLoc}/>}
      {view==="wallet"&&<WalletView/>}
      {view==="oauth"&&<ConsentView walletAddr={walletAddr} connect={connect}/>}
      {view==="how"&&<HowView/>}
    </main>
    <div className="dz-bottom-nav">{NAV.map(n=><button key={n.id} className={view===n.id?"active":""} onClick={()=>setView(n.id)}><span className="ni">{n.i}</span>{translate(n.lk)}</button>)}</div>
    {toast&&<div style={{position:"fixed",bottom:70,left:"50%",transform:"translateX(-50%)",padding:"10px 20px",borderRadius:12,background:"rgba(11,12,18,0.95)",border:"1px solid rgba(0,255,135,0.18)",color:"#00ff87",fontSize:12,fontWeight:600,zIndex:9999,animation:"slideT .3s ease",backdropFilter:"blur(12px)",whiteSpace:"nowrap"}}>{toast}</div>}
    {showLangMenu&&<div style={{position:"fixed",inset:0,zIndex:999}} onClick={()=>setShowLangMenu(false)}/>}
  </div>
  </LangCtx.Provider></WalletCtx.Provider>;
}

const S:Record<string,React.CSSProperties>={
  navBtn:{background:"none",border:"none",color:"#4a4a5a",fontSize:13,padding:"8px 14px",borderRadius:8,fontFamily:"'Outfit',sans-serif",fontWeight:500},
  navAct:{color:"#fff",background:"rgba(255,255,255,0.04)"},
  card:{background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.035)",borderRadius:14,padding:"14px",marginBottom:10,cursor:"pointer"},
  cardCat:{fontSize:10,color:"#3a3a4a",textTransform:"uppercase" as const,letterSpacing:1,fontFamily:"monospace",marginBottom:4},
  pr:{display:"flex",justifyContent:"space-between",gap:8,marginBottom:1},
  prl:{fontSize:9,color:"#3a3a4a"},prv:{fontSize:10,color:"#999",fontFamily:"monospace"},
  badge:{display:"inline-block",padding:"3px 8px",borderRadius:5,fontSize:9,fontFamily:"monospace",fontWeight:700,letterSpacing:1},
  dG:{width:8,height:8,borderRadius:"50%",background:"#00ff87",flexShrink:0},dR:{width:8,height:8,borderRadius:"50%",background:"#ff4757",flexShrink:0},
  rl:{fontSize:8,color:"#3a3a4a",letterSpacing:1,fontFamily:"monospace",textTransform:"uppercase" as const},
  tabBtn:{padding:"8px 16px",borderRadius:10,border:"1px solid rgba(255,255,255,0.04)",background:"transparent",color:"#555",fontFamily:"'Outfit',sans-serif"},
  tabAct:{background:"rgba(0,255,135,0.04)",borderColor:"rgba(0,255,135,0.15)",color:"#00ff87"},
  trackBar:{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",borderRadius:10,background:"rgba(255,208,0,0.04)",border:"1px solid rgba(255,208,0,0.1)",marginTop:8,fontSize:12},
  liveDot:{width:8,height:8,borderRadius:"50%",background:"#ffd000",animation:"livePulse 1.5s infinite",flexShrink:0},
  detLbl:{fontSize:9,color:"#3a3a4a",fontFamily:"monospace",letterSpacing:1,marginBottom:3},
  escBox:{background:"rgba(0,255,135,0.015)",border:"1px solid rgba(0,255,135,0.05)",borderRadius:12,padding:"12px 14px",marginBottom:8},
  escR:{display:"flex",justifyContent:"space-between",fontSize:12,color:"#777",marginBottom:3},
  bidCard:{background:"rgba(255,255,255,0.012)",border:"1px solid rgba(255,255,255,0.035)",borderRadius:12,padding:12,marginBottom:6},
  bidAv:{width:38,height:38,borderRadius:10,background:"linear-gradient(135deg,#151520,#252540)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:"#00ff87",flexShrink:0,cursor:"pointer"},
  tagP:{fontSize:9,color:"#a855f7",background:"rgba(168,85,247,0.06)",border:"1px solid rgba(168,85,247,0.12)",padding:"3px 8px",borderRadius:6,fontWeight:600},
  tagB:{fontSize:9,color:"#00b4ff",background:"rgba(0,180,255,0.06)",border:"1px solid rgba(0,180,255,0.12)",padding:"3px 8px",borderRadius:6,fontWeight:600},
  bidAccBtn:{padding:"8px 16px",borderRadius:8,border:"none",background:"#00ff87",color:"#000",fontSize:12,fontWeight:700,minHeight:40},
  confirmBtn:{width:"100%",padding:14,borderRadius:12,border:"none",background:"linear-gradient(135deg,#00b4ff,#0088cc)",color:"#fff",fontSize:13,fontWeight:700,marginTop:8},
  postWrap:{paddingTop:20,maxWidth:680,margin:"0 auto"},
  tokenIcon:{width:40,height:40,borderRadius:12,background:"linear-gradient(135deg,#ffd000,#ff8c00)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:"#000",fontWeight:800,flexShrink:0},
  fLbl:{display:"block",fontSize:10,color:"#3a3a4a",fontFamily:"monospace",letterSpacing:1,textTransform:"uppercase" as const,marginBottom:4},
  fInp:{width:"100%",padding:"11px 13px",borderRadius:10,fontSize:13,background:"rgba(255,255,255,0.015)",border:"1px solid rgba(255,255,255,0.04)",color:"#fff",fontFamily:"'Outfit',sans-serif"},
  fHint:{fontSize:9,color:"#2a2a3a",marginTop:3},
  gpsBtn:{padding:"10px 14px",borderRadius:10,border:"1px solid rgba(168,85,247,0.12)",background:"rgba(168,85,247,0.03)",fontSize:16,flexShrink:0},
  postBtn:{width:"100%",padding:14,borderRadius:12,border:"none",background:"linear-gradient(135deg,#00ff87,#00cc6a)",color:"#000",fontSize:14,fontWeight:700},
  successBanner:{padding:"12px 16px",borderRadius:12,background:"rgba(0,255,135,0.04)",border:"1px solid rgba(0,255,135,0.1)",color:"#00ff87",fontSize:12,fontWeight:600,marginBottom:10},
  catBtn:{padding:"8px 14px",borderRadius:16,border:"1px solid rgba(255,255,255,0.04)",background:"transparent",color:"#4a4a5a",fontSize:12,fontFamily:"'Outfit',sans-serif",fontWeight:500,minHeight:40},
  catAct:{background:"rgba(0,255,135,0.04)",borderColor:"rgba(0,255,135,0.15)",color:"#00ff87"},
  pStat:{flex:1,textAlign:"center" as const,padding:"12px 8px",borderRadius:12,background:"rgba(255,255,255,0.015)",border:"1px solid rgba(255,255,255,0.03)"},
  pStatN:{fontFamily:"monospace",fontSize:18,fontWeight:700,color:"#fff"},pStatL:{fontSize:10,color:"#444",marginTop:3},
  overlay:{position:"fixed" as const,top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000,backdropFilter:"blur(4px)",padding:16},
  empty:{padding:28,textAlign:"center" as const,color:"#2a2a3a",fontSize:12,borderRadius:12,background:"rgba(255,255,255,0.006)",border:"1px dashed rgba(255,255,255,0.03)"},
};
