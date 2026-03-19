import { useState, useEffect, useRef, createContext, useContext } from "react";
import { Id } from "../convex/_generated/dataModel";
import { useUser, useGPS, useOpenTasks, useActiveTasks, useBids, useChat, useProfile, useStats, useTaskActions, useCourierTracking, useCourierHistory, usePosterHistory } from "./hooks/useDropZone";
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

function TaskMap({pickup,dropoff,privacyZone,courierLat,courierLng,bids,userLoc,showExact,tracking,h=240}:{pickup:{lat:number;lng:number;addr:string};dropoff:{lat:number;lng:number;addr:string};privacyZone:number;courierLat?:number;courierLng?:number;bids?:{name:string;lat:number;lng:number;fee:number;score:number}[];userLoc:[number,number]|null;showExact:boolean;tracking:boolean;h?:number}){
  const ref=useRef<HTMLDivElement>(null);const mapRef=useRef<L.Map|null>(null);
  useEffect(()=>{if(!ref.current)return;if(mapRef.current){try{mapRef.current.remove()}catch(e){}mapRef.current=null}
    const t=setTimeout(()=>{if(!ref.current)return;try{
      const m=L.map(ref.current,{zoomControl:false,attributionControl:false,tap:true}).setView([pickup.lat,pickup.lng],14);
      L.tileLayer(TILES,{maxZoom:18}).addTo(m);L.control.zoom({position:"bottomright"}).addTo(m);mapRef.current=m;
      const ico=(c:string,s=14)=>L.divIcon({className:"",html:`<div style="width:${s}px;height:${s}px;border-radius:50%;background:${c};border:3px solid #14151e;box-shadow:0 0 10px ${c}44"></div>`,iconSize:[s,s],iconAnchor:[s/2,s/2]});
      L.marker([pickup.lat,pickup.lng],{icon:ico("#00ff87",18)}).bindPopup(`<b style="color:#111">PICKUP</b><br/><span style="color:#555;font-size:12px">${pickup.addr}</span>`).addTo(m);
      const fz=fuzzLoc(dropoff.lat,dropoff.lng,Math.round(pickup.lat*10000));
      L.circle([fz.lat,fz.lng],{radius:privacyZone,color:"#ff4757",fillColor:"#ff4757",fillOpacity:0.05,weight:1.5,dashArray:"6 4",opacity:0.35}).addTo(m);
      L.marker([fz.lat,fz.lng],{icon:L.divIcon({className:"",html:`<div style="width:28px;height:28px;border-radius:50%;background:rgba(255,71,87,0.12);border:2px dashed rgba(255,71,87,0.35);display:flex;align-items:center;justify-content:center"><div style="width:8px;height:8px;border-radius:50%;background:#ff4757"></div></div>`,iconSize:[28,28],iconAnchor:[14,14]})}).addTo(m);
      if(showExact)L.marker([dropoff.lat,dropoff.lng],{icon:L.divIcon({className:"",html:`<div style="width:22px;height:22px;border-radius:50%;background:#ff4757;border:3px solid #14151e;box-shadow:0 0 12px rgba(255,71,87,0.5);display:flex;align-items:center;justify-content:center;font-size:11px">📍</div>`,iconSize:[22,22],iconAnchor:[11,11]})}).addTo(m);
      bids?.forEach(b=>{L.marker([b.lat,b.lng],{icon:L.divIcon({className:"",html:`<div style="position:relative"><div style="width:18px;height:18px;border-radius:50%;background:#ffd000;border:2px solid #14151e"></div><div style="position:absolute;top:-20px;left:50%;transform:translateX(-50%);background:rgba(14,15,22,0.92);color:#ffd000;font-size:10px;padding:2px 8px;border-radius:4px;white-space:nowrap;font-family:monospace;font-weight:700">${b.name}</div></div>`,iconSize:[18,18],iconAnchor:[9,9]})}).addTo(m)});
      if(courierLat&&courierLng)L.marker([courierLat,courierLng],{icon:L.divIcon({className:"",html:`<div style="width:26px;height:26px;border-radius:50%;background:#00b4ff;border:3px solid #14151e;box-shadow:0 0 16px rgba(0,180,255,0.6);display:flex;align-items:center;justify-content:center;font-size:13px">🚴</div>`,iconSize:[26,26],iconAnchor:[13,13]})}).addTo(m);
      if(userLoc)L.marker(userLoc,{icon:ico("#a855f7",18)}).addTo(m);
      const tgt:[number,number]=showExact?[dropoff.lat,dropoff.lng]:[fz.lat,fz.lng];
      const rp:[number,number][]=courierLat&&courierLng?[[courierLat,courierLng],[pickup.lat,pickup.lng],tgt]:[[pickup.lat,pickup.lng],tgt];
      getRoute(rp).then(r=>{if(!r?.geo||!mapRef.current)return;
        L.polyline(r.geo,{color:tracking?"#00b4ff":"#00ff87",weight:tracking?4:3,opacity:tracking?0.8:0.6,dashArray:tracking?undefined:"8 6"}).addTo(m);
        const mid=r.geo[Math.floor(r.geo.length/2)];
        L.marker(mid,{icon:L.divIcon({className:"",html:`<div style="background:rgba(14,15,22,0.92);color:${tracking?"#00b4ff":"#00ff87"};padding:5px 12px;border-radius:8px;font-size:11px;font-family:monospace;font-weight:700;border:1px solid rgba(255,255,255,0.1);white-space:nowrap">${r.km} km · ~${r.min} min</div>`,iconSize:[110,24],iconAnchor:[55,12]}),interactive:false}).addTo(m);
        const pts:any[]=[[pickup.lat,pickup.lng],[fz.lat,fz.lng]];
        if(showExact)pts.push([dropoff.lat,dropoff.lng]);if(courierLat&&courierLng)pts.push([courierLat,courierLng]);
        bids?.forEach(b=>pts.push([b.lat,b.lng]));if(userLoc)pts.push(userLoc);
        if(pts.length>1)m.fitBounds(L.latLngBounds(pts).pad(0.15))});
    }catch(e){}},60);
    return()=>{clearTimeout(t);if(mapRef.current){try{mapRef.current.remove()}catch(e){}mapRef.current=null}}
  },[pickup.lat,dropoff.lat,courierLat,courierLng,showExact,bids?.length,tracking]);
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
  const[showRating,setShowRating]=useState(false);const[profileId,setProfileId]=useState<Id<"users">|null>(null);
  const[routeKm,setRouteKm]=useState<string|null>(null);
  const profile=useProfile(profileId);const st=STS[task.status]||STS.open;
  const isOwner=userId&&task.posterId===userId;const isCourier=userId&&task.courierId===userId;
  const canSee=isOwner||isCourier;const isTracking=task.status==="in_progress"&&canSee;
  const chatActive=task.status==="in_progress"||task.status==="delivered";
  const total=task.itemCost+(task.acceptedFee??task.suggestedFee);
  useCourierTracking(isTracking&&isCourier?task._id:null,isCourier?userId:null,!!isTracking&&!!isCourier);
  useEffect(()=>{if(!open||!userLoc||task.status!=="open")return;getRoute([[userLoc[0],userLoc[1]],[task.pickupLat,task.pickupLng],[task.dropoffLat,task.dropoffLng]]).then(r=>r&&setRouteKm(r.km))},[open,userLoc]);
  const bidMap=bids.filter((b:any)=>b.lat&&b.lng).map((b:any)=>({name:b.courierName,lat:b.lat,lng:b.lng,fee:b.fee,score:b.courierScore}));
  const submitBid=async()=>{if(!bidFee||!userId||!userLoc)return;const route=await getRoute([[userLoc[0],userLoc[1]],[task.pickupLat,task.pickupLng],[task.dropoffLat,task.dropoffLng]]);const tripKm=route?parseFloat(route.km):Math.round((haversine(userLoc,[task.pickupLat,task.pickupLng])+haversine([task.pickupLat,task.pickupLng],[task.dropoffLat,task.dropoffLng]))*10)/10;actions.placeBid({taskId:task._id,courierId:userId,fee:parseFloat(bidFee),comment:bidComment||"Ready!",lat:userLoc[0],lng:userLoc[1],tripKm});setBidFee("");setBidComment("")};
  const doAcceptBid=async(bidId:string)=>{if(!walletAddr){await connect();return;}try{const r=await payFetch(`${SERVER_URL}/accept-bid`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({taskId:task._id,bidId,posterId:userId})});if(!r.ok){const e=await r.json();throw new Error(e.error)}}catch(e:any){alert(e.message)}};
  const doCancel=async()=>{if(!confirm(`Cancel task and refund $${total.toFixed(2)} USDC?`))return;try{const r=await fetch(`${SERVER_URL}/cancel-task`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({taskId:task._id,posterId:userId})});if(!r.ok){const e=await r.json();throw new Error(e.error)}}catch(e:any){alert(e.message)}};

  return <div style={{...S.card,borderLeft:`3px solid ${st.c}`}} onClick={()=>setOpen(!open)}>
    <div style={{display:"flex",justifyContent:"space-between",gap:10,alignItems:"flex-start"}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={S.cardCat}>{CATS.find(c=>c.id===task.category)?.i} {task.category}</div>
        <div style={{fontSize:15,fontWeight:600,color:"#fff",marginBottom:3}}>{task.title}</div>
        <div style={{fontSize:11,color:"#444"}}>{t("by")} <span style={{color:"#00ff87"}}>{task.posterName}</span> · {bids.length} {bids.length!==1?t("bids"):t("bid")}</div>
      </div>
      <div className="dz-pricing-desk" style={{textAlign:"right",minWidth:110,flexShrink:0}}>
        <div style={S.pr}><span style={S.prl}>Items</span><span style={S.prv}>{task.itemCost}</span></div>
        <div style={S.pr}><span style={S.prl}>Delivery</span><span style={{...S.prv,color:"#00ff87"}}>{task.acceptedFee??task.suggestedFee}</span></div>
        <div style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:"#fff",textAlign:"right",marginTop:2}}>${total.toFixed(2)} <span style={{fontSize:9,color:"#666"}}>USDC</span></div>
        <span style={{...S.badge,color:st.c,background:st.bg,marginTop:4,display:"inline-block"}}>{st.l}</span>
      </div>
      <div className="dz-pricing-mob"><span style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:"#fff"}}>${total.toFixed(2)} <span style={{fontSize:9,color:"#666"}}>USDC</span></span><span style={{...S.badge,color:st.c,background:st.bg}}>{st.l}</span></div>
    </div>

    <div className="dz-route-col" style={{marginTop:10,paddingTop:8,borderTop:"1px solid rgba(255,255,255,0.025)",display:"flex",alignItems:"flex-start",gap:8}}>
      <div style={{display:"flex",alignItems:"center",gap:6,flex:1}}><div style={S.dG}/><div><div style={S.rl}>{t("pickup_lbl")}</div><div style={{fontSize:11,color:"#777"}}>{task.pickupAddr}</div></div></div>
      <div className="dz-rline-h" style={{flex:"0 0 16px",height:2,background:"linear-gradient(90deg,#00ff87,#ff4757)",borderRadius:1,marginTop:12}}/><div className="dz-rline-v"/>
      <div style={{display:"flex",alignItems:"center",gap:6,flex:1}}><div style={S.dR}/><div><div style={S.rl}>{t("dropoff_lbl")} {!canSee&&<span style={{fontSize:7,color:"#ff4757",marginLeft:3}}>🛡</span>}</div><div style={{fontSize:11,color:"#777"}}>{canSee?task.dropoffAddr:maskAddr(task.dropoffAddr)}</div></div></div>
    </div>

    {open&&<div style={{marginTop:12,paddingTop:12,borderTop:"1px solid rgba(255,255,255,0.025)"}} onClick={e=>e.stopPropagation()}>
      {chatActive&&<div style={{display:"flex",gap:6,marginBottom:10}}><button style={{...S.tabBtn,...(tab==="details"?S.tabAct:{}),minHeight:40,fontSize:12}} onClick={()=>setTab("details")}>📋 {t("details")}</button><button style={{...S.tabBtn,...(tab==="chat"?S.tabAct:{}),minHeight:40,fontSize:12}} onClick={()=>setTab("chat")}>💬 {t("chat")}</button></div>}
      {tab==="chat"&&chatActive&&userId&&canSee?<ChatPanel taskId={task._id} userId={userId} myRole={isOwner?"poster":"courier"}/>:<>
        <TaskMap pickup={{lat:task.pickupLat,lng:task.pickupLng,addr:task.pickupAddr}} dropoff={{lat:task.dropoffLat,lng:task.dropoffLng,addr:task.dropoffAddr}} privacyZone={task.privacyZone} courierLat={task.courierLat} courierLng={task.courierLng} bids={task.status==="open"?bidMap:undefined} userLoc={userLoc} showExact={!!canSee} tracking={!!isTracking} h={isTracking?320:240}/>
        {isTracking&&<div style={S.trackBar}><div style={S.liveDot}/><span style={{color:"#ffd000",fontWeight:700}}>{t("live")}</span><span style={{color:"#777"}}>{t("tracking")}</span></div>}
        <div style={{marginTop:10,marginBottom:8}}><div style={S.detLbl}>{t("instructions_lbl")}</div><div style={{fontSize:12,color:"#999",lineHeight:1.6}}>{task.details}</div></div>
        <div style={S.escBox}><div style={{fontSize:9,color:"#444",fontFamily:"monospace",letterSpacing:1,marginBottom:6}}>🔒 {t("escrow_lbl")}</div>
          {task.items?.length>0?task.items.map((it:any,i:number)=><div key={i} style={S.escR}><span>🛒 {it.name}</span><span>{it.cost}</span></div>):<div style={S.escR}><span>🛒 {t("items_lbl")}</span><span>{task.itemCost}</span></div>}
          <div style={S.escR}><span>🚴 {t("delivery_lbl")}</span><span style={{color:"#00ff87"}}>{task.acceptedFee??task.suggestedFee}</span></div><div style={{height:1,background:"rgba(255,255,255,0.04)",margin:"4px 0"}}/><div style={S.escR}><span style={{fontWeight:700}}>{t("total")}</span><span style={{fontWeight:700,color:"#fff"}}>${total.toFixed(2)} USDC</span></div></div>

        {task.status==="open"&&<div style={{marginTop:8}}>
          {routeKm&&!isOwner&&<div style={{fontSize:11,color:"#00b4ff",padding:"6px 10px",borderRadius:8,background:"rgba(0,180,255,0.05)",border:"1px solid rgba(0,180,255,0.1)",marginBottom:8}}>🛣 {routeKm} {t("road_km")}</div>}
          <div style={{fontSize:13,fontWeight:600,color:"#fff",marginBottom:8}}>🏷 {t("bids_lbl")} ({bids.length})</div>
          {bids.map((b:any)=><div key={b._id} style={S.bidCard}><div style={{display:"flex",gap:10,alignItems:"flex-start",flexWrap:"wrap"}}>
            <div style={S.bidAv} onClick={()=>setProfileId(b.courierId)}>{b.courierName[0]}</div>
            <div style={{flex:1,minWidth:120}}><div style={{fontSize:12,fontWeight:600,color:"#fff"}}>{b.courierName} <span style={{fontSize:10,color:b.courierScore>=4.5?"#00ff87":"#ffd000",fontFamily:"monospace"}}>★{b.courierScore}</span></div><div style={{fontSize:11,color:"#777",marginTop:3}}>{b.comment}</div><div style={{display:"flex",gap:6,marginTop:6,flexWrap:"wrap"}}><span style={S.tagP}>📍 GPS</span><span style={S.tagB}>🛣 {b.tripKm}km</span></div></div>
            <div><div style={{fontFamily:"monospace",fontSize:15,fontWeight:700,color:"#00ff87"}}>${b.fee.toFixed(2)} <span style={{fontSize:9,color:"#666"}}>USDC</span></div>{isOwner&&<button style={{...S.bidAccBtn,marginTop:6}} onClick={()=>doAcceptBid(b._id)}>✓ {t("pick")}{b.fee>task.suggestedFee?` (+$${(b.fee-task.suggestedFee).toFixed(2)})`:""}</button>}</div>
          </div></div>)}
          {bids.length===0&&<div style={S.empty}>{t("no_bids")}</div>}
          {isOwner&&<div style={{display:"flex",gap:6,marginTop:8}}>
            <button style={{flex:1,padding:12,borderRadius:10,border:"1px solid rgba(255,71,87,0.2)",background:"rgba(255,71,87,0.04)",color:"#ff4757",fontSize:12,fontWeight:600,fontFamily:"'Outfit',sans-serif"}} onClick={doCancel}>✕ {t("cancel_task")} · {t("refund")} ${total.toFixed(2)}</button>
            <button style={{padding:"12px 16px",borderRadius:10,border:"1px solid rgba(0,180,255,0.2)",background:"rgba(0,180,255,0.04)",color:"#00b4ff",fontSize:12,fontWeight:600,fontFamily:"'Outfit',sans-serif"}} onClick={()=>{const txt=`${task.title} — $${total.toFixed(2)} USDC\n${CATS.find(c=>c.id===task.category)?.i} ${task.category} · ${t("pickup_lbl")}: ${task.pickupAddr}\n${t("delivery_lbl")}: $${task.suggestedFee.toFixed(2)} USDC\n\n${window.location.origin}`;if(navigator.share){navigator.share({title:`DROPZONE: ${task.title}`,text:txt,url:window.location.origin})}else{navigator.clipboard.writeText(txt);alert(t("link_copied"))}}}>↗ {t("share")}</button>
          </div>}
          {!isOwner&&userId&&userLoc&&<div style={{marginTop:10,padding:14,background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.035)",borderRadius:12}}>
            <div style={{fontSize:13,fontWeight:600,color:"#fff",marginBottom:10}}>{t("place_bid")}</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}><div style={{flex:"1 1 100px"}}><label style={S.fLbl}>{t("fee_lbl")}</label><input style={{...S.fInp,fontSize:14,padding:12}} placeholder={String(task.suggestedFee)} value={bidFee} onChange={e=>setBidFee(e.target.value)}/></div><div style={{flex:"2 1 160px"}}><label style={S.fLbl}>{t("comment_lbl")}</label><input style={{...S.fInp,fontSize:14,padding:12}} placeholder={t("comment_ph")} value={bidComment} onChange={e=>setBidComment(e.target.value)}/></div></div>
            {routeKm&&<div style={{fontSize:11,color:"#00b4ff",marginTop:8}}>🛣 ~{routeKm} {t("road_km")}</div>}
            <button style={{...S.postBtn,marginTop:8,padding:14,fontSize:13}} onClick={submitBid}>⚡ {t("submit_bid")}</button>
          </div>}
        </div>}
        {task.status==="in_progress"&&task.courierName&&<div style={{...S.trackBar,marginTop:8}}><div style={S.liveDot}/><span style={{color:"#ffd000",fontWeight:700,flex:1}}>🚴 {task.courierName}</span>{isCourier&&<button style={{...S.bidAccBtn,minHeight:40}} onClick={()=>actions.markDelivered({taskId:task._id,courierId:userId!})}>📦 {t("mark_delivered")}</button>}</div>}
        {task.status==="delivered"&&isOwner&&<button style={{...S.confirmBtn,padding:16,fontSize:14}} onClick={()=>setShowRating(true)}>✓ {t("confirm")} · ${total.toFixed(2)} USDC</button>}
      </>}
      {profileId&&profile&&<ProfilePopup profile={profile} onClose={()=>setProfileId(null)}/>}
      {showRating&&<RatingModal name={task.courierName||"Courier"} onRate={async(s,c)=>{try{const r=await fetch(`${SERVER_URL}/confirm-delivery`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({taskId:task._id,posterId:userId,ratingScore:s,ratingComment:c})});if(!r.ok){const e=await r.json();throw new Error(e.error)}}catch(e:any){alert(e.message)}}} onClose={()=>setShowRating(false)}/>}
    </div>}
  </div>;
}

function TaskListView({userLoc}:{userLoc:[number,number]|null}){
  const t=useLang();const openTasks=useOpenTasks();const{walletAddr}=useWalletCtx();const{userId}=useUser(walletAddr);const activeTasks=useActiveTasks(userId);
  const[cat,setCat]=useState("all");const[search,setSearch]=useState("");
  const all=[...activeTasks.filter(tk=>tk.status!=="open"),...openTasks];
  const unique=all.filter((tk,i,a)=>a.findIndex(x=>x._id===tk._id)===i);
  const visible=unique.filter(tk=>{if(tk.status==="completed"||tk.status==="cancelled")return false;return(cat==="all"||tk.category===cat)&&tk.title.toLowerCase().includes(search.toLowerCase())});
  const catLabels:{[k:string]:string}={all:t("all"),food:t("food"),grocery:t("grocery"),errand:t("errand")};
  return <div style={{paddingTop:20}}>
    <h2 style={{fontSize:22,fontWeight:700,color:"#fff"}}>{t("live_tasks")}</h2>
    <p style={{fontSize:12,color:"#3a3a4a",marginTop:2}}>{openTasks.length} {t("open_tap")}</p>
    <div style={{display:"flex",alignItems:"center",gap:8,background:"rgba(255,255,255,0.015)",border:"1px solid rgba(255,255,255,0.035)",borderRadius:12,padding:"0 14px",marginTop:12,marginBottom:10}}><span>🔍</span><input style={{flex:1,background:"none",border:"none",color:"#fff",fontSize:14,padding:"12px 0",fontFamily:"'Outfit',sans-serif"}} placeholder={t("search")} value={search} onChange={e=>setSearch(e.target.value)}/></div>
    <div style={{display:"flex",gap:6,marginBottom:14,overflowX:"auto",WebkitOverflowScrolling:"touch",paddingBottom:4}}>{CATS.map(c=><button key={c.id} onClick={()=>setCat(c.id)} style={{...S.catBtn,...(cat===c.id?S.catAct:{}),whiteSpace:"nowrap"}}>{c.i} {catLabels[c.id]||c.l}</button>)}</div>
    {visible.map(tk=><TaskCard key={tk._id} task={tk} userLoc={userLoc}/>)}
    {visible.length===0&&<div style={S.empty}>{t("no_tasks")}</div>}
  </div>;
}

function PostView({userLoc}:{userLoc:[number,number]|null}){
  const t=useLang();const{walletAddr,connect}=useWalletCtx();const{user,userId}=useUser(walletAddr);const{createTask}=useTaskActions();
  const[f,sF]=useState({title:"",pickupAddr:"",dropoffAddr:"",suggestedFee:"",details:"",category:"food",privacyZone:"100"});
  const[items,setItems]=useState([{name:"",cost:""}]);
  const[ok,setOk]=useState(false);const[pLat,sPLat]=useState(0);const[pLng,sPLng]=useState(0);const[dLat,sDLat]=useState(0);const[dLng,sDLng]=useState(0);
  const set=(k:string)=>(e:any)=>sF({...f,[k]:e.target.value});
  const setItem=(i:number,k:string,v:string)=>setItems(items.map((it,idx)=>idx===i?{...it,[k]:v}:it));
  const addItem=()=>setItems([...items,{name:"",cost:""}]);
  const removeItem=(i:number)=>setItems(items.filter((_,idx)=>idx!==i));
  const itemCostTotal=items.reduce((s,it)=>s+(parseFloat(it.cost)||0),0);
  const total=itemCostTotal+(parseFloat(f.suggestedFee)||0);
  const onPickup=(addr:string,lat:number,lng:number)=>{sF(p=>({...p,pickupAddr:addr}));sPLat(lat);sPLng(lng)};
  const onDropoff=(addr:string,lat:number,lng:number)=>{sF(p=>({...p,dropoffAddr:addr}));sDLat(lat);sDLng(lng)};
  const submit=async()=>{
    if(!f.title||!f.pickupAddr||!f.dropoffAddr||!userId)return;
    const validItems=items.filter(it=>it.name&&parseFloat(it.cost)>0);
    if(validItems.length===0)return;
    if(!walletAddr){await connect();return;}
    try{
      const res=await payFetch(`${SERVER_URL}/task`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({title:f.title,category:f.category,details:f.details||"No instructions.",pickupAddr:f.pickupAddr,pickupLat:pLat||50.85+(Math.random()-0.5)*0.02,pickupLng:pLng||4.35+(Math.random()-0.5)*0.02,dropoffAddr:f.dropoffAddr,dropoffLat:dLat||50.85+(Math.random()-0.5)*0.02,dropoffLng:dLng||4.35+(Math.random()-0.5)*0.02,privacyZone:parseInt(f.privacyZone)||100,itemCost:itemCostTotal,suggestedFee:parseFloat(f.suggestedFee)||0,items:validItems.map(it=>({name:it.name,cost:parseFloat(it.cost)})),posterId:userId}),
      });
      if(!res.ok){const e=await res.json();throw new Error(e.error);}
      setOk(true);setTimeout(()=>setOk(false),3500);
      sF({title:"",pickupAddr:"",dropoffAddr:"",suggestedFee:"",details:"",category:"food",privacyZone:"100"});
      setItems([{name:"",cost:""}]);sPLat(0);sPLng(0);sDLat(0);sDLng(0);
    }catch(e:any){alert(e.message);}
  };
  return <div style={S.postWrap}><h2 style={{fontSize:22,fontWeight:700,color:"#fff"}}>{t("post_title")}</h2>
    {ok&&<div style={S.successBanner}>✓ {t("posted_ok",total.toFixed(2))}</div>}
    {!walletAddr&&<div style={{padding:14,borderRadius:12,background:"rgba(0,82,255,0.04)",border:"1px solid rgba(0,82,255,0.12)",marginTop:12,textAlign:"center"}}><span style={{color:"#0052ff",fontSize:13}}>{t("connect_to_use")}</span></div>}
    <div className="dz-form-grid">
      <div><label style={S.fLbl}>{t("what")}</label><input style={{...S.fInp,fontSize:14,padding:12}} placeholder={t("what_ph")} value={f.title} onChange={set("title")}/></div>
      <div><label style={S.fLbl}>{t("category")}</label><select style={{...S.fInp,fontSize:14,padding:12}} value={f.category} onChange={set("category")}><option value="food">🍔 {t("food")}</option><option value="grocery">🛒 {t("grocery")}</option><option value="errand">📦 {t("errand")}</option></select></div>
      <div style={{gridColumn:"1/-1"}}><label style={S.fLbl}>{t("pickup")}</label><AddressMapPicker label={t("pickup_ph")} value={f.pickupAddr} lat={pLat} lng={pLng} onSelect={onPickup} userLoc={userLoc}/></div>
      <div style={{gridColumn:"1/-1"}}><label style={S.fLbl}>{t("dropoff")}</label><AddressMapPicker label={t("dropoff_ph")} value={f.dropoffAddr} lat={dLat} lng={dLng} onSelect={onDropoff} userLoc={userLoc}/></div>
      <div><label style={S.fLbl}>{t("delivery_fee")}</label><input style={{...S.fInp,fontSize:14,padding:12}} placeholder="5.00" value={f.suggestedFee} onChange={set("suggestedFee")}/></div>
      <div><label style={S.fLbl}>{t("privacy")}</label><select style={{...S.fInp,fontSize:14,padding:12}} value={f.privacyZone} onChange={set("privacyZone")}><option value="100">{t("privacy_100")}</option><option value="200">{t("privacy_200")}</option><option value="300">{t("privacy_300")}</option><option value="500">{t("privacy_500")}</option></select></div>
      <div style={{gridColumn:"1/-1"}}><label style={S.fLbl}>{t("instructions")}</label><textarea style={{...S.fInp,minHeight:70,fontSize:14,padding:12,resize:"vertical",fontFamily:"inherit"}} placeholder={t("instructions_ph")} value={f.details} onChange={set("details")}/></div>
    </div>
    <div style={{marginTop:14}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}><label style={S.fLbl}>🛒 {t("items")}</label><button style={{fontSize:11,padding:"5px 12px",borderRadius:8,border:"1px solid rgba(0,255,135,0.15)",background:"rgba(0,255,135,0.04)",color:"#00ff87",fontFamily:"'Outfit',sans-serif"}} onClick={addItem}>{t("add_item")}</button></div>
      {items.map((it,i)=><div key={i} style={{display:"flex",gap:6,marginBottom:6,alignItems:"center"}}>
        <input style={{...S.fInp,flex:2,fontSize:13,padding:"10px 12px"}} placeholder={t("item_name")} value={it.name} onChange={e=>setItem(i,"name",e.target.value)}/>
        <input style={{...S.fInp,flex:1,fontSize:13,padding:"10px 12px"}} placeholder={t("cost")} value={it.cost} onChange={e=>setItem(i,"cost",e.target.value)}/>
        {items.length>1&&<button style={{width:34,height:34,borderRadius:8,border:"1px solid rgba(255,71,87,0.15)",background:"rgba(255,71,87,0.04)",color:"#ff4757",flexShrink:0,fontSize:14}} onClick={()=>removeItem(i)}>✕</button>}
      </div>)}
    </div>
    {itemCostTotal>0&&<div style={{...S.escBox,marginTop:12}}>
      {items.filter(it=>it.name&&parseFloat(it.cost)>0).map((it,i)=><div key={i} style={S.escR}><span>{it.name}</span><span>{parseFloat(it.cost).toFixed(1)}</span></div>)}
      <div style={S.escR}><span>🚴 {t("delivery_lbl")}</span><span>{f.suggestedFee||"0"}</span></div>
      <div style={{height:1,background:"rgba(255,255,255,0.04)",margin:"4px 0"}}/><div style={S.escR}><span style={{fontWeight:700}}>🔒 {t("total")}</span><span style={{fontWeight:700,color:"#00ff87"}}>${total.toFixed(2)} USDC</span></div>
    </div>}
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
      <div style={{fontSize:15,fontWeight:600,color:"#00ff87",marginBottom:4}}>🚴 {t("delivery_history")} ({courierHist.length})</div>
      <div style={{fontSize:12,color:"#666",marginBottom:10}}>{totalKm.toFixed(1)} {t("km")} · ${totalEarned.toFixed(2)} USDC {t("earned")}</div>
      {courierHist.map((h:any)=><div key={h._id} style={{background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.035)",borderRadius:12,padding:12,marginBottom:8}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
          <span style={{fontSize:13,fontWeight:600,color:"#fff"}}>{h.title}</span>
          <span style={{fontSize:12,fontFamily:"monospace",color:h.status==="completed"?"#00ff87":"#ff4757",fontWeight:700}}>${h.acceptedFee.toFixed(2)}</span>
        </div>
        <div style={{fontSize:11,color:"#555"}}>{h.tripKm.toFixed(1)} {t("km")} · {CATS.find(c=>c.id===h.category)?.i} {h.category}</div>
        <div style={{fontSize:10,color:"#444",marginTop:4}}>📍 {h.pickupAddr} → {h.dropoffAddr}</div>
        {h.items?.length>0&&<div style={{fontSize:10,color:"#444",marginTop:2}}>🛒 {h.items.map((it:any)=>it.name).join(", ")}</div>}
      </div>)}
    </div>}

    {posterHist.length>0&&<div style={{marginTop:20}}>
      <div style={{fontSize:15,fontWeight:600,color:"#0052ff",marginBottom:10}}>📝 {t("post_history")} ({posterHist.length})</div>
      {posterHist.map((h:any)=><div key={h._id} style={{background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.035)",borderRadius:12,padding:12,marginBottom:8}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
          <span style={{fontSize:13,fontWeight:600,color:"#fff"}}>{h.title}</span>
          <span style={{fontSize:12,fontFamily:"monospace",color:h.status==="completed"?"#00ff87":"#ff4757",fontWeight:700}}>${h.totalEscrowed.toFixed(2)}</span>
        </div>
        <div style={{fontSize:11,color:"#555"}}>{CATS.find(c=>c.id===h.category)?.i} {h.category}{h.courierName?` · 🚴 ${h.courierName}`:""}</div>
        <div style={{fontSize:10,color:"#444",marginTop:4}}>📍 {h.pickupAddr} → {h.dropoffAddr}</div>
        {h.items?.length>0&&<div style={{fontSize:10,color:"#444",marginTop:2}}>🛒 {h.items.map((it:any)=>`${it.name} $${it.cost.toFixed(2)}`).join(", ")}</div>}
        <div style={{fontSize:10,color:"#333",marginTop:2}}>{h.details}</div>
      </div>)}
    </div>}

    <div style={{marginTop:20}}><div style={{fontSize:15,fontWeight:600,color:"#fff",marginBottom:10}}>{t("protocol")}</div><div style={{display:"flex",gap:8}}><div style={S.pStat}><div style={S.pStatN}>{stats.open}</div><div style={S.pStatL}>{t("open_stat")}</div></div><div style={S.pStat}><div style={S.pStatN}>{stats.completed}</div><div style={S.pStatL}>{t("done")}</div></div><div style={S.pStat}><div style={S.pStatN}>${stats.burned.toFixed(2)}</div><div style={S.pStatL}>{t("burned")}</div></div></div></div>
  </div>;
}

function HowView(){
  const t=useLang();
  const steps=[{i:"🔑",tk:"s1t" as const,dk:"s1d" as const},{i:"📝",tk:"s2t" as const,dk:"s2d" as const},{i:"🏷",tk:"s3t" as const,dk:"s3d" as const},{i:"👆",tk:"s4t" as const,dk:"s4d" as const},{i:"🚴",tk:"s5t" as const,dk:"s5d" as const},{i:"⭐",tk:"s6t" as const,dk:"s6d" as const}];
  return <div style={S.postWrap}><h2 style={{fontSize:22,fontWeight:700,color:"#fff"}}>{t("how_title")}</h2>
    <div className="dz-steps-grid">{steps.map((s,i)=><div key={i} style={{padding:"18px 16px",borderRadius:14,background:"rgba(255,255,255,0.01)",border:"1px solid rgba(255,255,255,0.035)",position:"relative"}}><div style={{fontFamily:"monospace",fontSize:9,color:"#1a1a2a",position:"absolute",top:10,right:12}}>{String(i+1).padStart(2,"0")}</div><div style={{fontSize:28,marginBottom:10}}>{s.i}</div><div style={{fontSize:15,fontWeight:700,color:"#fff",marginBottom:5}}>{t(s.tk)}</div><div style={{fontSize:12,color:"#666",lineHeight:1.5}}>{t(s.dk)}</div></div>)}</div>
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
        <div style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}} onClick={()=>setView("home")}><div style={{width:30,height:30,borderRadius:8,background:"linear-gradient(135deg,#00ff87,#00b4ff)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,color:"#000",fontWeight:800}}>◆</div><div style={{fontFamily:"monospace",fontWeight:700,fontSize:14,color:"#fff",letterSpacing:2}}>DROPZONE</div></div>
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
