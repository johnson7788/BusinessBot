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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { getUsers, updateUser, resetPassword, createUser } from "@/lib/api";
import type { UserSummary, PaginatedUsers } from "@/types";
import { toast } from "sonner";

export default function UsersPage() {
  const [data, setData] = useState<PaginatedUsers | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  // Edit dialog
  const [editUser, setEditUser] = useState<UserSummary | null>(null);
  const [editRole, setEditRole] = useState("");
  const [editTier, setEditTier] = useState("");
  //dedicated表示独立容器模式，shared表示共享容器模式
  const [editRuntimeMode, setEditRuntimeMode] = useState("dedicated");
  const [editActive, setEditActive] = useState(true);

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [createUsername, setCreateUsername] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createRole, setCreateRole] = useState("user");
  const [createTier, setCreateTier] = useState("free");
  const [createRuntimeMode, setCreateRuntimeMode] = useState("dedicated");

  // Password dialog
  const [pwdUser, setPwdUser] = useState<UserSummary | null>(null);
  const [newPassword, setNewPassword] = useState("");

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getUsers(page, 20, search);
      setData(result);
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  function openEdit(user: UserSummary) {
    setEditUser(user);
    setEditRole(user.role);
    setEditTier(user.quota_tier);
    setEditRuntimeMode(user.runtime_mode || "dedicated");
    setEditActive(user.is_active);
  }

  async function handleSaveEdit() {
    if (!editUser) return;
    try {
      await updateUser(editUser.id, {
        role: editRole,
        quota_tier: editTier,
        runtime_mode: editRuntimeMode,
        is_active: editActive,
      });
      toast.success("用户已更新");
      setEditUser(null);
      fetchUsers();
    } catch (err) {
      toast.error("更新失败", { description: err instanceof Error ? err.message : "" });
    }
  }

  async function handleCreateUser() {
    if (!createUsername.trim() || !createEmail.trim() || !createPassword) {
      toast.error("请填写所有必填字段");
      return;
    }
    if (createPassword.length < 8) {
      toast.error("密码至少8位");
      return;
    }
    try {
      await createUser({
        username: createUsername.trim(),
        email: createEmail.trim(),
        password: createPassword,
        role: createRole,
        quota_tier: createTier,
        runtime_mode: createRuntimeMode,
      });
      toast.success("用户已创建");
      setShowCreate(false);
      setCreateUsername("");
      setCreateEmail("");
      setCreatePassword("");
      setCreateRole("user");
      setCreateTier("free");
      setCreateRuntimeMode("dedicated");
      fetchUsers();
    } catch (err) {
      toast.error("创建失败", { description: err instanceof Error ? err.message : "" });
    }
  }

  async function handleResetPassword() {
    if (!pwdUser) return;
    if (newPassword.length < 8) {
      toast.error("密码至少8位");
      return;
    }
    try {
      await resetPassword(pwdUser.id, newPassword);
      toast.success("密码已重置");
      setPwdUser(null);
      setNewPassword("");
    } catch (err) {
      toast.error("重置失败", { description: err instanceof Error ? err.message : "" });
    }
  }

  // Clamp totalPages to at least 1: with total=0 the old expression yielded 0,
  // showing "1 / 0" and breaking the page >= totalPages next-button boundary.
  const totalPages = data ? Math.max(1, Math.ceil(data.total / 20)) : 1;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">用户管理</h2>

      <div className="mb-4 flex items-center gap-4">
        <Input
          placeholder="搜索用户名或邮箱..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="max-w-sm"
        />
        <Button onClick={() => setShowCreate(true)}>添加用户</Button>
      </div>

      {loading ? (
        <p className="text-gray-500">加载中...</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户名</TableHead>
                <TableHead>邮箱</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>配额</TableHead>
                <TableHead>运行模式</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>今日用量</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.username}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    <Badge variant={user.role === "admin" ? "default" : "secondary"}>
                      {user.role}
                    </Badge>
                  </TableCell>
                  <TableCell>{user.quota_tier}</TableCell>
                  <TableCell>
                    <Badge variant={user.runtime_mode === "shared" ? "secondary" : "outline"}>
                      {user.runtime_mode}
                    </Badge>
                    {user.shared_agent_id ? (
                      <div className="text-xs text-muted-foreground mt-1">
                        {user.shared_agent_id}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.is_active ? "default" : "destructive"}>
                      {user.is_active ? "正常" : "禁用"}
                    </Badge>
                  </TableCell>
                  <TableCell>{user.tokens_used_today.toLocaleString()}</TableCell>
                  <TableCell>{user.created_at ? new Date(user.created_at).toLocaleDateString() : "-"}</TableCell>
                  <TableCell className="space-x-2">
                    <Button size="sm" variant="outline" onClick={() => openEdit(user)}>编辑</Button>
                    <Button size="sm" variant="outline" onClick={() => setPwdUser(user)}>重置密码</Button>
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

      {/* Edit Dialog */}
      <Dialog open={!!editUser} onOpenChange={(open) => !open && setEditUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑用户: {editUser?.username}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>角色</Label>
              <Select value={editRole} onValueChange={(v: string | null) => v && setEditRole(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">user</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>配额等级</Label>
              <Select value={editTier} onValueChange={(v: string | null) => v && setEditTier(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="free">free</SelectItem>
                  <SelectItem value="basic">basic</SelectItem>
                  <SelectItem value="pro">pro</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>运行模式</Label>
              <Select value={editRuntimeMode} onValueChange={(v: string | null) => v && setEditRuntimeMode(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="dedicated">dedicated</SelectItem>
                  <SelectItem value="shared">shared</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Label>账号状态</Label>
              <Select value={editActive ? "active" : "disabled"} onValueChange={(v: string | null) => setEditActive(v === "active")}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">正常</SelectItem>
                  <SelectItem value="disabled">禁用</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)}>取消</Button>
            <Button onClick={handleSaveEdit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create User Dialog */}
      <Dialog open={showCreate} onOpenChange={(open) => { if (!open) { setShowCreate(false); setCreateUsername(""); setCreateEmail(""); setCreatePassword(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加用户</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>用户名 *</Label>
              <Input value={createUsername} onChange={(e) => setCreateUsername(e.target.value)} placeholder="用户名" />
            </div>
            <div>
              <Label>邮箱 *</Label>
              <Input value={createEmail} onChange={(e) => setCreateEmail(e.target.value)} placeholder="email@example.com" />
            </div>
            <div>
              <Label>密码 *</Label>
              <Input type="password" value={createPassword} onChange={(e) => setCreatePassword(e.target.value)} placeholder="至少8位" />
            </div>
            <div>
              <Label>角色</Label>
              <Select value={createRole} onValueChange={(v: string | null) => v && setCreateRole(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">user</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>配额等级</Label>
              <Select value={createTier} onValueChange={(v: string | null) => v && setCreateTier(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="free">free</SelectItem>
                  <SelectItem value="basic">basic</SelectItem>
                  <SelectItem value="pro">pro</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>运行模式</Label>
              <Select value={createRuntimeMode} onValueChange={(v: string | null) => v && setCreateRuntimeMode(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="dedicated">dedicated</SelectItem>
                  <SelectItem value="shared">shared</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreate(false); setCreateUsername(""); setCreateEmail(""); setCreatePassword(""); }}>取消</Button>
            <Button onClick={handleCreateUser}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password Reset Dialog */}
      <Dialog open={!!pwdUser} onOpenChange={(open) => { if (!open) { setPwdUser(null); setNewPassword(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重置密码: {pwdUser?.username}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>新密码</Label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="至少8位"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPwdUser(null); setNewPassword(""); }}>取消</Button>
            <Button onClick={handleResetPassword}>确认重置</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
