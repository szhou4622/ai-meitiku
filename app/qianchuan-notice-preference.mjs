const preferenceKey = "ai-media-library:qianchuan-notices-muted";

/** @param {Pick<Storage, "getItem" | "setItem" | "removeItem"> | null} storage */
export function createQianchuanNoticePreference(storage) {
  let muted = false;
  try { muted = storage?.getItem(preferenceKey) === "1"; } catch {}
  return {
    /** @param {{target?: string | null}} guidance */
    shouldSuppress: guidance => guidance.target === "qianchuan" && muted,
    mute() {
      muted = true;
      try { storage?.setItem(preferenceKey, "1"); } catch {}
    },
    connected() {
      muted = false;
      try { storage?.removeItem(preferenceKey); } catch {}
    },
  };
}

/** @type {ReturnType<typeof createQianchuanNoticePreference> | undefined} */
let preference;
export function qianchuanNoticePreference() {
  if (!preference) {
    let storage = null;
    try { storage = window.localStorage; } catch {}
    preference = createQianchuanNoticePreference(storage);
  }
  return preference;
}

// Call only after fresh authorization or a successful account check, never cached status.
export function markQianchuanConnected() {
  qianchuanNoticePreference().connected();
  window.dispatchEvent(new CustomEvent("qianchuan-connected"));
}
