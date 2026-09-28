import { serve } from "bun";
import { readdir, mkdir, stat, statfs, unlink, rm, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PORT = 3000;
const STORAGE_DIR = "ここを正しいパスに置き換える";

await mkdir(STORAGE_DIR, { recursive: true });

function getSafePath(relativePath: string) {
  const safePath = resolve(STORAGE_DIR, "." + relativePath);
  if (!safePath.startsWith(STORAGE_DIR)) {
    throw new Error("Invalid path");
  }
  return safePath;
}

function getDeleteSafePath(itemPath: string) {
  const cleanPath = itemPath.startsWith("/") ? itemPath : "/" + itemPath;
  const safePath = resolve(STORAGE_DIR, "." + cleanPath);
  if (!safePath.startsWith(STORAGE_DIR)) {
    throw new Error("Invalid path");
  }
  return safePath;
}

serve({
  port: PORT,
  async fetch(req) {
    const requestUrl = new URL(req.url);
    const pathname = decodeURIComponent(requestUrl.pathname);

    try {
      const targetPath = getSafePath(pathname);

      if (req.method === "DELETE" || req.method === "POST") {
        const contentType = req.headers.get("content-type") || "";

        // JSONリクエスト（フォルダ作成・削除・大容量チャンクアップロード制御）
        if (contentType.includes("application/json")) {
          const body = await req.json() as { 
            action?: string; 
            dirname?: string; 
            path?: string;
            filename?: string;
            relPath?: string;
            chunkIndex?: number;
            totalChunks?: number;
            data?: string; // base64
          };
          
          if (body.action === "create_folder" && body.dirname) {
            const newFolderPath = join(targetPath, body.dirname);
            await mkdir(newFolderPath, { recursive: true });
            return new Response(JSON.stringify({ success: true }), {
              headers: { "Content-Type": "application/json" },
            });
          }

          if (body.action === "delete" && body.path) {
            const deleteTargetPath = getDeleteSafePath(body.path);
            const targetStat = await stat(deleteTargetPath);

            if (targetStat.isDirectory()) {
              await rm(deleteTargetPath, { recursive: true, force: true });
            } else {
              await unlink(deleteTargetPath);
            }
            return new Response(JSON.stringify({ success: true }), {
              headers: { "Content-Type": "application/json" },
            });
          }

          // 大容量ファイル分割アップロード（チャンク受信）
          if (body.action === "upload_chunk" && body.filename && body.data !== undefined) {
            const relPath = body.relPath || body.filename;
            const filePath = join(targetPath, relPath);

            const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
            if (parentDir) {
              await mkdir(parentDir, { recursive: true });
            }

            // Base64からバイナリに変換してファイルに追記
            const buffer = Buffer.from(body.data, "base64");
            if (body.chunkIndex === 0) {
              // 最初の一発目はファイルを新規作成（上書き）
              await Bun.write(filePath, buffer);
            } else {
              // 2番目以降は末尾に追記
              await appendFile(filePath, buffer);
            }

            return new Response(JSON.stringify({ success: true }), {
              headers: { "Content-Type": "application/json" },
            });
          }

          return new Response("不正なリクエストです", { status: 400 });
        }

        // 通常の小ファイル用フォームアップロード（フォールバック）
        if (req.method === "POST") {
          try {
            const formData = await req.formData();
            const files = formData.getAll("file");
            const relativePaths = formData.getAll("relativePath") as string[];

            if (files.length > 0) {
              for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (!(file instanceof File)) continue;

                const relPath = relativePaths[i] || file.name;
                const filePath = join(targetPath, relPath);

                const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
                if (parentDir) {
                  await mkdir(parentDir, { recursive: true });
                }

                await Bun.write(filePath, file);
              }

              return new Response(JSON.stringify({ success: true }), {
                headers: { "Content-Type": "application/json" },
              });
            }
          } catch (uploadErr) {
            console.error("Upload Error Detail:", uploadErr);
            return new Response("アップロード処理に失敗しました", { status: 500 });
          }
        }
      }

      // GET処理（ファイルダウンロード・一覧画面）
      let fileStats;
      try {
        fileStats = await stat(targetPath);
      } catch {
        return new Response("ファイルまたはディレクトリが見つかりません", { status: 404 });
      }

      if (fileStats.isDirectory()) {
        const dirents = await readdir(targetPath, { withFileTypes: true });
        const relativePath = pathname === "/" ? "" : pathname;

        const disk = await statfs(STORAGE_DIR);
        const totalSize = disk.blocks * disk.bsize;
        const freeSize = disk.bfree * disk.bsize;
        const usedSize = totalSize - freeSize;

        let htmlTemplate = await Bun.file(join(import.meta.dir, "index.html")).text();

        const fileListHtml = [
          pathname !== "" && pathname !== "/" ? '<li><span><a href="..">📁 .. (上の階層)</a></span></li>' : "",
          ...dirents.map((d) => {
            const isDir = d.isDirectory();
            const icon = isDir ? "📁" : "📄";
            const name = d.name;
            const base = pathname === "/" ? "" : pathname;
            const itemPath = base.endsWith("/") ? base + name : base + "/" + name;
            return `
              <li>
                <a href="${itemPath}"><span class="icon">${icon}</span>${name}</a>
                <button class="delete-btn" onclick="deleteItem('${itemPath}', '${name}')">削除</button>
              </li>
            `;
          })
        ].join("");

        htmlTemplate = htmlTemplate
          .replace("{{RELATIVE_PATH}}", relativePath || "/")
          .replace("{{FILE_LIST}}", fileListHtml)
          .replace("{{USED_SIZE}}", usedSize.toString())
          .replace("{{FREE_SIZE}}", freeSize.toString());

        return new Response(htmlTemplate, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response(Bun.file(targetPath));
    } catch (e) {
      console.error("Server Error:", e);
      return new Response("エラーが発生しました", { status: 500 });
    }
  },
});

console.log(`🚀 NASサーバーが起動しました: http://localhost:${PORT}`);
