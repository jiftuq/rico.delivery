import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useState, useEffect, useCallback } from "react";
import { Id } from "../../convex/_generated/dataModel";
import { BRUSSELS } from "../lib/utils";
import { payUSDC } from "../lib/wallet";
import { useToken, errMsg, pendingDeposits, addPendingDeposit, removePendingDeposit } from "../lib/session";

/** The signed-in user. `token` is what every action takes to say who is calling. */
export function useUser(walletAddress: string | null) {
  const token = useToken();
  const user = useQuery(api.auth.me, walletAddress && token ? { token } : "skip") ?? null;
  return { user, userId: (user?._id ?? null) as Id<"users"> | null, walletAddress, token: user ? token : null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Prepaid balance: read it, top it up from the wallet, withdraw it. */
export function useFunds() {
  const token = useToken();
  const summary = useQuery(api.wallet.summary, token ? { token } : "skip") ?? null;
  const claim = useAction(api.payments.claimDeposit);
  const withdrawMutation = useMutation(api.wallet.requestWithdrawal);

  /** Credit a deposit that is already on-chain. Retries while it confirms. */
  const claimDeposit = useCallback(async (txHash: string) => {
    if (!token) throw new Error("Sign in first");
    addPendingDeposit(txHash);
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await claim({ token, txHash });
        removePendingDeposit(txHash);
        return result;
      } catch (e) {
        const waiting = /not (found|confirmed) yet/i.test(errMsg(e));
        if (!waiting) removePendingDeposit(txHash);
        if (!waiting || attempt >= 20) throw e;
        await sleep(2000);
      }
    }
  }, [token, claim]);

  // Finish crediting deposits interrupted by a closed tab or lost connection.
  useEffect(() => {
    if (!token) return;
    pendingDeposits().forEach((tx) => claimDeposit(tx).catch(() => {}));
  }, [token]);

  const topUp = useCallback(async (amountUSDC: number) => {
    const txHash = await payUSDC(amountUSDC, summary?.depositAddress);
    return await claimDeposit(txHash);
  }, [summary?.depositAddress, claimDeposit]);

  /** Make sure the balance covers `amountUSDC`, topping up the shortfall. */
  const ensureFunds = useCallback(async (amountUSDC: number) => {
    const shortfall = Math.ceil((amountUSDC - (summary?.balance ?? 0)) * 100) / 100;
    if (shortfall > 0) await topUp(shortfall);
  }, [summary?.balance, topUp]);

  const withdraw = useCallback((amount: number) => {
    if (!token) throw new Error("Sign in first");
    return withdrawMutation({ token, amount });
  }, [token, withdrawMutation]);

  return { summary, balance: summary?.balance ?? 0, topUp, ensureFunds, claimDeposit, withdraw };
}

export function useApiKeys() {
  const token = useToken();
  const keys = useQuery(api.auth.listApiKeys, token ? { token } : "skip") ?? [];
  const create = useAction(api.auth.createApiKey);
  const revoke = useMutation(api.auth.revokeApiKey);
  return {
    keys,
    createKey: (label: string) => create({ token: token!, label }),
    revokeKey: (keyId: Id<"authTokens">) => revoke({ token: token!, keyId }),
  };
}

export function useGPS() {
  const [loc, setLoc] = useState<[number, number] | null>(null);
  useEffect(() => {
    if (!navigator.geolocation) { setLoc(BRUSSELS); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => setLoc([p.coords.latitude, p.coords.longitude]),
      () => setLoc(BRUSSELS),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);
  return loc;
}

// Task data comes back as the caller may see it: the poster and accepted
// runners get exact addresses and positions, everyone else the area only.
// So these pass the session token whenever there is one.

export function useOpenTasks() {
  const token = useToken();
  return useQuery(api.tasks.listOpen, token ? { token } : {}) ?? [];
}

/** The signed-in user's own tasks that are still going. */
export function useActiveTasks() {
  const token = useToken();
  return useQuery(api.tasks.getActive, token ? { token } : "skip") ?? [];
}

export function useTask(taskId: Id<"tasks"> | null) {
  const token = useToken();
  return useQuery(api.tasks.getTask, taskId ? { taskId, ...(token ? { token } : {}) } : "skip");
}

export function useBids(taskId: Id<"tasks"> | null) {
  const token = useToken();
  return useQuery(api.tasks.getBids, taskId ? { taskId, ...(token ? { token } : {}) } : "skip") ?? [];
}

/** Apps connected through "Connect" (OAuth), e.g. Claude. */
export function useConnectedApps() {
  const token = useToken();
  const apps = useQuery(api.oauth.listConnections, token ? { token } : "skip") ?? [];
  const disconnect = useAction(api.oauth.disconnectApp);
  return { apps, disconnectApp: (clientId: string) => disconnect({ token: token!, clientId }) };
}

export function useChat(taskId: Id<"tasks"> | null) {
  const token = useToken();
  const msgs = useQuery(api.chat.list, taskId && token ? { taskId, token } : "skip") ?? [];
  const sendMsg = useMutation(api.chat.send);
  const send = useCallback(
    (text: string) => {
      if (!taskId || !token) return;
      return sendMsg({ token, taskId, text });
    },
    [taskId, token, sendMsg]
  );
  return { messages: msgs, send };
}

export function useProfile(userId: Id<"users"> | null) {
  return useQuery(api.users.getProfile, userId ? { userId } : "skip");
}

/** The signed-in user's finished jobs as a runner. */
export function useCourierHistory() {
  const token = useToken();
  return useQuery(api.tasks.getCourierHistory, token ? { token } : "skip") ?? [];
}

/** The signed-in user's finished tasks as a poster. */
export function usePosterHistory() {
  const token = useToken();
  return useQuery(api.tasks.getPosterHistory, token ? { token } : "skip") ?? [];
}

export function useStats() {
  return useQuery(api.tasks.getStats) ?? { total: 0, open: 0, completed: 0, burned: 0 };
}

export function useTaskRunners(taskId: Id<"tasks"> | null) {
  const token = useToken();
  return useQuery(api.tasks.getTaskRunners, taskId ? { taskId, ...(token ? { token } : {}) } : "skip") ?? [];
}

// Proof files: only the poster and the runners on the task get them.
export function useProofFiles(taskId: Id<"tasks"> | null) {
  const token = useToken();
  return useQuery(api.proofs.getProofFiles, taskId && token ? { taskId, token } : "skip") ?? [];
}

/**
 * Re-encode a photo in the browser so the uploaded file carries no metadata
 * (phones store the GPS position and device in it). Very large photos are
 * scaled to 4096 px on the long side. Videos and formats the browser can't
 * decode are uploaded unchanged.
 */
async function withoutMetadata(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[a-z0-9]+$/i, "") + (type === "image/png" ? ".png" : ".jpg"), { type });
  } catch {
    return file;
  }
}

export function useProofUpload() {
  const token = useToken();
  const generateUrl = useMutation(api.proofs.generateUploadUrl);
  const saveFile = useMutation(api.proofs.saveProofFile);

  const upload = useCallback(async (
    file: File,
    taskId: Id<"tasks">,
    stepOrder?: number,
    caption?: string,
  ) => {
    if (!token) throw new Error("Sign in first");
    file = await withoutMetadata(file);
    const uploadUrl = await generateUrl({ token });
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    });
    const { storageId } = await res.json();
    return await saveFile({
      token,
      taskId,
      stepOrder,
      storageId,
      fileType: file.type,
      fileName: file.name,
      caption,
    });
  }, [token, generateUrl, saveFile]);

  return { upload };
}

// Saved workflows
export function useSavedWorkflows() {
  const token = useToken();
  return useQuery(api.workflows.list, token ? { token } : "skip") ?? [];
}

export function useWorkflowActions() {
  return {
    saveWorkflow: useMutation(api.workflows.save),
    removeWorkflow: useMutation(api.workflows.remove),
    markUsed: useMutation(api.workflows.markUsed),
  };
}

export function useTaskActions() {
  return {
    createTask: useMutation(api.tasks.create),
    placeBid: useMutation(api.tasks.placeBid),
    acceptBid: useMutation(api.tasks.acceptBid),
    updateCourierLoc: useMutation(api.tasks.updateCourierLoc),
    markDelivered: useMutation(api.tasks.markDelivered),
    confirmDelivery: useMutation(api.tasks.confirmDelivery),
    cancelTask: useMutation(api.tasks.cancel),
    openDispute: useMutation(api.tasks.openDispute),
  };
}

export function useCourierTracking(taskId: Id<"tasks"> | null, active: boolean) {
  const token = useToken();
  const update = useMutation(api.tasks.updateCourierLoc);
  useEffect(() => {
    if (!taskId || !token || !active || !navigator.geolocation) return;
    const iv = setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        (p) => update({ token, taskId, lat: p.coords.latitude, lng: p.coords.longitude }),
        () => {},
        { enableHighAccuracy: true, timeout: 4000 }
      );
    }, 5000);
    return () => clearInterval(iv);
  }, [taskId, token, active]);
}
