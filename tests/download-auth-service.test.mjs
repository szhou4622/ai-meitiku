import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DouyinBrowserDownloader } from "../electron/douyin-browser-downloader.mjs";
import {
  browserUserAgent,
  cookiesToHeader,
  cookiesToNetscape,
  hasPlatformLoginCookie,
  isAllowedDownloadLoginUrl,
} from "../electron/download-auth-service.mjs";

test("download login windows only allow official HTTPS platform domains", () => {
  assert.equal(isAllowedDownloadLoginUrl("douyin", "https://passport.douyin.com/login"), true);
  assert.equal(isAllowedDownloadLoginUrl("xiaohongshu", "https://www.xiaohongshu.com/explore"), true);
  assert.equal(isAllowedDownloadLoginUrl("xiaohongshu", "http://www.xiaohongshu.com/explore"), false);
  assert.equal(isAllowedDownloadLoginUrl("douyin", "https://douyin.com.evil.example/login"), false);
  assert.equal(isAllowedDownloadLoginUrl("xiaohongshu", "https://example.com/?next=xiaohongshu.com"), false);
});

test("platform login state requires the correct authenticated cookie", () => {
  assert.equal(hasPlatformLoginCookie("douyin", [{ name: "sessionid_ss", value: "signed-in" }]), true);
  assert.equal(hasPlatformLoginCookie("douyin", [{ name: "msToken", value: "anonymous" }]), false);
  assert.equal(hasPlatformLoginCookie("xiaohongshu", [{ name: "a1", value: "anonymous" }]), false);
  assert.equal(hasPlatformLoginCookie("xiaohongshu", [{ name: "web_session", value: "signed-in" }]), true);
});

test("download cookies are serialized without exposing invalid header characters", () => {
  const cookies = [
    { domain: ".xiaohongshu.com", path: "/", secure: true, expirationDate: 1900000000, name: "web_session", value: "abc123" },
    { domain: ".xiaohongshu.com", path: "/", secure: true, name: "bad\nname", value: "ignored" },
  ];
  assert.equal(cookiesToHeader(cookies), "web_session=abc123");
  const netscape = cookiesToNetscape(cookies);
  assert.match(netscape, /^# Netscape HTTP Cookie File/m);
  assert.match(netscape, /\.xiaohongshu\.com\tTRUE\t\/\tTRUE\t1900000000\tweb_session\tabc123/);
  assert.doesNotMatch(netscape, /bad\nname/);
});

test("download authentication exports a platform-matched browser user agent", () => {
  assert.match(browserUserAgent("151.0.0.0", "win32"), /Windows NT 10\.0; Win64; x64/);
  assert.match(browserUserAgent("151.0.0.0", "win32"), /Chrome\/151\.0\.0\.0/);
  assert.match(browserUserAgent("151.0.0.0", "darwin"), /Macintosh/);
});

test("Douyin browser fallback uses the authenticated partition and writes the media file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-douyin-browser-test-"));
  const targetSession = new EventEmitter();
  const observed = { partition: "", userAgent: "", sourceUrl: "", headers: null };

  class FakeDownloadItem extends EventEmitter {
    setSavePath(target) { this.target = target; }
    getTotalBytes() { return 5; }
    getReceivedBytes() { return 5; }
  }

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      observed.partition = options.webPreferences.partition;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.setUserAgent = (value) => { observed.userAgent = value; };
      this.webContents.setAudioMuted = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.executeJavaScript = async () => ({ url: "https://video.example/video.mp4", title: "验收作品 - 抖音" });
      this.webContents.downloadURL = (url, options) => {
        observed.sourceUrl = url;
        observed.headers = options.headers;
        queueMicrotask(async () => {
          const item = new FakeDownloadItem();
          targetSession.emit("will-download", {}, item, this.webContents);
          await writeFile(item.target, "video", "utf8");
          item.emit("updated");
          item.emit("done", {}, "completed");
        });
      };
    }
    async loadURL() {}
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; }
  }

  const downloader = new DouyinBrowserDownloader({
    BrowserWindow: FakeBrowserWindow,
    session: { fromPartition: () => targetSession },
    partition: "persist:ai-media-download-douyin",
    userAgent: "Windows-UA",
  });
  const result = await downloader.download({
    id: "12345678-abcd",
    url: "https://v.douyin.com/authorized-test/",
    outputDirectory: root,
  });

  assert.equal(observed.partition, "persist:ai-media-download-douyin");
  assert.equal(observed.userAgent, "Windows-UA");
  assert.equal(observed.sourceUrl, "https://video.example/video.mp4");
  assert.equal(observed.headers.Referer, "https://www.douyin.com/");
  assert.equal(await readFile(result.outputFiles[0], "utf8"), "video");
});
