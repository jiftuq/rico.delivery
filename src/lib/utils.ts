export const BRUSSELS: [number, number] = [50.8503, 4.3517];
export const FUZZ = 0.001;
export const OSRM = "https://router.project-osrm.org/route/v1/driving";
export const TILES = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";

export const CATS = [
  { id: "all", l: "All", i: "⚡" },
  { id: "food", l: "Food", i: "🍔" },
  { id: "grocery", l: "Grocery", i: "🛒" },
  { id: "errand", l: "Errands", i: "📦" },
];

export const STS: Record<string, { l: string; c: string; bg: string }> = {
  open: { l: "BIDDING", c: "#00ff87", bg: "rgba(0,255,135,0.07)" },
  in_progress: { l: "LIVE", c: "#ffd000", bg: "rgba(255,208,0,0.07)" },
  delivered: { l: "CONFIRM", c: "#00b4ff", bg: "rgba(0,180,255,0.07)" },
  completed: { l: "DONE", c: "#555", bg: "rgba(85,85,85,0.07)" },
  disputed: { l: "DISPUTED", c: "#ffa500", bg: "rgba(255,165,0,0.07)" },
};

export function sRand(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

export function fuzzLoc(lat: number, lng: number, seed: number) {
  const r = sRand(seed);
  const a = r() * Math.PI * 2;
  const d = FUZZ * (0.4 + r() * 0.6);
  return { lat: lat + Math.cos(a) * d, lng: lng + Math.sin(a) * d };
}

export function maskAddr(a: string) {
  const p = a.split(",");
  return p.length > 1
    ? p[0].replace(/\d+/g, "***").trim() + ", " + p.slice(1).join(",").trim()
    : a.replace(/\d+/g, "***");
}

export function haversine(a: [number, number], b: [number, number]) {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export async function getRoute(coords: [number, number][]) {
  try {
    const c = coords.map((p) => `${p[1]},${p[0]}`).join(";");
    const r = await fetch(`${OSRM}/${c}?overview=full&geometries=geojson`);
    const d = await r.json();
    if (d.routes?.[0]) {
      return {
        geo: d.routes[0].geometry.coordinates.map((c: number[]) => [c[1], c[0]] as [number, number]),
        km: (d.routes[0].distance / 1000).toFixed(1),
        min: Math.round(d.routes[0].duration / 60),
      };
    }
  } catch {}
  return null;
}

