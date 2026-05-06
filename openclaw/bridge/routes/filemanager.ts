import { Router } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import multer from "multer";
import mime from "mime-types";
import archiver from "archiver";
import type { BridgeConfig } from "../config.js";
import { asyncHandler, sanitizePath } from "../utils.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Fix multer's latin1-encoded originalname for non-ASCII filenames (e.g. Chinese).
 * Browsers send UTF-8 filenames, but multer decodes them as latin1 by default.
 */
function fixOriginalName(raw: string): string {
  try {
    return Buffer.from(raw, "latin1").toString("utf8");
  } catch {
    return raw;
  }
}

export function filemanagerRoutes(config: BridgeConfig): Router {
  const router = Router();
  const upload = multer({ limits: { fileSize: MAX_FILE_SIZE } });
  const rootDir = config.openclawHome;

  // GET /api/filemanager/browse?path=
  router.get("/filemanager/browse", asyncHandler(async (req, res) => {
    const relPath = (req.query.path as string) || "";
    const absPath = relPath ? sanitizePath(relPath, rootDir) : rootDir;

    if (!absPath) {
      res.status(400).json({ detail: "Invalid path" });
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      res.status(404).json({ detail: "Path not found" });
      return;
    }

    // If it's a file, return its content (text files only, capped at 200KB)
    if (stat.isFile()) {
      const contentType = mime.lookup(path.basename(absPath)) || "application/octet-stream";
      const isText = contentType.startsWith("text/") ||
        contentType === "application/json" ||
        contentType === "application/xml" ||
        absPath.endsWith(".md") ||
        absPath.endsWith(".yml") ||
        absPath.endsWith(".yaml") ||
        absPath.endsWith(".toml") ||
        absPath.endsWith(".jsonl");

      if (isText && stat.size <= 200 * 1024) {
        const content = fs.readFileSync(absPath, "utf-8");
        res.json({
          type: "file",
          path: relPath,
          name: path.basename(absPath),
          size: stat.size,
          content_type: contentType,
          modified: stat.mtime.toISOString(),
          content,
        });
        return;
      }

      res.json({
        type: "file",
        path: relPath,
        name: path.basename(absPath),
        size: stat.size,
        content_type: contentType,
        modified: stat.mtime.toISOString(),
      });
      return;
    }

    if (!stat.isDirectory()) {
      res.status(400).json({ detail: "Path is not a file or directory" });
      return;
    }

    const entries = fs.readdirSync(absPath, { withFileTypes: true });

    const items = [];
    for (const e of entries) {
      const itemAbsPath = path.join(absPath, e.name);
      let itemStat: fs.Stats;
      try {
        itemStat = fs.statSync(itemAbsPath);
      } catch { continue; }

      const itemRelPath = path.relative(rootDir, itemAbsPath);
      const isDir = itemStat.isDirectory();

      items.push({
        name: e.name,
        path: itemRelPath,
        type: isDir ? "directory" : "file",
        size: isDir ? null : itemStat.size,
        content_type: isDir ? null : (mime.lookup(e.name) || "application/octet-stream"),
        modified: itemStat.mtime.toISOString(),
      });
    }

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    res.json({ type: "directory", path: relPath, root: rootDir, items });
  }));

  // GET /api/filemanager/download?path=
  router.get("/filemanager/download", asyncHandler(async (req, res) => {
    const relPath = req.query.path as string;
    if (!relPath) {
      res.status(400).json({ detail: "Path is required" });
      return;
    }

    const absPath = sanitizePath(relPath, rootDir);
    if (!absPath || !fs.existsSync(absPath)) {
      res.status(404).json({ detail: "Path not found" });
      return;
    }

    const stat = fs.statSync(absPath);

    if (stat.isDirectory()) {
      // Zip the directory and stream it
      const dirName = path.basename(absPath);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(dirName)}.zip"`);

      const archive = archiver("zip", { zlib: { level: 6 } });
      archive.on("error", (err: Error) => {
        res.status(500).json({ detail: err.message });
      });
      archive.pipe(res);
      archive.directory(absPath, dirName);
      await archive.finalize();
      return;
    }

    const fileName = path.basename(absPath);
    const contentType = mime.lookup(fileName) || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    fs.createReadStream(absPath).pipe(res);
  }));

  // GET /api/filemanager/serve?path=  (absolute path, for files outside .openclaw)
  // Allows serving files from anywhere under the user's home directory.
  router.get("/filemanager/serve", asyncHandler(async (req, res) => {
    const absPathParam = req.query.path as string;
    if (!absPathParam) {
      res.status(400).json({ detail: "Path is required" });
      return;
    }

    // Decode the path (handle URL encoding)
    let decodedPath = absPathParam;
    try {
      let prev = "";
      while (decodedPath !== prev && decodedPath.includes("%")) {
        prev = decodedPath;
        decodedPath = decodeURIComponent(decodedPath);
      }
    } catch { /* use as-is */ }

    const resolved = path.resolve(decodedPath);

    // Security: only allow paths under home directory or /tmp
    const homeDir = os.homedir();
    const allowedRoots = [homeDir, "/tmp"];
    const allowed = allowedRoots.some((root) => resolved.startsWith(root));
    if (!allowed) {
      res.status(403).json({ detail: "Access denied: path outside allowed directories" });
      return;
    }

    // Block sensitive paths
    const blocked = [".ssh", ".gnupg", ".env", "credentials", ".git/config"];
    if (blocked.some((b) => resolved.includes(b))) {
      res.status(403).json({ detail: "Access denied: sensitive path" });
      return;
    }

    if (!fs.existsSync(resolved)) {
      res.status(404).json({ detail: "File not found" });
      return;
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      res.status(400).json({ detail: "Cannot serve directory via this endpoint" });
      return;
    }

    const fileName = path.basename(resolved);
    const contentType = mime.lookup(fileName) || "application/octet-stream";

    // For images, allow inline display (no Content-Disposition: attachment)
    const isImage = contentType.startsWith("image/");
    const disposition = req.query.inline === "1" && isImage ? "inline" : "attachment";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(fileName)}"`);
    fs.createReadStream(resolved).pipe(res);
  }));

  // POST /api/filemanager/upload  (multipart, body.path = target dir)
  router.post("/filemanager/upload", upload.single("file"), asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file || !file.originalname) {
      res.status(400).json({ detail: "No file provided" });
      return;
    }

    const fileName = fixOriginalName(file.originalname);

    const targetDir = (req.body.path as string) || "";
    const absDirPath = targetDir ? sanitizePath(targetDir, rootDir) : rootDir;
    if (!absDirPath) {
      res.status(400).json({ detail: "Invalid path" });
      return;
    }

    if (fileName.includes("/") || fileName.includes("\\")) {
      res.status(400).json({ detail: "Invalid filename" });
      return;
    }

    fs.mkdirSync(absDirPath, { recursive: true });
    const filePath = path.join(absDirPath, fileName);
    fs.writeFileSync(filePath, file.buffer);
    const stat = fs.statSync(filePath);

    res.json({
      name: fileName,
      path: path.relative(rootDir, filePath),
      type: "file",
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }));

  // PUT /api/filemanager/write  (json: { path, content })
  router.put("/filemanager/write", asyncHandler(async (req, res) => {
    const relPath = typeof req.body?.path === "string" ? req.body.path : "";
    const content = typeof req.body?.content === "string" ? req.body.content : null;
    if (!relPath) {
      res.status(400).json({ detail: "Path is required" });
      return;
    }
    if (content === null) {
      res.status(400).json({ detail: "Content is required" });
      return;
    }

    const absPath = sanitizePath(relPath, rootDir);
    if (!absPath) {
      res.status(400).json({ detail: "Invalid path" });
      return;
    }
    if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
      res.status(400).json({ detail: "Cannot write content to a directory" });
      return;
    }

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf-8");
    const stat = fs.statSync(absPath);
    const fileName = path.basename(absPath);

    res.json({
      name: fileName,
      path: path.relative(rootDir, absPath),
      type: "file",
      size: stat.size,
      content_type: mime.lookup(fileName) || "text/plain",
      modified: stat.mtime.toISOString(),
    });
  }));

  // DELETE /api/filemanager/delete?path=
  router.delete("/filemanager/delete", asyncHandler(async (req, res) => {
    const relPath = req.query.path as string;
    if (!relPath) {
      res.status(400).json({ detail: "Path is required" });
      return;
    }

    const absPath = sanitizePath(relPath, rootDir);
    if (!absPath || !fs.existsSync(absPath)) {
      res.status(404).json({ detail: "Path not found" });
      return;
    }

    // Prevent deleting the root itself
    if (absPath === rootDir) {
      res.status(400).json({ detail: "Cannot delete root directory" });
      return;
    }

    fs.rmSync(absPath, { recursive: true });
    res.json({ ok: true });
  }));

  // POST /api/filemanager/mkdir?path=
  router.post("/filemanager/mkdir", asyncHandler(async (req, res) => {
    const relPath = req.query.path as string;
    if (!relPath) {
      res.status(400).json({ detail: "Path is required" });
      return;
    }

    const absPath = sanitizePath(relPath, rootDir);
    if (!absPath) {
      res.status(400).json({ detail: "Invalid path" });
      return;
    }

    fs.mkdirSync(absPath, { recursive: true });
    res.json({ name: path.basename(absPath), path: relPath, type: "directory" });
  }));

  return router;
}
