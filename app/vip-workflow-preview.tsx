import { FileText, Film, Image as ImageIcon, Play, Upload } from "lucide-react";

// Static layout only: no user records, hooks, IPC, API calls, or usable controls.
export function VipWorkflowPreview({ kind }: { kind: "subtitle" | "prompt" }) {
  if (kind === "subtitle") return <div className="vip-lock-subtitle-preview">
    <div className="vip-lock-preview-toolbar"><span>1 添加视频</span><span>2 设置字幕区域</span><span>3 批量处理</span></div>
    <div className="vip-lock-subtitle-layout">
      <section className="vip-lock-preview-section"><header><strong>1. 添加视频</strong></header>
        <div className="vip-lock-upload"><Upload size={25} /><strong>添加本地视频</strong><span>从媒体库添加 · MP4</span></div>
        {[1, 2, 3, 4].map(index => <div className="vip-lock-video-row" key={index}><Film size={20} /><div><strong>视频素材_{String(index).padStart(2, "0")}.mp4</strong><span>待处理 · 已设置字幕区域</span></div></div>)}
      </section>
      <section className="vip-lock-preview-section"><header><strong>2. 框选字幕区域</strong></header>
        <div className="vip-lock-region-preview"><Play size={36} /><div>字幕区域</div></div>
        <div className="vip-lock-preview-toolbar"><span>重新框选</span><span>使用底部区域</span><span>应用到全部</span></div>
      </section>
      <section className="vip-lock-preview-section"><header><strong>3. 批量处理</strong></header>
        <div className="vip-lock-output"><strong>成片保存到</strong><span>本地视频文件夹</span><span>完成后自动同步到媒体库</span><em>开始批量去字幕</em></div>
        <header><strong>历史记录</strong></header>
        {[1, 2, 3].map(index => <div className="vip-lock-video-row" key={index}><Film size={18} /><div><strong>处理结果_{index}</strong><span>成片已保存</span></div></div>)}
      </section>
    </div>
  </div>;
  return <div className="vip-lock-prompt-preview">
    <div className="vip-lock-preview-toolbar"><span className="search">搜索提示词</span><span>全部提示词</span><i>新建提示词</i></div>
    <div className="vip-lock-prompt-layout">
      <section className="vip-lock-preview-section"><header><strong>提示词库</strong></header>
        {["产品展示", "场景演示", "镜头拆解", "素材替换", "可迁移模板"].map((title, index) => <div className="vip-lock-video-row" key={title}><FileText size={20} /><div><strong>{title}</strong><span>提示词模板 {index + 1}</span></div></div>)}
      </section>
      <section className="vip-lock-preview-section">
        <div className="vip-lock-preview-toolbar"><span>1:1 还原</span><span>可迁移模板</span><span>整片提示词</span><span>逐镜提示词</span></div>
        <div className="vip-lock-prompt-source"><ImageIcon size={30} /><strong>原素材反推提示词</strong><span>上传图片或视频 · 从媒体库选择</span></div>
        <div className="vip-lock-prompt-editor"><strong>提示词正文</strong>{Array.from({ length: 12 }, (_, index) => <span key={index} style={{ width: `${index % 3 === 2 ? 62 : 92}%` }} />)}</div>
        <div className="vip-lock-preview-toolbar"><span>保存修改</span><span>下载 .txt</span><span>复制全文</span><i>反推原素材提示词</i></div>
      </section>
    </div>
  </div>;
}
