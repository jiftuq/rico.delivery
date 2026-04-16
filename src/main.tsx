import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { sdk } from "@farcaster/frame-sdk";
import App from "./App";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

function Root() {
  useEffect(() => {
    sdk.actions.ready({ disableNativeGestures: false }).catch((e) => {
      console.warn("Farcaster SDK ready() failed (likely outside Warpcast):", e);
    });
  }, []);
  return (
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
