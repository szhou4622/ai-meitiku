"use client";

import { promptBaseline } from "../electron/prompt-baseline.mjs";

import {
  splitShotPrompts,
  formatShotPrompts,
} from "../electron/prompt-shots.mjs";
import { formatPromptTimeline } from "../electron/prompt-format.mjs";
import { classifyUserAction } from "../electron/user-action-errors.mjs";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Copy,
  Download,
  FileText,
  ImagePlus,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";

type Mode = "restore" | "template";
type View = "full" | "shots";
type Role = "product" | "person" | "scene";
type Action =
  "refine" | "replace" | "convert" | "extract-dialogue" | "apply-dialogue";
type Material = {
  id: string;
  name: string;
  role: Role;
  mime: string;
  file: string;
};
export type PromptRecord = {
  id: string;
  title: string;
  tags: string;
  variants: Record<Mode, Record<View, string>>;
  dialogue: string;
  favorite: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  materials: Material[];
  source?: {
    id: string;
    kind: "image" | "video";
    name: string;
    duration: number | null;
    width: number | null;
    height: number | null;
    hasAudio: boolean;
  } | null;
  reverse?: {
    full: string;
    shots: string;
    provider: string;
    model: string;
    usage: Generated["usage"];
    generatedAt: string;
    sourceId: string;
    evidence?: { audioEvidence?: string; audioStatus?: string; audioError?: string | null; frameCount?: number };
  } | null;
};
type Generated = {
  text: string;
  provider: string;
  model: string;
  usage: {
    input: number | null;
    output: number | null;
    total: number | null;
  } | null;
};
export type PromptLibraryBridge = {
  chooseSource: (
    id: string,
    revision: number,
    assetId?: number,
  ) => Promise<PromptRecord | null>;
  sourcePreview: (id: string) => Promise<string | null>;
  reverse: (
    id: string,
    revision: number,
    transcript: string,
  ) => Promise<PromptRecord>;
  migrate: (id: string, revision: number) => Promise<PromptRecord>;
  onProgress: (
    callback: (progress: { id: string; message: string; state?: "queued" | "running" | "retrying"; concurrency?: number }) => void,
  ) => () => void;
  list: () => Promise<PromptRecord[]>;
  status: () => Promise<{ provider: string; ready: boolean; concurrency: number }>;
  save: (payload: Partial<PromptRecord>) => Promise<PromptRecord>;
  remove: (id: string, revision: number) => Promise<{ ok: boolean }>;
  visit: (id: string) => Promise<PromptRecord>;
  generate: (payload: {
    action: Action;
    id: string;
    mode: Mode;
    view: View;
    source: string;
    instructions: string;
    dialogue: string;
    materialIds: string[];
  }) => Promise<Generated>;
  importFiles: () => Promise<PromptRecord[]>;
  addMaterials: (
    id: string,
    revision: number,
    role: Role,
    assetIds?: number[],
    droppedPaths?: string[],
  ) => Promise<PromptRecord | null>;
  removeMaterial: (
    id: string,
    revision: number,
    materialId: string,
  ) => Promise<PromptRecord>;
  materialPreview: (id: string, materialId: string) => Promise<string | null>;
  copy: (text: string) => Promise<{ ok: boolean }>;
  exportText: (title: string, text: string) => Promise<{ ok: boolean }>;
};
type GeneratedResult = Generated & { action: Action; mode: Mode; view: View; recordId: string; dialogue: string };

type LibraryImage = {
  id: number;
  name: string;
  type: string;
  src: string;
  localPath?: string;
  deleted?: boolean;
  broken?: boolean;
  available?: boolean;
};
const roleLabels: Record<Role, string> = {
  product: "换货",
  person: "换人",
  scene: "换景",
};
const roleDescriptions: Record<Role, string> = {
  product: "产品素材",
  person: "人物素材",
  scene: "场景素材",
};
const blankVariants = () => ({
  restore: { full: "", shots: "" },
  template: { full: "", shots: "" },
});

function emptyDraft(): PromptRecord {
  return {
    id: "",
    title: "未命名提示词",
    tags: "",
    variants: blankVariants(),
    dialogue: "",
    favorite: false,
    revision: 0,
    createdAt: "",
    updatedAt: "",
    lastUsedAt: null,
    materials: [],
  };
}

export function PromptLibrary({
  assets,
  notify,
  onConfigure,
  contactAuthor,
  registerBeforeLeave,
  initialRecord,
  active = true,
}: {
  assets: LibraryImage[];
  notify: (message: string) => void;
  onConfigure: () => void;
  contactAuthor: ReactNode;
  registerBeforeLeave: (handler: (() => Promise<boolean>) | null) => void;
  initialRecord?: PromptRecord;
  active?: boolean;
}) {
  const [items, setItems] = useState<PromptRecord[]>([]);
  const [current, setCurrent] = useState<PromptRecord>(
    () => initialRecord || emptyDraft(),
  );
  const [mode, setMode] = useState<Mode>("restore");
  const [view, setView] = useState<View>("full");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [api, setApi] = useState<{ provider: string; ready: boolean } | null>(
    null,
  );
  const [roles, setRoles] = useState<Role[]>(["product", "person", "scene"]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [materialLightbox, setMaterialLightbox] = useState<{ name: string; url: string } | null>(null);
  const lightboxClose = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!materialLightbox) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    lightboxClose.current?.focus();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMaterialLightbox(null); }
      if (event.key === "Tab") { event.preventDefault(); lightboxClose.current?.focus(); }
    };
    document.addEventListener("keydown", dismiss, true);
    return () => { document.removeEventListener("keydown", dismiss, true); previousFocus?.focus(); };
  }, [materialLightbox]);
  const [picker, setPicker] = useState<Role | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [pickerQuery, setPickerQuery] = useState("");
  const [dialogueOpen, setDialogueOpen] = useState(false);
  const [dialogueDraft, setDialogueDraft] = useState("");
  const [aiDialog, setAiDialog] = useState<Action | null>(null);
  const [concurrency, setConcurrency] = useState(3);
  const currentId = useRef(current.id);
  currentId.current = current.id;
  const [tasks, setTasks] = useState<Record<string, { title: string; action: Action | "reverse"; state: "queued" | "running" | "retrying"; message: string }>>({});
  const currentTask = tasks[current.id];
  const generatingAction = currentTask?.action === "reverse" ? null : currentTask?.action;
  const reverseRunning = currentTask?.action === "reverse";
  const [results, setResults] = useState<Record<string, GeneratedResult>>({});
  const result = results[current.id] || null;
  const setResult = (value: GeneratedResult | null) => setResults(previous => {
    const next = { ...previous };
    if (value) next[value.recordId] = value;
    else delete next[current.id];
    return next;
  });
  const [resultOpen, setResultOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newText, setNewText] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [sourcePicker, setSourcePicker] = useState(false);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [progress, setProgress] = useState("");

  const bridge = () => {
    const value = window.desktopBridge?.promptLibrary;
    if (!value) throw new Error("请在桌面版媒体库中使用提示词库");
    return value;
  };
  const failure = (reason: unknown) => {
    const action = classifyUserAction(reason);
    if (action) { setError(action.message); return; }
    setError(
      reason instanceof Error
        ? reason.message.replace(
            /^Error invoking remote method '[^']+': (?:Error: )?/,
            "",
          )
        : `操作失败：${typeof reason === "string" ? reason : JSON.stringify(reason) || "未提供错误原因"}`,
    );
  };
  const upsert = (item: PromptRecord) =>
    setItems((previous) =>
      previous.some((entry) => entry.id === item.id)
        ? previous.map((entry) => (entry.id === item.id ? item : entry))
        : [item, ...previous],
    );
  const adopt = (item: PromptRecord) => {
    upsert(item);
    currentId.current = item.id;
    setCurrent(item);
    setDirty(false);
  };
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const values = await bridge().list();
        if (live) {
          setItems(values);
          const first = [...values].sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt),
          )[0];
          if (first) {
            setCurrent(first);
            setMode("restore");
          }
        }
        const status = await bridge().status();
        if (live) { setApi(status); setConcurrency(status.concurrency); }
      } catch (reason) {
        if (live) failure(reason);
      } finally {
        if (live) setLoading(false);
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (active) void bridge().status().then(status => { setApi(status); setConcurrency(status.concurrency); }).catch(failure);
  }, [active]);
  const previewId = current?.id;
  const sourceId = current.source?.id;
  useEffect(() => {
    let live = true;
    if (sourceId && previewId)
      void bridge()
        .sourcePreview(previewId)
        .then((url) => {
          if (live) setSourceUrl(url);
        })
        .catch(failure);
    return () => {
      live = false;
    };
  }, [sourceId, previewId]);
  useEffect(() => {
    if (!window.desktopBridge?.promptLibrary?.onProgress) return;
    return window.desktopBridge.promptLibrary.onProgress((value) => {
      if (value.concurrency !== undefined) setConcurrency(value.concurrency);
      setTasks(previous => previous[value.id] ? {
        ...previous, [value.id]: { ...previous[value.id], message: value.message, state: value.state || previous[value.id].state },
      } : previous);
      if (value.id === previewId) setProgress(value.message);
    });
  }, [previewId]);
  const previewMaterials = current?.materials;
  useEffect(() => {
    let live = true;
    const id = previewId;
    const materials = previewMaterials;
    if (id && materials)
      for (const material of materials) {
        void bridge()
          .materialPreview(id, material.id)
          .then((url) => {
            if (live && url)
              setPreviews((previous) => ({ ...previous, [material.id]: url }));
          })
          .catch(() => {});
      }
    return () => {
      live = false;
    };
  }, [previewId, previewMaterials]);
  const visible = useMemo(
    () =>
      items
        .filter(
          (item) =>
            (filter !== "favorite" || item.favorite) &&
            (filter !== "recent" || item.lastUsedAt) &&
            `${item.title} ${item.tags} ${Object.values(item.variants).flatMap(Object.values).join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          (filter === "recent"
            ? b.lastUsedAt || ""
            : b.createdAt
          ).localeCompare(
            filter === "recent" ? a.lastUsedAt || "" : a.createdAt,
          ),
        ),
    [items, query, filter],
  );
  const baseline = promptBaseline(current);
  const storedText = current?.variants[mode][view] || "";
  const text = mode === "restore" ? formatPromptTimeline(storedText) : storedText;
  const shotPrompts = useMemo(() => splitShotPrompts(text), [text]);
  const source =
    text ||
    current?.variants[mode].full ||
    current?.variants.restore.full ||
    current?.variants.template.full ||
    "";
  const editable = !busy && !result && !currentTask;
  useEffect(() => {
    registerBeforeLeave(async () => {
      if (
        busy ||
        resultOpen ||
        newOpen ||
        dialogueOpen ||
        aiDialog ||
        picker ||
        deleteOpen ||
        sourcePicker ||
        reverseOpen ||
        materialLightbox
      ) {
        notify("请先完成或关闭提示词库中的当前操作");
        return false;
      }
      try {
        await persistIfDirty();
        return true;
      } catch (reason) {
        failure(reason);
        return false;
      }
    });
    return () => registerBeforeLeave(null);
  });
  const edit = (patch: Partial<PromptRecord>) => {
    if (current) {
      setCurrent({ ...current, ...patch });
      setDirty(true);
    }
  };
  async function run(label: string, task: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await task();
    } catch (reason) {
      failure(reason);
    } finally {
      setBusy("");
    }
  }
  async function persist(): Promise<PromptRecord> {
    if (!current) throw new Error("请先选择提示词");
    if (!dirty && current.id) return current;
    const saved = await bridge().save(current);
    adopt(saved);
    return saved;
  }
  async function select(item: PromptRecord) {
    await run("正在打开…", async () => {
      await persistIfDirty();
      const visited = await bridge().visit(item.id);
      adopt(visited);
      setMode("restore");
      setSourceUrl(null);
      setView("full");
      setResultOpen(false);
    });
  }
  async function persistIfDirty() {
    if (current && dirty) await persist();
  }
  async function add(role: Role, assetIds?: number[], droppedPaths?: string[]) {
    await run("正在添加素材…", async () => {
      const saved = await persist();
      const updated = await bridge().addMaterials(
        saved.id,
        saved.revision,
        role,
        assetIds,
        droppedPaths,
      );
      if (updated) {
        adopt(updated);
        setPicker(null);
        setPicked([]);
      }
    });
  }
  async function chooseSource(assetId?: number) {
    await run("正在读取原素材…", async () => {
      const saved = await persist();
      const item = await bridge().chooseSource(
        saved.id,
        saved.revision,
        assetId,
      );
      if (item) {
        adopt(item);
        setSourceUrl(null);
        setMode("restore");
        setView("full");
        setSourcePicker(false);
        setTranscript("");
      }
    });
  }
  async function migrate() {
    await run("正在打开可迁移模板…", async () => {
      const saved = await persist();
      adopt(await bridge().migrate(saved.id, saved.revision));
      setMode("template");
    });
  }
  function enqueueTask(saved: PromptRecord, action: Action | "reverse", work: () => Promise<void>) {
    setTasks(previous => ({ ...previous, [saved.id]: { title: saved.title, action, state: "queued", message: "等待排队" } }));
    void work().catch(reason => {
      const message = reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : `操作失败：${typeof reason === "string" ? reason : JSON.stringify(reason) || "未提供错误原因"}`;
      notify(`「${saved.title}」任务失败：${message}`);
      if (currentId.current === saved.id) failure(reason);
    }).finally(() => {
      setTasks(previous => { const next = { ...previous }; delete next[saved.id]; return next; });
    });
  }
  async function reverse() {
    if (currentTask || busy) return;
    const submittedTranscript = transcript;
    setReverseOpen(false);
    await run("正在提交任务…", async () => {
      const saved = await persist();
      enqueueTask(saved, "reverse", async () => {
        const item = await bridge().reverse(saved.id, saved.revision, submittedTranscript);
        upsert(item);
        if (currentId.current === saved.id) {
          adopt(item);
          setMode("restore");
          setView("full");
        }
        notify(`「${item.title}」反推完成，原始结果已保存到提示词库`);
      });
    });
  }
  async function generate(action: Action) {
    if (currentTask || busy || result) return;
    const submitted = { action, mode, view, source, instructions, dialogue: dialogueDraft || current.dialogue };
    const submittedRoles = [...roles];
    setAiDialog(null);
    setDialogueOpen(false);
    setResultOpen(false);
    await run("正在提交任务…", async () => {
      const saved = await persist();
      enqueueTask(saved, action, async () => {
        const output = await bridge().generate({
          ...submitted,
          id: saved.id,
          materialIds: action === "replace" ? saved.materials.filter(material => submittedRoles.includes(material.role)).map(material => material.id) : [],
        });
        setResults(previous => ({ ...previous, [saved.id]: { ...output, action, mode: submitted.mode, view: submitted.view, recordId: saved.id, dialogue: submitted.dialogue } }));
        notify(`「${saved.title}」AI 生成完成，打开该提示词查看并采用结果`);
      });
    });
  }
  const modal = (
    title: string,
    content: ReactNode,
    footer: ReactNode,
    close: () => void,
  ) => (
    <div className="prompt-modal-backdrop">
      <section
        className="prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button disabled={!!busy} onClick={close} aria-label="关闭">
            <X size={20} />
          </button>
        </header>
        {error && (
          <div className={classifyUserAction(error) ? "prompt-guidance" : "prompt-error"} role={classifyUserAction(error) ? "status" : "alert"}>
            {error}
            {classifyUserAction(error)?.target === "models" && <button onClick={onConfigure}>去配置 API</button>}
          </div>
        )}
        {content}
        <footer>{footer}</footer>
      </section>
    </div>
  );

  return (
    <section className="prompt-library-page">
      <header className="prompt-page-header">
        <div className="prompt-brand">
          <div className="prompt-brand-icon workspace-heading-icon">
            <FileText size={29} />
          </div>
          <div>
            <div className="feature-title-line">
              <h1>提示词库</h1>
              {contactAuthor}
            </div>
            <p>从图片或视频反推提示词，再复用为可迁移模板。</p>
          </div>
        </div>
        <div className="prompt-header-actions">
          <button
            disabled={!!busy || loading}
            onClick={() =>
              void run("正在导入…", async () => {
                await persistIfDirty();
                const imported = await bridge().importFiles();
                const all = await bridge().list();
                setItems(all);
                if (imported[0]) {
                  adopt(imported[0]);
                  setMode("restore");
                  setView("full");
                }
                if (imported.length)
                  notify(`已导入 ${imported.length} 条提示词`);
              })
            }
          >
            <Upload size={16} />
            导入提示词
          </button>
          <button
            className="primary"
            disabled={!!busy || loading}
            onClick={() => {
              setNewTitle("");
              setNewText("");
              setNewOpen(true);
            }}
          >
            <Plus size={16} />
            新建提示词
          </button>
        </div>
      </header>
      {(Object.keys(results).length > 0) && (
        <div className="prompt-background-status" role="status">
          {Object.keys(results).map(id => (
            <button key={id} className="primary" disabled={!!busy} onClick={() => {
              const item = items.find(entry => entry.id === id);
              if (item) void select(item).then(() => { if (currentId.current === id) setResultOpen(true); });
            }}>查看「{items.find(item => item.id === id)?.title || "提示词"}」结果</button>
          ))}
        </div>
      )}
      <div className="prompt-api-status">
        <span>
          生成 API：
          {api
            ? api.provider === "relay"
              ? "中转 API"
              : "火山引擎"
            : loading
              ? "读取中…"
              : "暂不可用"}
          {api && !api.ready ? " · 未配置完整" : ""}
        </span>
        <button
          onClick={onConfigure}
          disabled={!!busy || dirty || !!result}
          title={dirty ? "请先保存修改" : undefined}
        >
          API 设置
        </button>
        <small>当前并发：{concurrency}</small>
      </div>
      {error && (
        <div className={classifyUserAction(error) ? "prompt-guidance" : "prompt-error"} role={classifyUserAction(error) ? "status" : "alert"}>
          {error}
          {classifyUserAction(error)?.target === "models" && <button onClick={onConfigure}>去配置 API</button>}
          <button onClick={() => setError("")} aria-label="关闭错误">
            <X size={15} />
          </button>
        </div>
      )}
      <div className="prompt-columns">
        <aside className="prompt-list-panel">
          <h2>我的提示词 · {items.length}</h2>
          <label className="prompt-search">
            <Search size={16} />
            <input
              placeholder="搜索名称、标签或提示词"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="prompt-filter">
            {[
              ["all", "全部"],
              ["favorite", "收藏"],
              ["recent", "最近使用"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? "active" : ""}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="prompt-records">
            {visible.map((item) => (
              <button
                key={item.id}
                disabled={!!busy}
                className={`prompt-record ${current?.id === item.id ? "active" : ""}`}
                onClick={() => void select(item)}
              >
                <div className="prompt-record-icon">
                  <FileText size={25} />
                </div>
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {tasks[item.id] ? (tasks[item.id].state === "queued" ? "排队中" : tasks[item.id].state === "retrying" ? "等待重试" : "生成中") : results[item.id] ? "结果待确认" : item.variants.template.full ? "可迁移模板" : "1:1 还原"}
                  </span>
                  <small>{item.tags || "未设置标签"}</small>
                  <small>
                    {new Date(item.updatedAt).toLocaleDateString()} 更新
                  </small>
                </div>
                <Star
                  size={17}
                  className={item.favorite ? "favorite" : ""}
                  fill={item.favorite ? "currentColor" : "none"}
                />
              </button>
            ))}
            {!visible.length && (
              <div className="prompt-list-empty">
                {loading
                  ? "正在读取提示词库…"
                  : items.length
                    ? "没有匹配的提示词"
                    : "还没有提示词。新建或导入文本后，即可收藏与复用。"}
              </div>
            )}
          </div>
        </aside>
        <section className="prompt-detail-panel">
          <>
            <header className="prompt-detail-header">
              <div>
                <input
                  aria-label="提示词名称"
                  value={current.title}
                  maxLength={120}
                  disabled={!editable}
                  onChange={(event) => edit({ title: event.target.value })}
                />
                <p>
                  反推提示词输出 ·{" "}
                  {!current.id
                    ? "上传原素材后开始反推"
                    : dirty
                      ? "有未保存修改"
                      : "已保存到本地"}
                </p>
              </div>
              <button
                disabled={!editable}
                onClick={() =>
                  void run("正在保存收藏…", async () => {
                    const saved = await persist();
                    adopt(
                      await bridge().save({
                        ...saved,
                        favorite: !saved.favorite,
                      }),
                    );
                  })
                }
                aria-label={current.favorite ? "取消收藏" : "收藏"}
              >
                <Star
                  size={21}
                  className={current.favorite ? "favorite" : ""}
                  fill={current.favorite ? "currentColor" : "none"}
                />
              </button>
              <button
                disabled={!editable}
                onClick={() =>
                  void run("正在保存…", async () => {
                    await persistIfDirty();
                    setCurrent(emptyDraft());
                  })
                }
                aria-label="关闭详情"
              >
                <X size={19} />
              </button>
            </header>
            <label className="prompt-tags">
              标签
              <input
                placeholder="如：产品展示、场景种草"
                value={current.tags}
                maxLength={500}
                disabled={!editable}
                onChange={(event) => edit({ tags: event.target.value })}
              />
            </label>
            <div className="prompt-toolbar">
              <div className="prompt-segment">
                {(
                  [
                    ["restore", "1:1 还原"],
                    ["template", "可迁移模板"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    disabled={!editable}
                    className={mode === value ? "active" : ""}
                    onClick={() => {
                      if (value === "template" && baseline?.full)
                        void migrate();
                      else setMode(value);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="prompt-segment">
                {(
                  [
                    ["full", "整片提示词"],
                    ["shots", "逐镜提示词"],
                  ] as const
                )
                  .filter(
                    ([value]) =>
                      value !== "shots" || current.source?.kind !== "image",
                  )
                  .map(([value, label]) => (
                    <button
                      key={value}
                      disabled={!editable}
                      className={view === value ? "active" : ""}
                      onClick={() => setView(value)}
                    >
                      {label}
                    </button>
                  ))}
              </div>
              {mode === "template" && (
                <button
                  className="primary"
                  disabled={!editable || !source || !baseline?.full}
                  onClick={() => {
                    setInstructions("");
                    setAiDialog("refine");
                  }}
                >
                  <Sparkles size={16} />
                  {generatingAction === "refine"
                    ? "正在生成…"
                    : `AI 精修${view === "full" ? "整片" : "逐镜"}`}
                </button>
              )}
            </div>
            {mode === "restore" && (
              <section className="prompt-source-card">
                <h2>原素材反推提示词</h2>
                <p>上传图片或视频，按原素材反推人物、物体、场景与画面细节。</p>
                <div className="prompt-source-layout">
                  <div className="prompt-source-preview">
                    {current.source && sourceUrl ? (
                      current.source.kind === "video" ? (
                        <video
                          key={current.source.id}
                          controls
                          src={sourceUrl}
                          preload="metadata"
                        />
                      ) : (
                        <img src={sourceUrl} alt={current.source.name} />
                      )
                    ) : (
                      <div>
                        <Upload size={32} />
                        <span>上传图片或视频开始反推</span>
                      </div>
                    )}
                  </div>
                  <div className="prompt-source-actions">
                    <strong>{current.source?.name || "尚未选择原素材"}</strong>
                    <small>
                      {reverseRunning
                        ? currentTask?.message || "正在反推…"
                        : current.source
                          ? current.source.kind === "image"
                            ? "图片 · 仅整片提示词"
                            : `视频 · ${current.source.duration?.toFixed(1)} 秒 · 整片与逐镜提示词`
                          : "图片：JPG / PNG / WebP；视频：MP4 / MOV / MKV / WebM"}
                    </small>
                    <div>
                      <button
                        disabled={!editable}
                        onClick={() => void chooseSource()}
                      >
                        <Upload size={16} />
                        {current.source ? "更换原素材" : "上传图片或视频"}
                      </button>
                      <button
                        disabled={!editable}
                        onClick={() => {
                          setSourcePicker(true);
                          setPickerQuery("");
                        }}
                      >
                        从媒体库选择
                      </button>
                    </div>
                    {current.source && (
                      <small>
                        更换原素材会重置该条目的反推结果与迁移版本。
                      </small>
                    )}
                    <button
                      className="primary"
                      disabled={!editable || !current.source}
                      onClick={() => {
                        setProgress("");
                        setReverseOpen(true);
                      }}
                    >
                      <Sparkles size={16} />
                      {reverseRunning
                        ? currentTask?.message || "正在反推…"
                        : current.source
                          ? current.source.kind === "image"
                            ? "反推图片提示词"
                            : "反推原视频提示词"
                          : "反推原素材提示词"}
                    </button>
                  </div>
                </div>
              </section>
            )}
            {mode === "template" && !baseline?.full && (
              <div className="prompt-convert">
                请先导入或填写提示词，或上传原素材完成反推。
                <button onClick={() => setMode("restore")}>
                  返回 1:1 还原
                </button>
              </div>
            )}
            {mode === "template" && baseline?.full && (
              <>
                <div className="prompt-material-area">
                  <div className="prompt-material-heading">
                    <strong>
                      <RefreshCw size={16} />
                      复刻换元素
                    </strong>
                    {(Object.keys(roleLabels) as Role[]).map((role) => (
                      <label key={role}>
                        <input
                          type="checkbox"
                          checked={roles.includes(role)}
                          disabled={!editable}
                          onChange={(event) =>
                            setRoles((previous) =>
                              event.target.checked
                                ? [...previous, role]
                                : previous.filter((value) => value !== role),
                            )
                          }
                        />
                        {roleLabels[role]}
                      </label>
                    ))}
                    <small>可多选 · 素材 {current.materials.length}/9</small>
                    <button
                      disabled={
                        !editable ||
                        !source ||
                        !current.materials.some((material) =>
                          roles.includes(material.role),
                        )
                      }
                      onClick={() => {
                        setInstructions("");
                        setAiDialog("replace");
                      }}
                    >
                      <Sparkles size={15} />
                      {generatingAction === "replace"
                        ? "正在生成…"
                        : "AI 替换生成"}
                    </button>
                  </div>
                  <div className="prompt-material-grid">
                    {(Object.keys(roleLabels) as Role[]).map((role) => (
                      <div
                        className={`prompt-material-card ${roles.includes(role) ? "" : "inactive"}`}
                        key={role}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = editable
                            ? "copy"
                            : "none";
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (!editable) return;
                          const files = Array.from(event.dataTransfer.files);
                          if (
                            !files.length ||
                            files.some(
                              (file) => !/\.(jpe?g|png|webp)$/i.test(file.name),
                            )
                          ) {
                            setError("请拖入 JPG、PNG 或 WebP 图片");
                            return;
                          }
                          const paths = files
                            .map(
                              (file) =>
                                window.desktopBridge?.mediaPathForFile(file) ||
                                "",
                            )
                            .filter(Boolean);
                          if (paths.length !== files.length) {
                            setError(
                              "无法读取拖入图片的本地路径，请使用上传素材",
                            );
                            return;
                          }
                          void add(role, undefined, paths);
                        }}
                      >
                        <strong>
                          {roleLabels[role]}：{roleDescriptions[role]}
                        </strong>
                        <div className="prompt-material-buttons">
                          <button
                            disabled={
                              !editable || current.materials.length >= 9
                            }
                            onClick={() => void add(role)}
                          >
                            <Upload size={20} />
                            上传素材
                          </button>
                          <button
                            disabled={
                              !editable || current.materials.length >= 9
                            }
                            onClick={() => {
                              setPicker(role);
                              setPicked([]);
                              setPickerQuery("");
                            }}
                          >
                            <ImagePlus size={20} />
                            从媒体库选择
                          </button>
                        </div>
                        <div className="prompt-material-thumbs">
                          {current.materials
                            .filter((material) => material.role === role)
                            .map((material) => (
                              <div key={material.id} title={material.name}>
                                {previews[material.id] ? (
                                  <img
                                    src={previews[material.id]}
                                    alt={material.name}
                                    role="button"
                                    tabIndex={0}
                                    title="双击放大查看"
                                    aria-label={`放大查看 ${material.name}`}
                                    onDoubleClick={() => setMaterialLightbox({ name: material.name, url: previews[material.id] })}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        setMaterialLightbox({ name: material.name, url: previews[material.id] });
                                      }
                                    }}
                                  />
                                ) : (
                                  <FileText size={20} />
                                )}
                                <button
                                  disabled={!editable}
                                  onClick={() =>
                                    void run("正在移除素材…", async () => {
                                      const saved = await persist();
                                      adopt(
                                        await bridge().removeMaterial(
                                          saved.id,
                                          saved.revision,
                                          material.id,
                                        ),
                                      );
                                    })
                                  }
                                  aria-label={`移除 ${material.name}`}
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <small>
                    可直接拖入 JPG、PNG、WebP，每张不超过
                    10MB。上传仅绑定参考图，点击「AI
                    替换生成」后替换所选产品、人物和场景。
                  </small>
                </div>
                {current.source?.kind !== "image" && (
                  <div className="prompt-dialogue-strip">
                    <strong>换台词</strong>
                    <button
                      disabled={!editable || !source}
                      onClick={() => {
                        setDialogueDraft(current.dialogue);
                        setDialogueOpen(true);
                      }}
                    >
                      编辑台词
                    </button>
                    <span>
                      提取原提示词台词，改写后 AI 套用，保留镜头与节奏。
                    </span>
                  </div>
                )}
              </>
            )}
            {mode === "template" &&
              !text &&
              source &&
              baseline?.full && (
                <div className="prompt-convert">
                  <span>
                    当前{mode === "template" ? "可迁移模板" : "还原模式"}的
                    {view === "shots" ? "逐镜" : "整片"}版本尚未生成。
                  </span>
                  <button
                    disabled={!editable}
                    onClick={() => {
                      setInstructions("");
                      setAiDialog("convert");
                    }}
                  >
                    <Sparkles size={15} />
                    {generatingAction === "convert"
                      ? "正在生成…"
                      : "生成当前版本"}
                  </button>
                </div>
              )}
            {mode === "restore" && current.reverse && (
              <div className="prompt-reverse-meta">
                原始反推结果 ·{" "}
                {current.reverse.provider === "relay" ? "中转 API" : "火山引擎"}{" "}
                ·{" "}
                {current.reverse.usage
                  ? `Token 输入 ${current.reverse.usage.input ?? "未返回"} / 输出 ${current.reverse.usage.output ?? "未返回"} / 总计 ${current.reverse.usage.total ?? "未返回"}`
                  : "API 未返回 Token 用量"}
              </div>
            )}
            {mode === "restore" && current.reverse?.evidence?.audioStatus === "transcribed" && (
              <p className="prompt-audio-status">原片台词已由本地 Whisper 识别，中文使用简体，英文保留原文。</p>
            )}
            {mode === "restore" && current.reverse?.evidence?.audioStatus === "failed" && (
              <p className="prompt-audio-status" role="status">{current.reverse.evidence.audioError}。当前结果仅有画面证据。</p>
            )}
            {view === "shots" && shotPrompts.length > 0 ? (
              <div className="prompt-shot-list" aria-label="逐镜独立提示词">
                {shotPrompts.map((shot, index) => (
                  <section className="prompt-shot-card" key={index}>
                    <header>
                      <strong>
                        分镜 {index + 1} · {shot.start}–{shot.end} 秒
                      </strong>
                      <button
                        disabled={!!busy}
                        onClick={() =>
                          void run("正在复制…", async () => {
                            await bridge().copy(shot.prompt);
                            notify(`分镜 ${index + 1} 提示词已复制`);
                          })
                        }
                      >
                        <Copy size={15} />
                        复制本镜提示词
                      </button>
                    </header>
                    <textarea
                      aria-label={`分镜 ${index + 1} 提示词`}
                      value={shot.prompt}
                      readOnly={mode === "restore" && !!current.source}
                      disabled={!editable}
                      onChange={(event) => {
                        const next = shotPrompts.map((entry, i) =>
                          i === index
                            ? { ...entry, prompt: event.target.value }
                            : entry,
                        );
                        edit({
                          variants: {
                            ...current.variants,
                            [mode]: {
                              ...current.variants[mode],
                              shots: formatShotPrompts(next),
                            },
                          },
                        });
                      }}
                    />
                  </section>
                ))}
              </div>
            ) : (
              <>
                {view === "shots" && text && (
                  <p className="prompt-legacy-note">
                    这是旧版逐镜文本。重新反推后，将按一个分镜一段完整提示词展示并支持单独复制。
                  </p>
                )}
                <textarea
                  className="prompt-editor"
                  aria-label="提示词正文"
                  placeholder={
                    mode === "restore"
                      ? "上传图片或视频并开始反推，原始提示词结果将在这里展示。"
                      : "基于原提示词进行替换与改写。"
                  }
                  maxLength={100000}
                  disabled={
                    !editable || (mode === "template" && !baseline?.full)
                  }
                  readOnly={mode === "restore" && !!current.source}
                  value={text}
                  onChange={(event) =>
                    edit({
                      variants: {
                        ...current.variants,
                        [mode]: {
                          ...current.variants[mode],
                          [view]: event.target.value,
                        },
                      },
                    })
                  }
                />
              </>
            )}
            <footer className="prompt-detail-footer">
              <span>
                {text.length.toLocaleString()} 字
                {currentTask ? ` · ${currentTask.message}` : busy ? ` · ${busy}` : ""}
              </span>
              <button
                className="prompt-delete"
                disabled={!editable || !current.id}
                onClick={() => setDeleteOpen(true)}
                aria-label="删除提示词"
              >
                <Trash2 size={16} />
              </button>
              <button
                disabled={!editable || !dirty}
                onClick={() =>
                  void run("正在保存…", async () => {
                    await persist();
                    notify("提示词已保存");
                  })
                }
              >
                <Save size={16} />
                保存修改
              </button>
              <button
                disabled={!editable || !text}
                onClick={() =>
                  void run("正在导出…", async () => {
                    if (
                      (
                        await bridge().exportText(
                          `${current.title}-${mode === "template" ? "模板" : "还原"}-${view === "full" ? "整片" : "逐镜"}`,
                          text,
                        )
                      ).ok
                    )
                      notify("提示词已导出");
                  })
                }
              >
                <Download size={16} />
                下载 .txt
              </button>
              <button
                className="primary"
                disabled={!editable || !text}
                onClick={() =>
                  void run("正在复制…", async () => {
                    await bridge().copy(text);
                    notify("已复制当前提示词全文");
                  })
                }
              >
                <Copy size={16} />
                复制全文
              </button>
              {mode === "restore" && (
                <button
                  disabled={!editable || !baseline?.full}
                  onClick={() => void migrate()}
                >
                  转为可迁移模板
                </button>
              )}
            </footer>
          </>
        </section>
      </div>
      {materialLightbox && (
        <div className="prompt-modal-backdrop prompt-image-backdrop" onClick={() => setMaterialLightbox(null)}>
          <section className="prompt-image-dialog" role="dialog" aria-modal="true" aria-label={`素材预览：${materialLightbox.name}`} onClick={event => event.stopPropagation()}>
            <header>
              <span>{materialLightbox.name}</span>
              <button ref={lightboxClose} onClick={() => setMaterialLightbox(null)} aria-label="关闭素材预览"><X size={22} /></button>
            </header>
            <img src={materialLightbox.url} alt={materialLightbox.name} />
          </section>
        </div>
      )}
      {sourcePicker &&
        modal(
          "从媒体库选择原图片或视频",
          <div className="prompt-dialog-content">
            <input
              value={pickerQuery}
              onChange={(event) => setPickerQuery(event.target.value)}
              placeholder="搜索图片或视频名称"
            />
            <div className="prompt-picker-grid">
              {assets
                .filter(
                  (asset) =>
                    ["image", "video"].includes(asset.type) &&
                    asset.localPath &&
                    !asset.deleted &&
                    !asset.broken &&
                    asset.available !== false &&
                    asset.name
                      .toLowerCase()
                      .includes(pickerQuery.toLowerCase()),
                )
                .map((asset) => (
                  <button
                    key={asset.id}
                    disabled={!!busy}
                    onClick={() => void chooseSource(asset.id)}
                  >
                    {asset.type === "image" ? (
                      <img src={asset.src} alt={asset.name} />
                    ) : (
                      <FileText size={28} />
                    )}
                    <span>{asset.name}</span>
                  </button>
                ))}
            </div>
          </div>,
          <button disabled={!!busy} onClick={() => setSourcePicker(false)}>
            关闭
          </button>,
          () => setSourcePicker(false),
        )}
      {reverseOpen &&
        modal(
          "开始原素材反推",
          <div className="prompt-dialog-content">
            <p>
              将原{current.source?.kind === "image" ? "图片" : "视频的抽帧画面"}
              发送给设置中选择的
              {api?.provider === "relay" ? "中转 API" : "火山引擎"}
              视觉模型，按你的账户计费。原素材保存在本地，原始反推结果独立保存。
            </p>
            {current.source?.kind === "video" && (
              <>
                <p>
                  分析全片镜头与动作；原片台词使用本地 Whisper 识别，仅支持中文和英文，中文自动转为简体，英文保留原文。音乐与音效无法通过语音转写确认。长视频可能需要数分钟。
                </p>
                <label>
                  补充原片台词 / 字幕（可选）
                  <textarea
                    value={transcript}
                    disabled={!!busy}
                    maxLength={20000}
                    onChange={(event) => setTranscript(event.target.value)}
                    placeholder="可粘贴带时间的字幕，或原视频实际台词…"
                  />
                </label>
              </>
            )}
            <p role="status">{busy ? progress || busy : ""}</p>
          </div>,
          <>
            <button disabled={!!busy} onClick={() => setReverseOpen(false)}>
              取消
            </button>
            <button
              className="primary"
              disabled={!!busy}
              onClick={() => void reverse()}
            >
              {busy ? "正在反推…" : "开始反推"}
            </button>
          </>,
          () => setReverseOpen(false),
        )}
      {newOpen &&
        modal(
          "新建提示词",
          <div className="prompt-dialog-content">
            <label>
              名称
              <input
                autoFocus
                maxLength={120}
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                placeholder="给提示词起一个名字"
              />
            </label>
            <label>
              原始提示词
              <textarea
                value={newText}
                maxLength={100000}
                onChange={(event) => setNewText(event.target.value)}
                placeholder="粘贴已有提示词，也可以先保存空白条目"
              />
            </label>
          </div>,
          <>
            <button disabled={!!busy} onClick={() => setNewOpen(false)}>
              取消
            </button>
            <button
              className="primary"
              disabled={!!busy || !newTitle.trim()}
              onClick={() =>
                void run("正在创建…", async () => {
                  await persistIfDirty();
                  const variants = blankVariants();
                  variants.restore.full = newText;
                  adopt(
                    await bridge().save({
                      title: newTitle,
                      tags: "",
                      variants,
                      dialogue: "",
                      favorite: false,
                    }),
                  );
                  setMode("restore");
                  setView("full");
                  setNewOpen(false);
                })
              }
            >
              创建
            </button>
          </>,
          () => setNewOpen(false),
        )}
      {picker &&
        modal(
          `从媒体库选择${roleDescriptions[picker]}`,
          <div className="prompt-dialog-content">
            <input
              placeholder="搜索图片名称"
              value={pickerQuery}
              onChange={(event) => setPickerQuery(event.target.value)}
            />
            <p>
              已选 {picked.length} 张，还可添加{" "}
              {9 - (current?.materials.length || 0)} 张
            </p>
            <div className="prompt-picker-grid">
              {assets
                .filter(
                  (asset) =>
                    asset.type === "image" &&
                    asset.localPath &&
                    !asset.deleted &&
                    !asset.broken &&
                    asset.available !== false &&
                    asset.name
                      .toLowerCase()
                      .includes(pickerQuery.toLowerCase()),
                )
                .map((asset) => (
                  <label key={asset.id}>
                    <img src={asset.src} alt={asset.name} />
                    <span>
                      <input
                        type="checkbox"
                        checked={picked.includes(asset.id)}
                        disabled={
                          !!busy ||
                          (!picked.includes(asset.id) &&
                            picked.length >=
                              9 - (current?.materials.length || 0))
                        }
                        onChange={(event) =>
                          setPicked((previous) =>
                            event.target.checked
                              ? [...previous, asset.id]
                              : previous.filter((id) => id !== asset.id),
                          )
                        }
                      />
                      {asset.name}
                    </span>
                  </label>
                ))}
            </div>
            <p>仅显示已入库的本地图片。</p>
          </div>,
          <>
            <button disabled={!!busy} onClick={() => setPicker(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={!!busy || !picked.length}
              onClick={() => void add(picker, picked)}
            >
              添加所选素材
            </button>
          </>,
          () => setPicker(null),
        )}
      {dialogueOpen &&
        modal(
          "编辑台词",
          <div className="prompt-dialog-content">
            <p>可从原提示词提取现有台词，或直接填写新台词。</p>
            <button
              disabled={!!busy}
              onClick={() => {
                setInstructions("");
                void generate("extract-dialogue");
              }}
            >
              <Sparkles size={15} />
              {generatingAction === "extract-dialogue"
                ? "正在生成…"
                : "AI 提取原台词"}
            </button>
            <textarea
              aria-label="新台词"
              maxLength={20000}
              value={dialogueDraft}
              disabled={!!busy}
              onChange={(event) => setDialogueDraft(event.target.value)}
              placeholder="填写新台词，建议保留原台词的时长与节奏…"
            />
          </div>,
          <>
            <button disabled={!!busy} onClick={() => setDialogueOpen(false)}>
              关闭
            </button>
            <button
              disabled={!!busy}
              onClick={() =>
                void run("正在保存台词…", async () => {
                  const saved = await persist();
                  adopt(
                    await bridge().save({ ...saved, dialogue: dialogueDraft }),
                  );
                  setDialogueOpen(false);
                })
              }
            >
              保存台词
            </button>
            <button
              className="primary"
              disabled={!!busy || !dialogueDraft.trim()}
              onClick={() => {
                setInstructions("");
                setDialogueOpen(false);
                setAiDialog("apply-dialogue");
              }}
            >
              AI 套用台词
            </button>
          </>,
          () => setDialogueOpen(false),
        )}
      {aiDialog &&
        modal(
          {
            refine: "AI 精修提示词",
            replace: "AI 替换生成",
            convert: "生成当前提示词版本",
            "extract-dialogue": "提取台词",
            "apply-dialogue": "AI 套用台词",
          }[aiDialog],
          <div className="prompt-dialog-content">
            <p>
              当前设置：{api?.provider === "relay" ? "中转 API" : "火山引擎"}
              。本次会发送原提示词
              {aiDialog === "replace"
                ? "和已选类别的参考图片"
                : aiDialog === "apply-dialogue"
                  ? "及新台词"
                  : ""}
              ，生成结果可预览后采用。
            </p>
            <label>
              补充修改要求（可选）
              <textarea
                value={instructions}
                maxLength={8000}
                disabled={!!busy}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="如：保留原有节奏，强化产品细节与自然光线"
              />
            </label>
          </div>,
          <>
            <button disabled={!!busy} onClick={() => setAiDialog(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={!!busy}
              onClick={() => void generate(aiDialog)}
            >
              {busy || "开始生成"}
            </button>
          </>,
          () => setAiDialog(null),
        )}
      {result &&
        resultOpen &&
        modal(
          "AI 生成结果",
          <div className="prompt-dialog-content">
            <p>
              {result.provider === "relay" ? "中转 API" : "火山引擎"} ·{" "}
              {result.model}
            </p>
            <p>
              {result.usage
                ? `Token：输入 ${result.usage.input ?? "未返回"} / 输出 ${result.usage.output ?? "未返回"} / 总计 ${result.usage.total ?? "未返回"}`
                : "API 未返回 Token 用量"}
            </p>
            <textarea
              aria-label="生成结果"
              value={result.text}
              maxLength={100000}
              onChange={(event) =>
                setResult({ ...result, text: event.target.value })
              }
            />
          </div>,
          <>
            <button
              onClick={() => {
                setResult(null);
                setResultOpen(false);
              }}
            >
              保留原文
            </button>
            <button
              className="primary"
              disabled={!result.text.trim() || !!busy}
              onClick={() => {
                if (current?.id !== result.recordId) return;
                if (result.action === "extract-dialogue") {
                  setDialogueDraft(result.text);
                  setDialogueOpen(true);
                } else {
                  edit({
                    variants: {
                      ...current.variants,
                      [result.mode]: {
                        ...current.variants[result.mode],
                        [result.view]: result.text,
                      },
                    },
                    ...(result.action === "apply-dialogue"
                      ? { dialogue: result.dialogue }
                      : {}),
                  });
                  setMode(result.mode);
                  setView(result.view);
                }
                setResult(null);
                setResultOpen(false);
              }}
            >
              采用结果
            </button>
          </>,
          () => setResultOpen(false),
        )}
      {deleteOpen &&
        modal(
          "删除提示词",
          <div className="prompt-dialog-content">
            <p>确认删除“{current?.title}”？</p>
          </div>,
          <>
            <button disabled={!!busy} onClick={() => setDeleteOpen(false)}>
              取消
            </button>
            <button
              className="danger"
              disabled={!!busy}
              onClick={() =>
                void run("正在删除…", async () => {
                  if (!current) return;
                  await bridge().remove(current.id, current.revision);
                  setItems((previous) =>
                    previous.filter((item) => item.id !== current.id),
                  );
                  setCurrent(emptyDraft());
                  setDirty(false);
                  setDeleteOpen(false);
                })
              }
            >
              确认删除
            </button>
          </>,
          () => setDeleteOpen(false),
        )}
    </section>
  );
}
