import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useState, useEffect, useCallback } from "react";
import { Id } from "../../convex/_generated/dataModel";
import { BRUSSELS } from "../lib/utils";

export function useUser(walletAddress: string | null) {
  const getOrCreate = useMutation(api.users.getOrCreate);
  const userData = useQuery(api.users.getByWallet, walletAddress ? { walletAddress } : "skip");
  const [userId, setUserId] = useState<Id<"users"> | null>(null);

  useEffect(() => {
    if (!walletAddress) { setUserId(null); return; }
    if (!userData) {
      getOrCreate({ walletAddress }).then((id) => setUserId(id));
    } else {
      setUserId(userData._id);
    }
  }, [userData, walletAddress]);

  return { user: userData ?? null, userId, walletAddress };
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

export function useOpenTasks() {
  return useQuery(api.tasks.listOpen) ?? [];
}

export function useActiveTasks(userId: Id<"users"> | null) {
  return useQuery(api.tasks.getActive, userId ? { userId } : "skip") ?? [];
}

export function useTask(taskId: Id<"tasks"> | null) {
  return useQuery(api.tasks.getTask, taskId ? { taskId } : "skip");
}

export function useBids(taskId: Id<"tasks"> | null) {
  return useQuery(api.tasks.getBids, taskId ? { taskId } : "skip") ?? [];
}

export function useChat(taskId: Id<"tasks"> | null) {
  const msgs = useQuery(api.chat.list, taskId ? { taskId } : "skip") ?? [];
  const sendMsg = useMutation(api.chat.send);
  const send = useCallback(
    (senderId: Id<"users">, text: string) => {
      if (!taskId) return;
      return sendMsg({ taskId, senderId, text });
    },
    [taskId, sendMsg]
  );
  return { messages: msgs, send };
}

export function useProfile(userId: Id<"users"> | null) {
  return useQuery(api.users.getProfile, userId ? { userId } : "skip");
}

export function useCourierHistory(courierId: Id<"users"> | null) {
  return useQuery(api.tasks.getCourierHistory, courierId ? { courierId } : "skip") ?? [];
}

export function usePosterHistory(posterId: Id<"users"> | null) {
  return useQuery(api.tasks.getPosterHistory, posterId ? { posterId } : "skip") ?? [];
}

export function useStats() {
  return useQuery(api.tasks.getStats) ?? { total: 0, open: 0, completed: 0, burned: 0 };
}

export function useTaskRunners(taskId: Id<"tasks"> | null) {
  return useQuery(api.tasks.getTaskRunners, taskId ? { taskId } : "skip") ?? [];
}

// Proof files
export function useProofFiles(taskId: Id<"tasks"> | null) {
  return useQuery(api.proofs.getProofFiles, taskId ? { taskId } : "skip") ?? [];
}

export function useProofUpload() {
  const generateUrl = useMutation(api.proofs.generateUploadUrl);
  const saveFile = useMutation(api.proofs.saveProofFile);

  const upload = useCallback(async (
    file: File,
    taskId: Id<"tasks">,
    runnerId: Id<"users">,
    stepOrder?: number,
    caption?: string,
  ) => {
    const uploadUrl = await generateUrl();
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    });
    const { storageId } = await res.json();
    return await saveFile({
      taskId,
      runnerId,
      stepOrder,
      storageId,
      fileType: file.type,
      fileName: file.name,
      caption,
    });
  }, [generateUrl, saveFile]);

  return { upload };
}

// Saved workflows
export function useSavedWorkflows(userId: Id<"users"> | null) {
  return useQuery(api.workflows.list, userId ? { userId } : "skip") ?? [];
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

export function useCourierTracking(
  taskId: Id<"tasks"> | null,
  courierId: Id<"users"> | null,
  active: boolean
) {
  const update = useMutation(api.tasks.updateCourierLoc);
  useEffect(() => {
    if (!taskId || !courierId || !active || !navigator.geolocation) return;
    const iv = setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        (p) => update({ taskId, courierId, lat: p.coords.latitude, lng: p.coords.longitude }),
        () => {},
        { enableHighAccuracy: true, timeout: 4000 }
      );
    }, 5000);
    return () => clearInterval(iv);
  }, [taskId, courierId, active]);
}
