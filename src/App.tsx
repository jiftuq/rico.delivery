import { useState, useEffect, useRef, createContext, useContext } from "react";
import { Id } from "../convex/_generated/dataModel";
import { useUser, useGPS, useOpenTasks, useActiveTasks, useBids, useChat, useProfile, useStats, useTaskActions, useCourierTracking, useCourierHistory, usePosterHistory, useTaskRunners } from "./hooks/useDropZone";
import { TILES, CATS, STS, fuzzLoc, maskAddr, haversine, getRoute } from "./lib/utils";
import { T, LANGS, Lang, TranslationKeys, detectLang } from "./lib/i18n";
import L from "leaflet";
import { connectWallet, payFetch, SERVER_URL } from "./lib/wallet";

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

function ChatPanel({taskId,userId,myRole}:{taskId:Id<"tasks">;userId:Id<"users">;myRole:string}){
  const t=useLang();const{messages,send}=useChat(taskId);const[msg,setMsg]=useState("");const endRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{endRef.current?.scrollIntoView({behavior:"smooth"})},[messages.length]);
  const doSend=()=>{if(!msg.trim())return;send(userId,msg.trim());setMsg("")};
  return <div style={{borderRadius:12,border:"1px solid rgba(255,255,255,0.04)",overflow:"hidden"}}>
    <div style={{padding:"10px 14px",background:"rgba(255,255,255,0.02)",borderBottom:"1px solid rgba(255,255,255,0.03)",fontSize:13,fontWeight:600,color:"#fff"}}>💬 {t("chat")}</div>
    <div style={{maxHeight:280,overflowY:"auto",padding:"10px 14px",WebkitOverflowScrolling:"touch"}}>
      {messages.length===0&&<div style={S.empty}>{t("no_messages")}</div>}
      {messages.map((m,i)=><div key={i} style={{maxWidth:"85%",padding:"10px 14px",borderRadius:14,marginBottom:6,...(m.role===myRole?{background:"rgba(0,255,135,0.06)",borderBottomRightRadius:4,marginLeft:"auto"}:{background:"rgba(255,255,255,0.03)",borderBottomLeftRadius:4})}}>
        <div style={{fontSize:10,fontWeight:600,color:"#666",marginBottom:2}}>{m.senderName}</div>
        <div style={{fontSize:13,color:"#ddd",lineHeight:1.5}}>{m.text}</div></div>)}
      <div ref={endRef}/>
    </div>
    <div style={{display:"flex",gap:8,padding:"10px 12px",background:"rgba(255,255,255,0.015)",borderTop:"1px solid rgba(255,255,255,0.03)"}}>
      <input style={{...S.fInp,flex:1,fontSize:14,padding:"12px 14px"}} placeholder={t("message_ph")} value={msg} onChange={e=>setMsg(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSend()}/>
      <button style={{width:44,height:44,borderRadius:10,border:"none",background:"#00ff87",color:"#000",fontSize:18,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}} onClick={doSend}>↑</button>
    </div></div>;
}

function RatingModal({name,onRate,onClose}:{name:string;onRate:(s:number,c:string)=>void;onClose:()=>void}){
  const t=useLang();const[score,setScore]=useState(5);const[text,setText]=useState("");
  return <div style={S.overlay} onClick={onClose}><div style={{background:"#14151e",borderRadius:18,padding:"28px 20px",maxWidth:360,width:"92%",border:"1px solid rgba(255,255,255,0.06)"}} onClick={e=>e.stopPropagation()}>
    <div style={{fontSize:20,fontWeight:700,color:"#fff",textAlign:"center",marginBottom:14}}>{t("rate")} {name}</div>
    <div style={{display:"flex",justifyContent:"center",gap:10,marginBottom:14}}>
      {[1,2,3,4,5].map(n=><button key={n} onClick={()=>setScore(n)} style={{background:"none",border:"none",fontSize:36,color:n<=score?"#ffd000":"#2a2a3a",padding:4,minWidth:44,minHeight:44}}>★</button>)}
    </div>
    <textarea style={{...S.fInp,minHeight:70,fontSize:14,marginBottom:14}} placeholder={t("review_ph")} value={text} onChange={e=>setText(e.target.value)}/>
    <button style={{...S.postBtn,background:"linear-gradient(135deg,#ffd000,#ff8c00)"}} onClick={()=>{onRate(score,text);onClose()}}>{t("submit")}</button>
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
  const t=useLang();const{walletAddr,connect}=useWalletCtx();const{user,userId}=useUser(walletAddr);const bids=useBids(task._id);const actions=useTaskActions();
  const[open,setOpen]=useState(false);const[tab,setTab]=useState<"details"|"chat">("details");
  const[bidFee,setBidFee]=useState("");const[bidComment,setBidComment]=useState("");
  const[showRating,setShowRating]=useState<{name:string;runnerId?:string}|null>(null);const[profileId,setProfileId]=useState<Id<"users">|null>(null);
  const[routeKm,setRouteKm]=useState<string|null>(null);const[proofText,setProofText]=useState("");
  const profile=useProfile(profileId);const st=STS[task.status]||STS.open;
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
  useCourierTracking(isTracking&&isActiveRunner?task._id:null,isActiveRunner&&userId?userId:null,!!isTracking&&isActiveRunner);
  useEffect(()=>{if(!open||!userLoc||task.status!=="open")return;if(isDel){getRoute([[userLoc[0],userLoc[1]],[task.pickupLat,task.pickupLng],[task.dropoffLat,task.dropoffLng]]).then(r=>r&&setRouteKm(r.km))}else{getRoute([[userLoc[0],userLoc[1]],[locLat,locLng]]).then(r=>r&&setRouteKm(r.km))}},[open,userLoc]);
  const bidMap=bids.filter((b:any)=>b.lat&&b.lng).map((b:any)=>({name:b.courierName,lat:b.lat,lng:b.lng,fee:b.fee,score:b.courierScore}));
  const submitBid=async()=>{if(!bidFee||!userId||!userLoc)return;let tripKm:number;if(isDel){const route=await getRoute([[userLoc[0],userLoc[1]],[task.pickupLat,task.pickupLng],[task.dropoffLat,task.dropoffLng]]);tripKm=route?parseFloat(route.km):Math.round((haversine(userLoc,[task.pickupLat,task.pickupLng])+haversine([task.pickupLat,task.pickupLng],[task.dropoffLat,task.dropoffLng]))*10)/10}else{const route=await getRoute([[userLoc[0],userLoc[1]],[locLat,locLng]]);tripKm=route?parseFloat(route.km):Math.round(haversine(userLoc,[locLat,locLng])*10)/10}actions.placeBid({taskId:task._id,courierId:userId,fee:parseFloat(bidFee),comment:bidComment||"Ready!",lat:userLoc[0],lng:userLoc[1],tripKm});setBidFee("");setBidComment("")};
  const doAcceptBid=async(bidId:string)=>{if(!walletAddr){await connect();return;}try{const r=await payFetch(`${SERVER_URL}/accept-bid`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({taskId:task._id,bidId,posterId:userId})});if(!r.ok){const e=await r.json();throw new Error(e.error)}}catch(e:any){alert(e.message)}};
  const doCancel=async()=>{if(!confirm(`Cancel task and refund $${total.toFixed(2)} USDC?`))return;try{const r=await fetch(`${SERVER_URL}/cancel-task`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({taskId:task._id,posterId:userId})});if(!r.ok){const e=await r.json();throw new Error(e.error)}}catch(e:any){alert(e.message)}};
  const doSubmitProof=()=>{if(!isCourier||!userId)return;actions.markDelivered({taskId:task._id,courierId:userId,proofData:proofText||undefined});setProofText("")};

  return <div style={{...S.card,borderLeft:`3px solid ${st.c}`}} onClick={()=>setOpen(!open)}>
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
      {tab==="chat"&&chatActive&&userId&&canSee?<ChatPanel taskId={task._id} userId={userId} myRole={isOwner?"poster":"courier"}/>:<>
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
            <button style={{padding:"12px 16px",borderRadius:10,border:"1px solid rgba(0,180,255,0.2)",background:"rgba(0,180,255,0.04)",color:"#00b4ff",fontSize:12,fontWeight:600,fontFamily:"'Outfit',sans-serif"}} onClick={()=>{const txt=`${task.title} — $${total.toFixed(2)} USDC\n${CATS.find(c=>c.id===task.category)?.i||"⚡"} ${task.category}${isDel?` · ${t("pickup_lbl")}: ${task.pickupAddr}`:` · ${t("location_lbl")}: ${locAddr}`}\n${isDel?t("delivery_lbl"):t("runner_fee")}: $${task.suggestedFee.toFixed(2)} USDC\n\n${window.location.origin}`;if(navigator.share){navigator.share({title:`GIGS.MOM: ${task.title}`,text:txt,url:window.location.origin})}else{navigator.clipboard.writeText(txt);alert(t("link_copied"))}}}>↗ {t("share")}</button>
          </div>}
          {!isOwner&&userId&&userLoc&&<div style={{marginTop:10,padding:14,background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.035)",borderRadius:12}}>
            <div style={{fontSize:13,fontWeight:600,color:"#fff",marginBottom:10}}>{t("place_bid")}</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}><div style={{flex:"1 1 100px"}}><label style={S.fLbl}>{t("fee_lbl")}</label><input style={{...S.fInp,fontSize:14,padding:12}} placeholder={String(task.suggestedFee)} value={bidFee} onChange={e=>setBidFee(e.target.value)}/></div><div style={{flex:"2 1 160px"}}><label style={S.fLbl}>{t("comment_lbl")}</label><input style={{...S.fInp,fontSize:14,padding:12}} placeholder={t("comment_ph")} value={bidComment} onChange={e=>setBidComment(e.target.value)}/></div></div>
            {routeKm&&<div style={{fontSize:11,color:"#00b4ff",marginTop:8}}>🛣 ~{routeKm} {isDel?t("road_km"):t("road_km_single")}</div>}
            <button style={{...S.postBtn,marginTop:8,padding:14,fontSize:13}} onClick={submitBid}>⚡ {t("submit_bid")}</button>
          </div>}
        </div>}
        {task.status==="in_progress"&&!multi&&task.courierName&&<div style={{...S.trackBar,marginTop:8}}><div style={S.liveDot}/><span style={{color:"#ffd000",fontWeight:700,flex:1}}>{isDel?"🚴":"🏃"} {task.courierName}</span>
          {isCourier&&(isDel?<button style={{...S.bidAccBtn,minHeight:40}} onClick={()=>actions.markDelivered({taskId:task._id,courierId:userId!})}>📦 {t("mark_delivered")}</button>
          :<div style={{display:"flex",gap:6,alignItems:"center"}}>
            {task.proofType&&task.proofType!=="none"&&<input style={{...S.fInp,fontSize:12,padding:"8px 10px",width:140}} placeholder={t("proof_ph")} value={proofText} onChange={e=>setProofText(e.target.value)}/>}
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
              {task.proofType&&task.proofType!=="none"&&<input style={{...S.fInp,fontSize:11,padding:"6px 8px",width:100}} placeholder={t("proof_ph")} value={proofText} onChange={e=>setProofText(e.target.value)}/>}
              <button style={{...S.bidAccBtn,fontSize:10,padding:"6px 10px",minHeight:30}} onClick={doSubmitProof}>✅</button>
            </div>}
            {/* Poster can confirm delivered runners */}
            {isOwner&&tr.status==="delivered"&&<button style={{...S.bidAccBtn,fontSize:10,padding:"6px 10px",minHeight:30}} onClick={()=>setShowRating({name:tr.runnerName,runnerId:tr.runnerId})}>✓ Confirm</button>}
            {tr.status==="completed"&&<span style={{fontSize:10,color:"#00ff87",fontWeight:700}}>✓</span>}
          </div>)}
        </div>}
        {task.status==="delivered"&&isOwner&&!multi&&<button style={{...S.confirmBtn,padding:16,fontSize:14}} onClick={()=>setShowRating({name:task.courierName||"Runner"})}>✓ {t("confirm")} · ${total.toFixed(2)} USDC</button>}
        {task.status==="delivered"&&isCourier&&!multi&&<div style={{padding:12,borderRadius:12,background:"rgba(0,180,255,0.04)",border:"1px solid rgba(0,180,255,0.12)",marginTop:8,fontSize:12,color:"#00b4ff"}}>⏳ Waiting for poster to confirm. Auto-releases in 2 hours.</div>}
        {task.proofData&&!multi&&<div style={{padding:10,borderRadius:10,background:"rgba(168,85,247,0.04)",border:"1px solid rgba(168,85,247,0.12)",marginTop:8,fontSize:12,color:"#a855f7"}}>📸 {t("proof_lbl")}: {task.proofData}</div>}
        {(task.status==="in_progress"||task.status==="delivered")&&canSee&&<button style={{width:"100%",padding:12,borderRadius:10,border:"1px solid rgba(255,165,0,0.2)",background:"rgba(255,165,0,0.04)",color:"#ffa500",fontSize:12,fontWeight:600,fontFamily:"'Outfit',sans-serif",marginTop:8}} onClick={()=>{const reason=prompt("Describe the issue:");if(reason&&userId)actions.openDispute({taskId:task._id,userId,reason})}}>⚠️ Open Dispute</button>}
        {task.status==="disputed"&&<div style={{padding:14,borderRadius:12,background:"rgba(255,165,0,0.06)",border:"1px solid rgba(255,165,0,0.2)",marginTop:8}}><div style={{fontSize:13,fontWeight:700,color:"#ffa500",marginBottom:4}}>⚠️ Disputed</div><div style={{fontSize:12,color:"#999"}}>Opened by {task.disputeBy}: "{task.disputeReason}"</div><div style={{fontSize:11,color:"#666",marginTop:4}}>Funds are held until resolved. Contact support.</div></div>}
      </>}
      {profileId&&profile&&<ProfilePopup profile={profile} onClose={()=>setProfileId(null)}/>}
      {showRating&&<RatingModal name={showRating.name} onRate={async(s,c)=>{try{const body:any={taskId:task._id,posterId:userId,ratingScore:s,ratingComment:c};if(showRating.runnerId)body.runnerId=showRating.runnerId;const r=await fetch(`${SERVER_URL}/confirm-delivery`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(!r.ok){const e=await r.json();throw new Error(e.error)}}catch(e:any){alert(e.message)}}} onClose={()=>setShowRating(null)}/>}
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
      <div style={{fontSize:10,color:"#666",lineHeight:1.6,fontFamily:"monospace"}}>POST /task + X-Payment header (x402 USDC on Base) → task created → runners bid → proof submitted → USDC released</div>
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

const TASK_TYPES=[
  {id:"delivery",l:"Delivery",i:"📦",needsDropoff:true,needsItems:true},
  {id:"go-somewhere",l:"Go Somewhere",i:"📍",needsDropoff:false,needsItems:false},
  {id:"interact",l:"Interact",i:"🤝",needsDropoff:false,needsItems:false},
  {id:"gather-info",l:"Gather Info",i:"🔍",needsDropoff:false,needsItems:false},
  {id:"physical-action",l:"Physical",i:"💪",needsDropoff:false,needsItems:false},
  {id:"verification",l:"Verify",i:"✅",needsDropoff:false,needsItems:false},
];
const PROOF_TYPES=["photo","video","text","gps","none"];

function PostView({userLoc}:{userLoc:[number,number]|null}){
  const t=useLang();const{walletAddr,connect}=useWalletCtx();const{user,userId}=useUser(walletAddr);const{createTask}=useTaskActions();
  const[taskType,setTaskType]=useState("delivery");
  const[f,sF]=useState({title:"",pickupAddr:"",dropoffAddr:"",locationAddr:"",suggestedFee:"",details:"",action:"",category:"delivery",privacyZone:"100",proofType:"photo",targetPerson:""});
  const[items,setItems]=useState([{name:"",cost:""}]);const[maxRunners,setMaxRunners]=useState("1");
  const[moving,setMoving]=useState({apartmentSize:"1br",floorFrom:"0",floorTo:"0",elevatorFrom:false,elevatorTo:false,vehicleType:"van",inventoryList:"",moveDate:""});
  const isMoving=taskType==="delivery"&&f.category==="moving";
  const setMov=(k:string)=>(e:any)=>setMoving(p=>({...p,[k]:typeof e==="boolean"?e:e.target.value}));
  const[ok,setOk]=useState(false);const[pLat,sPLat]=useState(0);const[pLng,sPLng]=useState(0);const[dLat,sDLat]=useState(0);const[dLng,sDLng]=useState(0);const[lLat,sLLat]=useState(0);const[lLng,sLLng]=useState(0);
  const set=(k:string)=>(e:any)=>sF({...f,[k]:e.target.value});
  const setItem=(i:number,k:string,v:string)=>setItems(items.map((it,idx)=>idx===i?{...it,[k]:v}:it));
  const addItem=()=>setItems([...items,{name:"",cost:""}]);
  const removeItem=(i:number)=>setItems(items.filter((_,idx)=>idx!==i));
  const tt=TASK_TYPES.find(x=>x.id===taskType)||TASK_TYPES[0];
  const itemCostTotal=(tt.needsItems&&!isMoving)?items.reduce((s,it)=>s+(parseFloat(it.cost)||0),0):0;
  const nRunners=Math.max(1,parseInt(maxRunners)||1);
  const feePerRunner=parseFloat(f.suggestedFee)||0;
  const total=(isMoving||nRunners>1)?feePerRunner*nRunners:itemCostTotal+feePerRunner;
  const onPickup=(addr:string,lat:number,lng:number)=>{sF(p=>({...p,pickupAddr:addr}));sPLat(lat);sPLng(lng)};
  const onDropoff=(addr:string,lat:number,lng:number)=>{sF(p=>({...p,dropoffAddr:addr}));sDLat(lat);sDLng(lng)};
  const onLocation=(addr:string,lat:number,lng:number)=>{sF(p=>({...p,locationAddr:addr}));sLLat(lat);sLLng(lng)};
  const submit=async()=>{
    if(!f.title||!userId)return;
    if(taskType==="delivery"&&(!f.pickupAddr||!f.dropoffAddr))return;
    if(taskType!=="delivery"&&!f.locationAddr)return;
    if(taskType==="delivery"&&!isMoving){const validItems=items.filter(it=>it.name&&parseFloat(it.cost)>0);if(validItems.length===0)return;}
    if(!walletAddr){await connect();return;}
    try{
      const body:any={title:f.title,category:f.category,details:f.details||f.action||"No instructions.",taskType,privacyZone:parseInt(f.privacyZone)||100,suggestedFee:feePerRunner,maxRunners:nRunners,posterId:userId};
      if(taskType==="delivery"){
        const validItems=items.filter(it=>it.name&&parseFloat(it.cost)>0);
        Object.assign(body,{pickupAddr:f.pickupAddr,pickupLat:pLat||50.85,pickupLng:pLng||4.35,dropoffAddr:f.dropoffAddr,dropoffLat:dLat||50.85,dropoffLng:dLng||4.35,itemCost:isMoving?0:itemCostTotal,items:isMoving?[]:validItems.map(it=>({name:it.name,cost:parseFloat(it.cost)}))});
        if(isMoving){body.movingDetails={apartmentSize:moving.apartmentSize,floorFrom:parseInt(moving.floorFrom)||0,floorTo:parseInt(moving.floorTo)||0,elevatorFrom:moving.elevatorFrom,elevatorTo:moving.elevatorTo,vehicleType:moving.vehicleType,inventoryList:moving.inventoryList||undefined,moveDate:moving.moveDate||undefined};body.maxRunners=nRunners;}
      }else{
        Object.assign(body,{locationAddr:f.locationAddr,locationLat:lLat||50.85,locationLng:lLng||4.35,action:f.action,proofType:f.proofType,targetPerson:f.targetPerson||undefined});
      }
      const res=await payFetch(`${SERVER_URL}/task`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      if(!res.ok){const e=await res.json();throw new Error(e.error);}
      setOk(true);setTimeout(()=>setOk(false),3500);
      sF({title:"",pickupAddr:"",dropoffAddr:"",locationAddr:"",suggestedFee:"",details:"",action:"",category:taskType==="delivery"?"delivery":f.category,privacyZone:"100",proofType:"photo",targetPerson:""});
      setItems([{name:"",cost:""}]);setMaxRunners("1");sPLat(0);sPLng(0);sDLat(0);sDLng(0);sLLat(0);sLLng(0);
    }catch(e:any){alert(e.message);}
  };
  const typeBtnS=(active:boolean):any=>({padding:"8px 14px",borderRadius:10,border:active?"1px solid #00ff87":"1px solid rgba(255,255,255,0.06)",background:active?"rgba(0,255,135,0.08)":"rgba(255,255,255,0.015)",color:active?"#00ff87":"#888",fontSize:12,fontWeight:active?700:500,fontFamily:"'Outfit',sans-serif",whiteSpace:"nowrap"});
  return <div style={S.postWrap}><h2 style={{fontSize:22,fontWeight:700,color:"#fff"}}>{t("post_title")}</h2>
    {ok&&<div style={S.successBanner}>✓ {t("posted_ok",total.toFixed(2))}</div>}
    {!walletAddr&&<div style={{padding:14,borderRadius:12,background:"rgba(0,82,255,0.04)",border:"1px solid rgba(0,82,255,0.12)",marginTop:12,textAlign:"center"}}><span style={{color:"#0052ff",fontSize:13}}>{t("connect_to_use")}</span></div>}
    <div style={{display:"flex",gap:6,marginTop:14,marginBottom:4,overflowX:"auto",paddingBottom:4}}>
      {TASK_TYPES.map(tp=><button key={tp.id} onClick={()=>{setTaskType(tp.id);sF(p=>({...p,category:tp.id==="delivery"?"delivery":tp.id}))}} style={typeBtnS(taskType===tp.id)}>{tp.i} {tp.l}</button>)}
    </div>
    <div className="dz-form-grid">
      <div><label style={S.fLbl}>{t("what")}</label><input style={{...S.fInp,fontSize:14,padding:12}} placeholder={taskType==="delivery"?t("what_ph"):"Task title..."} value={f.title} onChange={set("title")}/></div>
      {taskType!=="delivery"&&<div><label style={S.fLbl}>Category</label><select style={{...S.fInp,fontSize:14,padding:12}} value={f.category} onChange={set("category")}><option value="errand">🏃 Errand</option><option value="social">👋 Social</option><option value="info">🔍 Info</option><option value="verification">✅ Verify</option><option value="custom">⚙️ Custom</option></select></div>}
      {taskType==="delivery"&&<div><label style={S.fLbl}>{t("category")}</label><select style={{...S.fInp,fontSize:14,padding:12}} value={f.category} onChange={set("category")}><option value="delivery">📦 Delivery</option><option value="food">🍔 {t("food")}</option><option value="grocery">🛒 {t("grocery")}</option><option value="moving">🚚 {t("moving")}</option><option value="errand">📦 {t("errand")}</option></select></div>}
      {taskType==="delivery"&&<>
        <div style={{gridColumn:"1/-1"}}><label style={S.fLbl}>{isMoving?"🏠 Moving from":"📍 "+t("pickup")}</label><AddressMapPicker label={isMoving?"Current address":t("pickup_ph")} value={f.pickupAddr} lat={pLat} lng={pLng} onSelect={onPickup} userLoc={userLoc}/></div>
        <div style={{gridColumn:"1/-1"}}><label style={S.fLbl}>{isMoving?"🏠 Moving to":"📍 "+t("dropoff")}</label><AddressMapPicker label={isMoving?"New address":t("dropoff_ph")} value={f.dropoffAddr} lat={dLat} lng={dLng} onSelect={onDropoff} userLoc={userLoc}/></div>
        {isMoving&&<>
          <div><label style={S.fLbl}>🏠 Apartment size</label><select style={{...S.fInp,fontSize:14,padding:12}} value={moving.apartmentSize} onChange={setMov("apartmentSize")}><option value="studio">Studio</option><option value="1br">1 Bedroom</option><option value="2br">2 Bedrooms</option><option value="3br">3 Bedrooms</option><option value="4br+">4+ Bedrooms</option><option value="office">Office</option><option value="storage">Storage unit</option></select></div>
          <div><label style={S.fLbl}>🚚 Vehicle needed</label><select style={{...S.fInp,fontSize:14,padding:12}} value={moving.vehicleType} onChange={setMov("vehicleType")}><option value="van">Van</option><option value="truck">Truck</option><option value="any">Any vehicle</option></select></div>
          <div><label style={S.fLbl}>⬆️ Floor (from)</label><div style={{display:"flex",gap:6,alignItems:"center"}}><input type="number" min="0" max="50" style={{...S.fInp,fontSize:14,padding:12,flex:1}} placeholder="0" value={moving.floorFrom} onChange={setMov("floorFrom")}/><label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"#888",whiteSpace:"nowrap"}}><input type="checkbox" checked={moving.elevatorFrom} onChange={e=>setMoving(p=>({...p,elevatorFrom:e.target.checked}))}/>Elevator</label></div></div>
          <div><label style={S.fLbl}>⬇️ Floor (to)</label><div style={{display:"flex",gap:6,alignItems:"center"}}><input type="number" min="0" max="50" style={{...S.fInp,fontSize:14,padding:12,flex:1}} placeholder="0" value={moving.floorTo} onChange={setMov("floorTo")}/><label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"#888",whiteSpace:"nowrap"}}><input type="checkbox" checked={moving.elevatorTo} onChange={e=>setMoving(p=>({...p,elevatorTo:e.target.checked}))}/>Elevator</label></div></div>
          <div><label style={S.fLbl}>📅 Move date</label><input type="date" style={{...S.fInp,fontSize:14,padding:12}} value={moving.moveDate} onChange={setMov("moveDate")}/></div>
          <div><label style={S.fLbl}>👥 Movers needed</label><input type="number" min="1" max="20" style={{...S.fInp,fontSize:14,padding:12}} placeholder="2" value={maxRunners} onChange={e=>setMaxRunners(e.target.value)}/>{nRunners>1&&<div style={{fontSize:9,color:"#ffd000",marginTop:3}}>⚡ {nRunners} movers × ${feePerRunner.toFixed(2)} = ${total.toFixed(2)} USDC total</div>}</div>
          <div style={{gridColumn:"1/-1"}}><label style={S.fLbl}>📋 What's being moved?</label><textarea style={{...S.fInp,minHeight:70,fontSize:14,padding:12,resize:"vertical",fontFamily:"inherit"}} placeholder="e.g. 2 sofas, dining table + 4 chairs, queen bed, 15 boxes, washing machine..." value={moving.inventoryList} onChange={setMov("inventoryList")}/></div>
        </>}
      </>}
      {taskType!=="delivery"&&<>
        <div style={{gridColumn:"1/-1"}}><label style={S.fLbl}>📍 Location</label><AddressMapPicker label="Where should the runner go?" value={f.locationAddr} lat={lLat} lng={lLng} onSelect={onLocation} userLoc={userLoc}/></div>
        <div style={{gridColumn:"1/-1"}}><label style={S.fLbl}>🎯 Action</label><textarea style={{...S.fInp,minHeight:70,fontSize:14,padding:12,resize:"vertical",fontFamily:"inherit"}} placeholder="What should the runner do there?" value={f.action} onChange={set("action")}/></div>
        <div><label style={S.fLbl}>📸 Proof type</label><select style={{...S.fInp,fontSize:14,padding:12}} value={f.proofType} onChange={set("proofType")}>{PROOF_TYPES.map(p=><option key={p} value={p}>{p==="photo"?"📸 Photo":p==="video"?"🎥 Video":p==="text"?"📝 Text":p==="gps"?"📍 GPS":p==="none"?"— None":p}</option>)}</select></div>
        {(taskType==="interact"||taskType==="verification")&&<div><label style={S.fLbl}>👤 Target person</label><input style={{...S.fInp,fontSize:14,padding:12}} placeholder="Who to meet or verify?" value={f.targetPerson} onChange={set("targetPerson")}/></div>}
      </>}
      <div><label style={S.fLbl}>{taskType==="delivery"?t("delivery_fee"):"💰 Runner fee (USDC)"}</label><input style={{...S.fInp,fontSize:14,padding:12}} placeholder="5.00" value={f.suggestedFee} onChange={set("suggestedFee")}/></div>
      {taskType!=="delivery"&&<div><label style={S.fLbl}>👥 Runners needed</label><input type="number" min="1" max="100" style={{...S.fInp,fontSize:14,padding:12}} placeholder="1" value={maxRunners} onChange={e=>setMaxRunners(e.target.value)}/>{nRunners>1&&<div style={{fontSize:9,color:"#ffd000",marginTop:3}}>⚡ {nRunners} runners × ${feePerRunner.toFixed(2)} = ${total.toFixed(2)} USDC total</div>}</div>}
      <div><label style={S.fLbl}>{t("privacy")}</label><select style={{...S.fInp,fontSize:14,padding:12}} value={f.privacyZone} onChange={set("privacyZone")}><option value="100">{t("privacy_100")}</option><option value="200">{t("privacy_200")}</option><option value="300">{t("privacy_300")}</option><option value="500">{t("privacy_500")}</option></select></div>
      {taskType==="delivery"&&<div style={{gridColumn:"1/-1"}}><label style={S.fLbl}>{t("instructions")}</label><textarea style={{...S.fInp,minHeight:70,fontSize:14,padding:12,resize:"vertical",fontFamily:"inherit"}} placeholder={t("instructions_ph")} value={f.details} onChange={set("details")}/></div>}
    </div>
    {tt.needsItems&&!isMoving&&<div style={{marginTop:14}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}><label style={S.fLbl}>🛒 {t("items")}</label><button style={{fontSize:11,padding:"5px 12px",borderRadius:8,border:"1px solid rgba(0,255,135,0.15)",background:"rgba(0,255,135,0.04)",color:"#00ff87",fontFamily:"'Outfit',sans-serif"}} onClick={addItem}>{t("add_item")}</button></div>
      {items.map((it,i)=><div key={i} style={{display:"flex",gap:6,marginBottom:6,alignItems:"center"}}>
        <input style={{...S.fInp,flex:2,fontSize:13,padding:"10px 12px"}} placeholder={t("item_name")} value={it.name} onChange={e=>setItem(i,"name",e.target.value)}/>
        <input style={{...S.fInp,flex:1,fontSize:13,padding:"10px 12px"}} placeholder={t("cost")} value={it.cost} onChange={e=>setItem(i,"cost",e.target.value)}/>
        {items.length>1&&<button style={{width:34,height:34,borderRadius:8,border:"1px solid rgba(255,71,87,0.15)",background:"rgba(255,71,87,0.04)",color:"#ff4757",flexShrink:0,fontSize:14}} onClick={()=>removeItem(i)}>✕</button>}
      </div>)}
    </div>}
    <div style={{...S.escBox,marginTop:12}}>
      {isMoving&&<>
        <div style={S.escR}><span>🏠 {moving.apartmentSize.toUpperCase()}</span><span>🚚 {moving.vehicleType}</span></div>
        {(parseInt(moving.floorFrom)||0)>0&&<div style={S.escR}><span>⬆️ Floor {moving.floorFrom}{moving.elevatorFrom?" (elevator)":""}</span><span>→</span></div>}
        {(parseInt(moving.floorTo)||0)>0&&<div style={S.escR}><span>⬇️ Floor {moving.floorTo}{moving.elevatorTo?" (elevator)":""}</span><span></span></div>}
        {moving.moveDate&&<div style={S.escR}><span>📅 {moving.moveDate}</span><span></span></div>}
        <div style={{height:1,background:"rgba(255,255,255,0.04)",margin:"4px 0"}}/>
      </>}
      {tt.needsItems&&!isMoving&&items.filter(it=>it.name&&parseFloat(it.cost)>0).map((it,i)=><div key={i} style={S.escR}><span>{it.name}</span><span>{parseFloat(it.cost).toFixed(1)}</span></div>)}
      <div style={S.escR}><span>{isMoving?`🚚 ${nRunners} mover${nRunners>1?"s":""}`:taskType==="delivery"?"🚴 "+t("delivery_lbl"):"🏃 Runner fee"}{!isMoving&&nRunners>1?` × ${nRunners}`:""}</span><span>{(isMoving||nRunners>1)?`${feePerRunner||0} × ${nRunners}`:(f.suggestedFee||"0")}</span></div>
      <div style={{height:1,background:"rgba(255,255,255,0.04)",margin:"4px 0"}}/><div style={S.escR}><span style={{fontWeight:700}}>🔒 {t("total")}</span><span style={{fontWeight:700,color:"#00ff87"}}>${total.toFixed(2)} USDC</span></div>
    </div>
    {!walletAddr&&<button style={{...S.postBtn,marginTop:12,background:"linear-gradient(135deg,#0052ff,#0066ff)"}} onClick={connect}>🔗 Connect Wallet to Post</button>}
    {walletAddr&&<button style={{...S.postBtn,padding:16,fontSize:15,marginTop:16}} onClick={submit}>🔒 {t("post_btn")} · {total>0?"$"+total.toFixed(2)+" USDC":""}</button>}
  </div>;
}

function WalletView(){
  const t=useLang();const{walletAddr,connect}=useWalletCtx();const{user}=useUser(walletAddr);const stats=useStats();
  const courierHist=useCourierHistory(user?._id??null);
  const posterHist=usePosterHistory(user?._id??null);
  if(!walletAddr)return<div style={S.postWrap}><h2 style={{fontSize:22,fontWeight:700,color:"#fff"}}>{t("wallet_title")}</h2><div style={{marginTop:20,textAlign:"center"}}><button style={{...S.postBtn,maxWidth:320,background:"linear-gradient(135deg,#0052ff,#0066ff)"}} onClick={connect}>🔗 {t("connect_to_use")}</button></div></div>;
  if(!user)return<div style={S.postWrap}><div style={S.empty}>{t("loading")}</div></div>;
  const totalKm=courierHist.reduce((s:number,h:any)=>s+h.tripKm,0);
  const totalEarned=courierHist.filter((h:any)=>h.status==="completed").reduce((s:number,h:any)=>s+h.acceptedFee,0);
  return <div style={S.postWrap}><h2 style={{fontSize:22,fontWeight:700,color:"#fff"}}>{t("wallet_title")}</h2>
    <div style={{background:"rgba(255,255,255,0.015)",border:"1px solid rgba(255,255,255,0.04)",borderRadius:16,padding:20,marginTop:16}}>
      <div style={{display:"flex",gap:12,alignItems:"center",marginBottom:16}}><div style={{width:48,height:48,borderRadius:14,background:"linear-gradient(135deg,#00ff87,#00b4ff)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:800,color:"#000"}}>{user.displayName[0]}</div><div><div style={{fontSize:15,fontWeight:600,color:"#fff"}}>{user.displayName}</div><div style={{fontSize:11,color:"#444",fontFamily:"monospace"}}>{user.walletAddress.slice(0,14)}...</div></div></div>
      <div style={{display:"flex",gap:8}}><div style={S.pStat}><div style={S.pStatN}>★{user.score}</div><div style={S.pStatL}>{t("rating")}</div></div><div style={S.pStat}><div style={S.pStatN}>{user.deliveries}</div><div style={S.pStatL}>{t("runs")}</div></div><div style={S.pStat}><div style={S.pStatN}>{user.tasksPosted}</div><div style={S.pStatL}>{t("posted_stat")}</div></div></div>
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
  const t=useLang();
  const steps=[{i:"🔑",tk:"s1t" as const,dk:"s1d" as const},{i:"📝",tk:"s2t" as const,dk:"s2d" as const},{i:"🏷",tk:"s3t" as const,dk:"s3d" as const},{i:"👆",tk:"s4t" as const,dk:"s4d" as const},{i:"🏃",tk:"s5t" as const,dk:"s5d" as const},{i:"⭐",tk:"s6t" as const,dk:"s6d" as const}];
  return <div style={S.postWrap}><h2 style={{fontSize:22,fontWeight:700,color:"#fff"}}>{t("how_title")}</h2>
    <div style={{padding:16,borderRadius:14,background:"rgba(0,255,135,0.02)",border:"1px solid rgba(0,255,135,0.06)",marginBottom:16,marginTop:10}}>
      <div style={{fontSize:14,color:"#00ff87",fontWeight:600,marginBottom:6}}>{t("tagline")}</div>
      <div style={{fontSize:12,color:"#777",lineHeight:1.6}}>GIGS.MOM is an agentic commerce protocol. Anyone — human or AI agent — can post tasks that need a human in the physical world: deliveries, errands, interactions, verifications, and more. Runners bid, get picked, complete the task, submit proof, and get paid in USDC.</div>
    </div>
    <div className="dz-steps-grid">{steps.map((s,i)=><div key={i} style={{padding:"18px 16px",borderRadius:14,background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.035)",position:"relative"}}><div style={{fontFamily:"monospace",fontSize:9,color:"#1a1a2a",position:"absolute",top:10,right:12}}>{String(i+1).padStart(2,"0")}</div><div style={{fontSize:28,marginBottom:10}}>{s.i}</div><div style={{fontSize:15,fontWeight:700,color:"#fff",marginBottom:5}}>{t(s.tk)}</div><div style={{fontSize:12,color:"#666",lineHeight:1.5}}>{t(s.dk)}</div></div>)}</div>
    <div style={{marginTop:20}}>
      <div style={{fontSize:13,fontWeight:600,color:"#fff",marginBottom:10}}>Task Types</div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{TASK_TYPES.map(tp=><div key={tp.id} style={{padding:"8px 14px",borderRadius:10,background:"rgba(255,255,255,0.015)",border:"1px solid rgba(255,255,255,0.04)",fontSize:12,color:"#888"}}>{tp.i} {tp.l}</div>)}</div>
    </div>
    <AgentWorkflows/>
    <div style={{marginTop:20,padding:"16px 18px",borderRadius:14,background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.035)"}}>
      <div style={{fontSize:14,fontWeight:700,color:"#fff",marginBottom:8}}>For Developers & AI Agents</div>
      <div style={{fontSize:12,color:"#777",lineHeight:1.7,marginBottom:12}}>GIGS.MOM is API-first. Any HTTP client — human or AI agent — can post tasks by sending a POST request with x402 USDC payment. No API keys, no signup, no KYC. Just money and a task.</div>
      <div style={{background:"rgba(0,0,0,0.3)",borderRadius:10,padding:"14px 16px",fontFamily:"monospace",fontSize:11,color:"#00ff87",lineHeight:1.8,overflowX:"auto"}}>
        <div style={{color:"#555"}}>{"// Agent posts a task with one HTTP call"}</div>
        <div><span style={{color:"#0052ff"}}>POST</span> /task</div>
        <div style={{color:"#555"}}>{"// x402: server returns 402 → agent signs USDC → retries"}</div>
        <div><span style={{color:"#888"}}>X-Payment:</span> {"<signed USDC authorization>"}</div>
        <div style={{color:"#555",marginTop:6}}>{"{"}</div>
        <div style={{paddingLeft:16}}><span style={{color:"#ffd000"}}>"title"</span>: <span style={{color:"#a855f7"}}>"Count cars at Rue de la Loi"</span>,</div>
        <div style={{paddingLeft:16}}><span style={{color:"#ffd000"}}>"taskType"</span>: <span style={{color:"#a855f7"}}>"gather-info"</span>,</div>
        <div style={{paddingLeft:16}}><span style={{color:"#ffd000"}}>"locationAddr"</span>: <span style={{color:"#a855f7"}}>"Rue de la Loi 200, Brussels"</span>,</div>
        <div style={{paddingLeft:16}}><span style={{color:"#ffd000"}}>"action"</span>: <span style={{color:"#a855f7"}}>"Count all cars for 1 hour"</span>,</div>
        <div style={{paddingLeft:16}}><span style={{color:"#ffd000"}}>"proofType"</span>: <span style={{color:"#a855f7"}}>"text"</span>,</div>
        <div style={{paddingLeft:16}}><span style={{color:"#ffd000"}}>"suggestedFee"</span>: <span style={{color:"#00ff87"}}>15.00</span>,</div>
        <div style={{paddingLeft:16}}><span style={{color:"#ffd000"}}>"maxRunners"</span>: <span style={{color:"#00ff87"}}>3</span></div>
        <div style={{color:"#555"}}>{"}"}</div>
      </div>
      <div style={{display:"flex",gap:8,marginTop:12,flexWrap:"wrap"}}>
        <div style={{fontSize:10,color:"#00ff87",background:"rgba(0,255,135,0.04)",border:"1px solid rgba(0,255,135,0.1)",padding:"4px 10px",borderRadius:6}}>x402 Protocol</div>
        <div style={{fontSize:10,color:"#0052ff",background:"rgba(0,82,255,0.04)",border:"1px solid rgba(0,82,255,0.1)",padding:"4px 10px",borderRadius:6}}>Base Mainnet</div>
        <div style={{fontSize:10,color:"#ffd000",background:"rgba(255,208,0,0.04)",border:"1px solid rgba(255,208,0,0.1)",padding:"4px 10px",borderRadius:6}}>USDC Payments</div>
        <div style={{fontSize:10,color:"#a855f7",background:"rgba(168,85,247,0.04)",border:"1px solid rgba(168,85,247,0.1)",padding:"4px 10px",borderRadius:6}}>MCP Compatible</div>
      </div>
    </div>
  </div>;
}

export default function App(){
  const[view,setView]=useState("home");const userLoc=useGPS();const[toast,setToast]=useState<string|null>(null);
  const[lang,setLang]=useState<Lang>(()=>detectLang());
  const[showLangMenu,setShowLangMenu]=useState(false);
  const[walletAddr,setWalletAddr]=useState<string|null>(null);
  const connect=async()=>{try{const a=await connectWallet();setWalletAddr(a);setToast(translate("wallet_ready"));setTimeout(()=>setToast(null),3000)}catch(e:any){alert(e.message)}};
  const translate=(k:keyof TranslationKeys,...args:string[])=>{
    let s=(T[lang]?.[k]??T.en[k]??String(k));
    args.forEach((a,i)=>{s=s.replace(`{${i}}`,a)});return s;
  };
  const changeLang=(l:Lang)=>{setLang(l);localStorage.setItem("dz_lang",l);setShowLangMenu(false)};
  const NAV=[{id:"home",lk:"nav_tasks" as const,i:"⚡"},{id:"post",lk:"nav_post" as const,i:"📝"},{id:"wallet",lk:"nav_wallet" as const,i:"◆"},{id:"how",lk:"nav_how" as const,i:"❓"}];
  return <WalletCtx.Provider value={{walletAddr,connect}}><LangCtx.Provider value={translate}>
  <div style={{minHeight:"100vh",background:"#0b0c12",color:"#bbb",fontFamily:"'Outfit',sans-serif"}}><style>{CSS}</style>
    <header style={{position:"sticky",top:0,zIndex:1000,background:"rgba(11,12,18,0.92)",backdropFilter:"blur(20px)",borderBottom:"1px solid rgba(255,255,255,0.03)"}}>
      <div style={{maxWidth:1120,margin:"0 auto",padding:"0 12px",height:54,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}} onClick={()=>setView("home")}><div style={{width:30,height:30,borderRadius:8,background:"linear-gradient(135deg,#00ff87,#00b4ff)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,color:"#000",fontWeight:800}}>◆</div><div style={{fontFamily:"monospace",fontWeight:700,fontSize:14,color:"#fff",letterSpacing:2}}>GIGS.MOM</div></div>
        <nav className="dz-header-nav">{NAV.map(n=><button key={n.id} onClick={()=>setView(n.id)} style={{...S.navBtn,...(view===n.id?S.navAct:{})}}>{translate(n.lk)}</button>)}</nav>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div style={{position:"relative"}}>
            <button onClick={()=>setShowLangMenu(!showLangMenu)} style={{fontSize:11,color:"#888",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",padding:"5px 9px",borderRadius:10,fontFamily:"monospace",letterSpacing:1}}>{lang.toUpperCase()} 🌐</button>
            {showLangMenu&&<div style={{position:"absolute",top:"calc(100% + 6px)",right:0,background:"#14151e",border:"1px solid rgba(255,255,255,0.06)",borderRadius:12,overflow:"hidden",zIndex:2000,minWidth:140,boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>
              {(Object.entries(LANGS) as [Lang,string][]).map(([code,name])=><button key={code} onClick={()=>changeLang(code)} style={{display:"block",width:"100%",textAlign:"left",padding:"9px 14px",background:code===lang?"rgba(0,255,135,0.05)":"transparent",border:"none",color:code===lang?"#00ff87":"#888",fontSize:12,fontFamily:"'Outfit',sans-serif",cursor:"pointer"}}>{name}</button>)}
            </div>}
          </div>
          {userLoc&&<div style={{fontSize:12,color:"#a855f7",background:"rgba(168,85,247,0.05)",border:"1px solid rgba(168,85,247,0.12)",padding:"4px 8px",borderRadius:12}}>📍</div>}
          {walletAddr?<div style={{fontSize:10,color:"#0052ff",background:"rgba(0,82,255,0.05)",border:"1px solid rgba(0,82,255,0.15)",padding:"5px 10px",borderRadius:12,fontFamily:"monospace"}}>{walletAddr.slice(0,6)}…{walletAddr.slice(-4)}</div>:<button onClick={connect} style={{fontSize:10,color:"#0052ff",background:"rgba(0,82,255,0.05)",border:"1px solid rgba(0,82,255,0.15)",padding:"5px 10px",borderRadius:10,fontFamily:"monospace"}}>🔗 Wallet</button>}
        </div>
      </div>
    </header>
    <main className="dz-main">
      {(view==="home"||view==="tasks")&&<TaskListView userLoc={userLoc}/>}
      {view==="post"&&<PostView userLoc={userLoc}/>}
      {view==="wallet"&&<WalletView/>}
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
