import { BrowserWindow as e, app as t, ipcMain as n } from "electron";
import { join as r } from "node:path";
import { mkdirSync as i, writeFileSync as a } from "node:fs";
import { spawn as o } from "node:child_process";
import { createInterface as s } from "node:readline";
//#region electron/main/paths.ts
function c() {
	return process.platform === "darwin" ? "mac" : "windows";
}
var l = !t.isPackaged;
function u() {
	return l ? r(t.getAppPath()) : process.resourcesPath;
}
function d() {
	if (l) return {
		command: c() === "windows" ? "python" : "python3",
		args: ["-m", "sidecar"],
		cwd: t.getAppPath()
	};
	let e = c() === "windows" ? "sidecar.exe" : "sidecar";
	return {
		command: r(u(), "sidecar", e),
		args: [],
		cwd: u()
	};
}
var f = new class {
	proc = null;
	pending = /* @__PURE__ */ new Map();
	nextId = 1;
	start() {
		if (this.proc) return;
		let { command: e, args: t, cwd: n } = d(), r = o(e, t, {
			cwd: n,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		this.proc = r, s({ input: r.stdout }).on("line", (e) => {
			if (!e.trim()) return;
			let t;
			try {
				t = JSON.parse(e);
			} catch {
				console.error("[sidecar] JSONとして解釈できない出力:", e);
				return;
			}
			if (typeof t.id != "number") return;
			let n = this.pending.get(t.id);
			n && (this.pending.delete(t.id), t.error ? n.reject(Error(t.error.message)) : n.resolve(t.result));
		}), r.stderr.on("data", (e) => {
			console.error("[sidecar]", e.toString().trimEnd());
		}), r.on("error", (e) => {
			console.error("[sidecar] 起動に失敗しました:", e.message);
			for (let [, t] of this.pending) t.reject(/* @__PURE__ */ Error(`サイドカーを起動できません: ${e.message}`));
			this.pending.clear(), this.proc = null;
		}), r.on("exit", (e) => {
			console.error(`[sidecar] 終了しました (code=${e})`);
			for (let [, e] of this.pending) e.reject(/* @__PURE__ */ Error("サイドカーが終了しました"));
			this.pending.clear(), this.proc = null;
		});
	}
	call(e, t = {}) {
		this.proc || this.start();
		let n = this.proc;
		if (!n) return Promise.reject(/* @__PURE__ */ Error("サイドカーを起動できませんでした"));
		let r = this.nextId++;
		return new Promise((i, a) => {
			this.pending.set(r, {
				resolve: i,
				reject: a
			}), n.stdin.write(JSON.stringify({
				id: r,
				method: e,
				params: t
			}) + "\n");
		});
	}
	stop() {
		this.proc?.kill(), this.proc = null;
	}
}(), p = () => t.getAppPath();
function m(e, t) {
	try {
		let n = r(p(), "phase0-artifacts");
		i(n, { recursive: !0 }), a(r(n, e), JSON.stringify(t, null, 2), "utf8");
	} catch (e) {
		console.error("診断ファイルを書けませんでした:", e);
	}
}
function h() {
	let t = new e({
		width: 1280,
		height: 860,
		backgroundColor: "#101014",
		webPreferences: {
			preload: r(p(), "dist-electron", "preload", "index.cjs"),
			contextIsolation: !0,
			nodeIntegration: !1
		}
	}), n = process.env.VITE_DEV_SERVER_URL;
	n ? t.loadURL(n) : t.loadFile(r(p(), "dist", "index.html")), l && t.webContents.openDevTools({ mode: "detach" });
}
n.handle("sidecar:call", (e, t, n) => f.call(t, n));
async function g() {
	let e = (e) => m("smoke-result.json", e);
	e({
		ok: !1,
		stage: "started",
		electron: process.versions.electron
	});
	try {
		let n = await f.call("env");
		e({
			ok: !0,
			electron: process.versions.electron,
			env: n
		}), f.stop(), t.exit(0);
	} catch (n) {
		e({
			ok: !1,
			error: n.message
		}), f.stop(), t.exit(1);
	}
	return new Promise(() => {});
}
t.whenReady().then(() => {
	if (f.start(), process.env.SMOKE_TEST === "1" || process.argv.includes("--smoke-test")) {
		g();
		return;
	}
	h(), t.on("activate", () => {
		e.getAllWindows().length === 0 && h();
	});
}).catch((e) => {
	m("startup-error.json", {
		message: e.message,
		stack: e.stack
	}), console.error("起動に失敗しました:", e), t.exit(1);
}), t.on("window-all-closed", () => {
	f.stop(), t.quit();
}), t.on("before-quit", () => f.stop());
//#endregion
export {};
