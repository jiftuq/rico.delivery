import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useToken, errMsg } from "./lib/session";

// The page an app (such as Claude) sends people to when they click "Connect".
// They sign in with their wallet, see what the app will be able to do, and
// approve or cancel. Approving sends a one-time code back to the app.

const card: React.CSSProperties = { maxWidth: 440, margin: "40px auto", padding: 24, borderRadius: 16, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", fontFamily: "'Outfit',sans-serif", color: "#bbb" };
const btn: React.CSSProperties = { flex: 1, padding: 14, borderRadius: 12, border: "none", fontSize: 14, fontWeight: 700, fontFamily: "'Outfit',sans-serif", cursor: "pointer" };

export default function ConsentView({ walletAddr, connect }: { walletAddr: string | null; connect: () => Promise<void> }) {
  const q = new URLSearchParams(window.location.search);
  const clientId = q.get("client_id") || "", redirectUri = q.get("redirect_uri") || "", state = q.get("state");
  const codeChallenge = q.get("code_challenge") || "", method = q.get("code_challenge_method") || "";
  const token = useToken();
  const me = useQuery(api.auth.me, walletAddr && token ? { token } : "skip");
  const client = useQuery(api.oauth.describeClient, clientId && redirectUri ? { clientId, redirectUri } : "skip");
  const approve = useAction(api.oauth.approveAuthorization);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem =
    !clientId || !redirectUri ? "This link is incomplete. Start the connection again from the app."
    : q.get("response_type") !== "code" || method !== "S256" || !codeChallenge ? "This app sent a request RICO does not support."
    : client && !client.ok ? client.reason
    : null;

  // Only ever return to an address the app registered (checked by describeClient).
  const goBack = (params: Record<string, string>) => {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (state) url.searchParams.set("state", state);
    window.location.assign(url.toString());
  };

  const onApprove = async () => {
    if (!token) return;
    setBusy(true); setError(null);
    try {
      const { code } = await approve({ token, clientId, redirectUri, codeChallenge, codeChallengeMethod: method, scope: q.get("scope") || undefined, resource: q.get("resource") || undefined });
      goBack({ code });
    } catch (e) { setError(errMsg(e)); setBusy(false); }
  };

  // Refuse to work inside another site's frame: it could hide this page and
  // trick a click on Allow (vercel.json also forbids framing this page).
  let framed = false;
  try { framed = window.top !== window.self; } catch { framed = true; }
  if (framed) return <div style={card}><h2 style={{ color: "#fff", fontSize: 20, margin: 0 }}>Open this page directly</h2><p style={{ fontSize: 14, lineHeight: 1.5 }}>For your safety, RICO's approval page can't be used inside another website. Start the connection again from the app, so it opens in its own window.</p></div>;

  if (problem) return <div style={card}><h2 style={{ color: "#fff", fontSize: 20, margin: 0 }}>Cannot connect</h2><p style={{ fontSize: 14, lineHeight: 1.5 }}>{problem}</p></div>;
  if (!client || !client.ok) return <div style={card}>Loading…</div>;

  // Anyone can register an app under any name, so the name is only trusted
  // when the app returns to a host RICO knows (see describeClient).
  const { clientName, redirectHost: host, trust, impersonating } = client;
  const verified = trust === "verified";
  const who = verified ? clientName : "This app";
  const notice: React.CSSProperties = { fontSize: 13, lineHeight: 1.55, padding: 12, borderRadius: 10, marginTop: 12 };

  return <div style={card}>
    <h2 style={{ color: "#fff", fontSize: 22, margin: 0 }}>
      {verified ? `Connect ${clientName} to RICO` : trust === "local" ? `Connect \u201c${clientName}\u201d to RICO` : "Connect an unverified app to RICO"}
    </h2>
    {verified && <p style={{ fontSize: 13, color: "#00ff87", marginTop: 6 }}>✓ Verified app · you will return to <span style={{ fontFamily: "monospace" }}>{host}</span></p>}
    {trust === "local" && <div style={{ ...notice, background: "rgba(0,180,255,0.06)", border: "1px solid rgba(0,180,255,0.2)" }}>
      This app runs on your own computer: it returns to <b style={{ color: "#fff", fontFamily: "monospace" }}>{host}</b>. Only continue if you just started this connection from an app on this computer, such as Claude Code.
    </div>}
    {trust === "unverified" && <div style={{ ...notice, background: "rgba(255,71,87,0.08)", border: "1px solid rgba(255,71,87,0.35)", color: "#ffb3ba" }}>
      <b style={{ color: "#fff" }}>RICO hasn't verified this app.</b> It calls itself \u201c{clientName}\u201d and will send you to <b style={{ color: "#fff", fontFamily: "monospace" }}>{host}</b>.
      {impersonating && <> It uses the name of Claude or RICO but doesn't return to claude.ai, so it may be pretending to be one of them.</>}
      {" "}Only continue if you started this connection yourself on {host}.
    </div>}

    {!me ? <>
      <p style={{ fontSize: 14, lineHeight: 1.5 }}>Sign in with your wallet first. It is a free signature that proves the wallet is yours, not a transaction.</p>
      <button style={{ ...btn, width: "100%", background: "linear-gradient(135deg,#0052ff,#0066ff)", color: "#fff" }} onClick={connect}>{walletAddr ? "✍️ Sign in with your wallet" : "🔗 Connect wallet"}</button>
    </> : <>
      <div style={{ fontSize: 13, margin: "14px 0 6px" }}>Signed in as <span style={{ fontFamily: "monospace", color: "#fff" }}>{me.displayName}</span> · balance <span style={{ color: "#00ff87", fontFamily: "monospace" }}>${me.balance.toFixed(2)} USDC</span></div>
      <div style={{ fontSize: 14, color: "#fff", fontWeight: 600, marginTop: 14 }}>{who} will be able to:</div>
      <ul style={{ fontSize: 14, lineHeight: 1.7, paddingLeft: 20, margin: "6px 0" }}>
        <li>See your tasks, bids and RICO balance</li>
        <li>Post tasks and accept bids, <b style={{ color: "#fff" }}>spending your RICO balance</b></li>
        <li>Confirm deliveries, which pays the runner</li>
        <li>Cancel your open tasks and place bids as you</li>
      </ul>
      <div style={{ fontSize: 14, color: "#fff", fontWeight: 600, marginTop: 12 }}>It will not be able to:</div>
      <ul style={{ fontSize: 14, lineHeight: 1.7, paddingLeft: 20, margin: "6px 0" }}>
        <li>Spend more than your balance, or touch your wallet</li>
        <li>Withdraw: money only leaves RICO from this website, to your own wallet</li>
        <li>See or change your API keys or your other connected apps</li>
      </ul>
      <p style={{ fontSize: 12, color: "#666" }}>You can disconnect it any time under Wallet.</p>
      {error && <p style={{ fontSize: 13, color: "#ff4757" }}>{error}</p>}
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <button style={{ ...btn, background: "rgba(255,255,255,0.05)", color: "#ccc" }} disabled={busy} onClick={() => goBack({ error: "access_denied", error_description: "The user cancelled" })}>Cancel</button>
        <button style={{ ...btn, background: verified ? "#00ff87" : "rgba(255,255,255,0.12)", color: verified ? "#000" : "#fff", opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={onApprove}>{busy ? "Connecting…" : verified ? "Allow" : "Allow anyway"}</button>
      </div>
    </>}
  </div>;
}
