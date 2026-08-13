"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { getUsers, pauseContainer, resumeContainer, destroyContainer, syncAllContainerStatuses } from "@/lib/api";
import type { UserSummary, PaginatedUsers } from "@/types";
import { toast } from "sonner";

export default function ContainersPage() {
  const [data, setData] = useState<PaginatedUsers | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [confirmAction, setConfirmAction] = useState<{ user: UserSummary; type: "pause" | "resume" | "destroy" } | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getUsers(page, 20, search));
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleConfirm() {
    if (!confirmAction) return;
    try {
      if (confirmAction.type === "pause") {
        await pauseContainer(confirmAction.user.id);
        toast.success("容器已暂停");
      } else if (confirmAction.type === "resume") {
        await resumeContainer(confirmAction.user.id);
        toast.success("容器已恢复");
      } else {
        await destroyContainer(confirmAction.user.id);
        toast.success("容器已销毁");
      }
      setConfirmAction(null);
      fetchData();
    } catch (err) {
      toast.error("操作失败", { description: err instanceof Error ? err.message : "" });
    }
  }

  const statusVariant = (s: string | null): "default" | "secondary" | "destructive" | "outline" => {
    switch (s) {
      case "running": return "default";
      case "paused": return "secondary";
      case "stopped": return "destructive";
      default: return "outline";
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await syncAllContainerStatuses();
      toast.success(result.message);
      fetchData();
    } catch (err) {
      toast.error("同步失败", { description: err instanceof Error ? err.message : "" });
    } finally {
      setSyncing(false);
    }
  };

  // Clamp totalPages to at least 1: with total=0 the old expression yielded 0,
  // showing "1 / 0" and breaking the page >= totalPages next-button boundary.
  const totalPages = data ? Math.max(1, Math.ceil(data.total / 20)) : 1;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">容器管理</h2>
        <Button 
          variant="outline" 
          onClick={handleSync} 
          disabled={syncing}
        >
          {syncing ? "同步中..." : "刷新状态"}
        </Button>
      </div>

      <div className="mb-4">
        <Input
          placeholder="搜索用户名、邮箱或 Docker ID..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="max-w-sm"
        />
      </div>

      {loading ? (
        <p className="text-gray-500">加载中...</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户名</TableHead>
                <TableHead>容器状态</TableHead>
                <TableHead>Docker ID</TableHead>
                <TableHead>容器创建时间</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.username}</TableCell>
                  <TableCell>
                    {user.container_status ? (
                      <Badge variant={statusVariant(user.container_status)}>{user.container_status}</Badge>
                    ) : (
                      <span className="text-gray-400">无容器</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {user.container_docker_id ? user.container_docker_id.substring(0, 12) : "-"}
                  </TableCell>
                  <TableCell>
                    {user.container_created_at ? new Date(user.container_created_at).toLocaleString() : "-"}
                  </TableCell>
                  <TableCell className="space-x-2">
                    {user.container_status === "running" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmAction({ user, type: "pause" })}
                      >
                        暂停
                      </Button>
                    )}
                    {(user.container_status === "paused" || user.container_status === "stopped") && (
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => setConfirmAction({ user, type: "resume" })}
                      >
                        恢复
                      </Button>
                    )}
                    {user.container_status && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => setConfirmAction({ user, type: "destroy" })}
                      >
                        销毁
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-gray-500">共 {data?.total ?? 0} 个用户</p>
            <div className="space-x-2">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
              <span className="text-sm">{page} / {totalPages}</span>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</Button>
            </div>
          </div>
        </>
      )}

      {/* Confirmation Dialog */}
      <Dialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              确认{confirmAction?.type === "pause" ? "暂停" : confirmAction?.type === "resume" ? "恢复" : "销毁"}容器
            </DialogTitle>
          </DialogHeader>
          <p>
            确定要{confirmAction?.type === "pause" ? "暂停" : confirmAction?.type === "resume" ? "恢复" : "销毁"}用户
            <strong> {confirmAction?.user.username} </strong>
            的容器吗？
            {confirmAction?.type === "destroy" && (
              <span className="text-red-500 block mt-2">此操作不可撤销。</span>
            )}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)}>取消</Button>
            <Button
              variant={confirmAction?.type === "destroy" ? "destructive" : "default"}
              onClick={handleConfirm}
            >
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
