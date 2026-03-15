import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic,
  MonitorSpeaker,
  Play,
  Pause,
  Square,
  Download,
  Settings,
  FileText,
  Sparkles,
  NotebookPen,
  CheckCircle2,
  AlertCircle,
  Clock3,
  AudioLines,
  Bot,
  Save,
  Trash2,
  Copy,
} from "lucide-react";

/**
 * 说明：
 * 1) 这是一个“可运行的前端 MVP 原型”，重点在工作流与信息结构。
 * 2) 浏览器环境下：
 *    - 麦克风采集：可行
 *    - 屏幕/标签页音频采集：可通过 getDisplayMedia(audio:true) 尝试
 *    - 真正稳定的“系统内部音频 + 外部音频混合 + 高质量转写”更适合 Electron / 桌面端实现
 * 3) 转写：
 *    - 优先尝试浏览器 SpeechRecognition（若可用）
 *    - 不可用时退化为“原型模式”，仍可完整跑通流程、记笔记、生成报告
 * 4) AI总结：
 *    - 支持 OpenAI 风格接口调用
 *    - 需要用户填写 Base URL / API Key / Model
 */

const STORAGE_KEY = "meeting_transcription_mvp_v1";
const MODEL_KEY = "meeting_transcription_model_config_v1";

const templates = {
  concise: {
    label: "简洁纪要",
    prompt: `你是一个专业会议纪要助手。请基于转写内容输出简洁会议纪要，包含：\n1. 会议主题概述\n2. 核心讨论内容\n3. 关键结论\n4. 待办事项\n5. 风险点/未决问题\n6. 下一步建议\n要求：语言简洁、条理清晰、避免冗余。`,
  },
  action: {
    label: "待办导向",
    prompt: `你是一个擅长提取行动项的会议助理。请基于转写内容重点输出：\n1. 会议目标\n2. 已达成共识\n3. Action Items（事项/负责人/截止时间，若无法识别则标记“待确认”）\n4. 风险点\n5. 下一步推进建议\n要求：偏执行导向。`,
  },
  detailed: {
    label: "详细会议纪要",
    prompt: `你是一个正式会议纪要撰写助手。请基于转写内容输出详细纪要，包含：\n1. 会议主题\n2. 参会内容概览\n3. 分议题讨论过程\n4. 关键结论\n5. 行动项\n6. 风险点/未决问题\n7. 后续建议\n要求：结构完整、表述专业。`,
  },
};

const initialSession = {
  title: "未命名会议",
  audioSource: "mic", // mic | system | mixed
  startedAt: null,
  endedAt: null,
  isRunning: false,
  isPaused: false,
  transcriptSegments: [],
  notes: [],
  aiSummary: "",
  aiTemplate: "concise",
  providerConnected: false,
};

function formatTime(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

function formatDuration(start, end) {
  if (!start) return "00:00";
  const ms = (end || Date.now()) - start;
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function downloadFile(filename, content, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function segmentToText(segment) {
  const speaker = segment.speaker ? `[${segment.speaker}] ` : "";
  return `${segment.time} ${speaker}${segment.text}`;
}

function buildTranscriptReport(session) {
  return `# 转写报告\n\n` +
    `- 会议标题：${session.title}\n` +
    `- 开始时间：${formatTime(session.startedAt)}\n` +
    `- 结束时间：${formatTime(session.endedAt)}\n` +
    `- 总时长：${formatDuration(session.startedAt, session.endedAt)}\n` +
    `- 音频来源：${audioSourceLabel(session.audioSource)}\n\n` +
    `## 逐段转写\n\n` +
    (session.transcriptSegments.length
      ? session.transcriptSegments.map((s) => `- ${segmentToText(s)}`).join("\n")
      : "暂无转写内容") +
    `\n\n## 个人笔记\n\n` +
    (session.notes.length
      ? session.notes.map((n) => `- [${n.time}] ${n.text}`).join("\n")
      : "暂无个人笔记");
}

function buildSummaryReport(session) {
  return `# AI 总结报告\n\n` +
    `- 会议标题：${session.title}\n` +
    `- 模板：${templates[session.aiTemplate]?.label || "-"}\n\n` +
    (session.aiSummary || "暂无 AI 总结内容");
}

function audioSourceLabel(v) {
  if (v === "mic") return "仅麦克风外部音频";
  if (v === "system") return "仅电脑内部音频";
  if (v === "mixed") return "内部音频 + 外部音频混合";
  return v;
}

function statusPill(color, text) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        borderRadius: 999,
        padding: "6px 10px",
        fontSize: 12,
        border: `1px solid ${color}`,
        background: `${color}12`,
        color,
      }}
    >
      <span
        style={{ width: 8, height: 8, borderRadius: 999, background: color, display: "inline-block" }}
      />
      {text}
    </span>
  );
}

function App() {
  const [session, setSession] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : initialSession;
  });
  const [modelConfig, setModelConfig] = useState(() => {
    const saved = localStorage.getItem(MODEL_KEY);
    return saved
      ? JSON.parse(saved)
      : { baseUrl: "", apiKey: "", model: "", systemPrompt: "" };
  });
  const [newNote, setNewNote] = useState("");
  const [connectState, setConnectState] = useState({ loading: false, ok: false, msg: "未校验" });
  const [summaryState, setSummaryState] = useState({ loading: false, msg: "" });
  const [captureState, setCaptureState] = useState({ mic: false, system: false, mode: "未开始" });
  const [speechSupported, setSpeechSupported] = useState(false);
  const [liveDraft, setLiveDraft] = useState("");

  const recognitionRef = useRef(null);
  const timerRef = useRef(null);
  const segmentIdRef = useRef(1);
  const noteIdRef = useRef(1);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }, [session]);

  useEffect(() => {
    localStorage.setItem(MODEL_KEY, JSON.stringify(modelConfig));
  }, [modelConfig]);

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    setSpeechSupported(Boolean(SR));
  }, []);

  useEffect(() => {
    if (session.isRunning && !session.isPaused) {
      timerRef.current = setInterval(() => {
        setSession((prev) => ({ ...prev }));
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    return () => timerRef.current && clearInterval(timerRef.current);
  }, [session.isRunning, session.isPaused]);

  const transcriptText = useMemo(
    () => session.transcriptSegments.map(segmentToText).join("\n"),
    [session.transcriptSegments]
  );

  const pushSegment = (text, final = true) => {
    if (!text?.trim()) return;
    const time = new Date().toLocaleTimeString();
    if (!final) {
      setLiveDraft(text);
      return;
    }
    setLiveDraft("");
    setSession((prev) => ({
      ...prev,
      transcriptSegments: [
        ...prev.transcriptSegments,
        {
          id: segmentIdRef.current++,
          time,
          speaker: "说话人1",
          text: text.trim(),
        },
      ],
    }));
  };

  const startSpeechRecognition = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const recognition = new SR();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = "";
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += text;
        else interim += text;
      }
      if (interim) pushSegment(interim, false);
      if (finalText) pushSegment(finalText, true);
    };

    recognition.onerror = () => {
      setCaptureState((prev) => ({ ...prev, mode: "转写异常，已退回原型模式" }));
    };

    recognition.onend = () => {
      if (session.isRunning && !session.isPaused) {
        try {
          recognition.start();
        } catch {
          // noop
        }
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  };

  const stopSpeechRecognition = () => {
    try {
      recognitionRef.current?.stop?.();
    } catch {
      // noop
    }
  };

  const handleStart = async () => {
    const startedAt = Date.now();
    setSession((prev) => ({
      ...prev,
      startedAt,
      endedAt: null,
      isRunning: true,
      isPaused: false,
      aiSummary: "",
    }));

    // 原型层的设备状态展示
    let mic = false;
    let system = false;

    if (session.audioSource === "mic" || session.audioSource === "mixed") {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        mic = true;
      } catch {
        mic = false;
      }
    }

    if (session.audioSource === "system" || session.audioSource === "mixed") {
      try {
        await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        system = true;
      } catch {
        system = false;
      }
    }

    setCaptureState({
      mic,
      system,
      mode: speechSupported ? "实时转写中" : "原型模式运行中（当前浏览器未启用 SpeechRecognition）",
    });

    if (speechSupported) startSpeechRecognition();
  };

  const handlePause = () => {
    setSession((prev) => ({ ...prev, isPaused: true }));
    stopSpeechRecognition();
    setCaptureState((prev) => ({ ...prev, mode: "已暂停" }));
  };

  const handleResume = () => {
    setSession((prev) => ({ ...prev, isPaused: false }));
    if (speechSupported) startSpeechRecognition();
    setCaptureState((prev) => ({ ...prev, mode: "实时转写中" }));
  };

  const handleStop = () => {
    stopSpeechRecognition();
    setSession((prev) => ({ ...prev, isRunning: false, isPaused: false, endedAt: Date.now() }));
    setCaptureState((prev) => ({ ...prev, mode: "已结束" }));
  };

  const addNote = () => {
    if (!newNote.trim()) return;
    setSession((prev) => ({
      ...prev,
      notes: [
        ...prev.notes,
        {
          id: noteIdRef.current++,
          time: new Date().toLocaleTimeString(),
          text: newNote.trim(),
        },
      ],
    }));
    setNewNote("");
  };

  const clearAll = () => {
    stopSpeechRecognition();
    localStorage.removeItem(STORAGE_KEY);
    setSession(initialSession);
    setLiveDraft("");
    setCaptureState({ mic: false, system: false, mode: "未开始" });
  };

  const testConnection = async () => {
    setConnectState({ loading: true, ok: false, msg: "校验中..." });
    try {
      if (!modelConfig.baseUrl || !modelConfig.apiKey || !modelConfig.model) {
        throw new Error("请先填写 Base URL / API Key / Model");
      }
      const url = `${modelConfig.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${modelConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: modelConfig.model,
          messages: [{ role: "user", content: "Reply with OK only." }],
          temperature: 0,
          max_tokens: 8,
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      setConnectState({ loading: false, ok: true, msg: "连通性校验成功" });
      setSession((prev) => ({ ...prev, providerConnected: true }));
    } catch (e) {
      setConnectState({ loading: false, ok: false, msg: `校验失败：${e.message}` });
      setSession((prev) => ({ ...prev, providerConnected: false }));
    }
  };

  const generateSummary = async () => {
    setSummaryState({ loading: true, msg: "生成中..." });
    try {
      if (!transcriptText.trim()) throw new Error("暂无可用于总结的转写内容");
      if (!modelConfig.baseUrl || !modelConfig.apiKey || !modelConfig.model) {
        throw new Error("请先配置模型参数");
      }
      const prompt = `${templates[session.aiTemplate].prompt}\n\n会议转写内容如下：\n${transcriptText}`;
      const url = `${modelConfig.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${modelConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: modelConfig.model,
          messages: [
            { role: "system", content: modelConfig.systemPrompt || "你是一个专业会议总结助手。" },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || "未返回总结内容";
      setSession((prev) => ({ ...prev, aiSummary: content }));
      setSummaryState({ loading: false, msg: "生成完成" });
    } catch (e) {
      setSummaryState({ loading: false, msg: `生成失败：${e.message}` });
    }
  };

  const theme = {
    bg: "#f6f8fc",
    panel: "rgba(255,255,255,0.82)",
    border: "rgba(15,23,42,0.08)",
    text: "#0f172a",
    sub: "#475569",
    shadow: "0 10px 40px rgba(15,23,42,0.08)",
    primary: "#0f172a",
    primaryText: "#ffffff",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: theme.bg,
        color: theme.text,
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div style={{ width: "min(1440px, calc(100% - 32px))", margin: "0 auto", padding: "20px 0 32px" }}>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            marginBottom: 20,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 12px",
                borderRadius: 999,
                fontSize: 12,
                background: "rgba(14,165,233,0.08)",
                border: "1px solid rgba(14,165,233,0.14)",
                color: "#0369a1",
              }}
            >
              <Sparkles size={14} /> 实时会议转写与总结助手 MVP
            </div>
            <h1 style={{ margin: "14px 0 8px", fontSize: "clamp(28px, 4vw, 42px)", lineHeight: 1.15 }}>
              实时转写 · 笔记 · 双报告输出
            </h1>
            <p style={{ margin: 0, color: theme.sub, lineHeight: 1.8 }}>
              面向会议、课堂、访谈、线上通话的信息记录工具。当前版本重点验证核心 workflow：音频配置 → 实时转写 → 自动保存 → AI 总结 → 报告导出。
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {session.isRunning && !session.isPaused && statusPill("#16a34a", "转写中")}
            {session.isRunning && session.isPaused && statusPill("#d97706", "已暂停")}
            {!session.isRunning && statusPill("#64748b", "空闲")}
          </div>
        </header>

        <div className="grid-root" style={{ display: "grid", gridTemplateColumns: "360px 1fr 360px", gap: 18 }}>
          <Panel title="会话配置" icon={<Settings size={18} />}>
            <Field label="会议标题">
              <input
                value={session.title}
                onChange={(e) => setSession((prev) => ({ ...prev, title: e.target.value }))}
                style={inputStyle}
                placeholder="例如：项目周会 / 课程讨论 / 访谈记录"
              />
            </Field>

            <Field label="音频来源">
              <div style={{ display: "grid", gap: 10 }}>
                {[
                  { key: "mic", label: "仅麦克风外部音频", icon: <Mic size={16} /> },
                  { key: "system", label: "仅电脑内部音频", icon: <MonitorSpeaker size={16} /> },
                  { key: "mixed", label: "内部音频 + 外部音频混合", icon: <AudioLines size={16} /> },
                ].map((item) => (
                  <button
                    key={item.key}
                    onClick={() => setSession((prev) => ({ ...prev, audioSource: item.key }))}
                    style={{
                      ...selectorStyle,
                      borderColor: session.audioSource === item.key ? "#0f172a" : "rgba(15,23,42,0.08)",
                      background: session.audioSource === item.key ? "rgba(15,23,42,0.05)" : "#fff",
                    }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {item.icon} {item.label}
                    </span>
                  </button>
                ))}
              </div>
            </Field>

            <Field label="当前采集状态">
              <div style={{ display: "grid", gap: 8 }}>
                <InfoRow label="模式" value={captureState.mode} />
                <InfoRow label="麦克风" value={captureState.mic ? "已连接" : "未连接 / 未启用"} />
                <InfoRow label="系统音频" value={captureState.system ? "已连接" : "未连接 / 未启用"} />
                <InfoRow label="浏览器识别" value={speechSupported ? "SpeechRecognition 可用" : "当前浏览器不可用"} />
              </div>
            </Field>

            <Field label="控制区">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
                <ActionButton disabled={session.isRunning} onClick={handleStart} icon={<Play size={16} />}>
                  开始
                </ActionButton>
                <ActionButton disabled={!session.isRunning || session.isPaused} onClick={handlePause} icon={<Pause size={16} />}>
                  暂停
                </ActionButton>
                <ActionButton disabled={!session.isRunning || !session.isPaused} onClick={handleResume} icon={<Play size={16} />}>
                  继续
                </ActionButton>
              </div>
              <div style={{ marginTop: 10 }}>
                <ActionButton
                  full
                  danger
                  disabled={!session.isRunning}
                  onClick={handleStop}
                  icon={<Square size={16} />}
                >
                  结束转写
                </ActionButton>
              </div>
            </Field>

            <Field label="会话信息">
              <div style={{ display: "grid", gap: 8 }}>
                <InfoRow label="开始时间" value={formatTime(session.startedAt)} />
                <InfoRow label="结束时间" value={formatTime(session.endedAt)} />
                <InfoRow label="总时长" value={formatDuration(session.startedAt, session.endedAt)} />
                <InfoRow label="音频来源" value={audioSourceLabel(session.audioSource)} />
              </div>
            </Field>

            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <ActionButton full subtle onClick={clearAll} icon={<Trash2 size={16} />}>
                清空会话
              </ActionButton>
            </div>
          </Panel>

          <div style={{ display: "grid", gap: 18 }}>
            <Panel title="实时转写" icon={<FileText size={18} />}>
              <div
                style={{
                  minHeight: 360,
                  maxHeight: 460,
                  overflow: "auto",
                  borderRadius: 18,
                  border: `1px solid ${theme.border}`,
                  background: "rgba(255,255,255,0.68)",
                  padding: 14,
                }}
              >
                {session.transcriptSegments.length === 0 && !liveDraft && (
                  <EmptyState
                    title="暂无转写内容"
                    desc="开始会议后，转写结果会按时间顺序显示在这里。"
                  />
                )}

                {session.transcriptSegments.map((seg) => (
                  <div key={seg.id} style={segmentStyle}>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                      <span style={tinyPill("#334155", seg.time)} />
                      <span style={tinyPill("#0369a1", seg.speaker || "说话人") } />
                    </div>
                    <div style={{ lineHeight: 1.85, color: theme.text }}>{seg.text}</div>
                  </div>
                ))}

                {liveDraft && (
                  <motion.div initial={{ opacity: 0.5 }} animate={{ opacity: 1 }} style={{ ...segmentStyle, borderStyle: "dashed" }}>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                      <span style={tinyPill("#d97706", "实时草稿") } />
                    </div>
                    <div style={{ lineHeight: 1.85, color: theme.sub }}>{liveDraft}</div>
                  </motion.div>
                )}
              </div>
            </Panel>

            <Panel title="实时个人笔记" icon={<NotebookPen size={18} />}>
              <div style={{ display: "grid", gap: 12 }}>
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  rows={4}
                  style={{ ...inputStyle, resize: "vertical", minHeight: 100 }}
                  placeholder="记录你的想法、重点、疑问。保存后会自动绑定当前时间点。"
                />
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <ActionButton onClick={addNote} icon={<Save size={16} />}>保存笔记</ActionButton>
                </div>
              </div>

              <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
                {session.notes.length === 0 ? (
                  <EmptyState title="暂无个人笔记" desc="会议过程中可随时记录个人想法，笔记不会污染原始转写。" />
                ) : (
                  session.notes.map((note) => (
                    <div key={note.id} style={segmentStyle}>
                      <div style={{ marginBottom: 6 }}>{tinyPill("#7c3aed", note.time)}</div>
                      <div style={{ lineHeight: 1.8 }}>{note.text}</div>
                    </div>
                  ))
                )}
              </div>
            </Panel>
          </div>

          <div style={{ display: "grid", gap: 18 }}>
            <Panel title="大模型配置" icon={<Bot size={18} />}>
              <Field label="Base URL">
                <input
                  value={modelConfig.baseUrl}
                  onChange={(e) => setModelConfig((prev) => ({ ...prev, baseUrl: e.target.value }))}
                  style={inputStyle}
                  placeholder="例如：https://api.openai.com/v1"
                />
              </Field>
              <Field label="API Key">
                <input
                  type="password"
                  value={modelConfig.apiKey}
                  onChange={(e) => setModelConfig((prev) => ({ ...prev, apiKey: e.target.value }))}
                  style={inputStyle}
                  placeholder="输入你的 API Key"
                />
              </Field>
              <Field label="模型名称">
                <input
                  value={modelConfig.model}
                  onChange={(e) => setModelConfig((prev) => ({ ...prev, model: e.target.value }))}
                  style={inputStyle}
                  placeholder="例如：gpt-4o-mini / deepseek-chat"
                />
              </Field>
              <Field label="系统提示词（可选）">
                <textarea
                  rows={3}
                  value={modelConfig.systemPrompt}
                  onChange={(e) => setModelConfig((prev) => ({ ...prev, systemPrompt: e.target.value }))}
                  style={{ ...inputStyle, resize: "vertical" }}
                  placeholder="例如：你是一个专业会议总结助手。"
                />
              </Field>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <ActionButton onClick={testConnection} icon={<CheckCircle2 size={16} />}>
                  {connectState.loading ? "校验中..." : "连通性校验"}
                </ActionButton>
              </div>
              <div style={{ marginTop: 12, color: connectState.ok ? "#15803d" : "#64748b", fontSize: 13, lineHeight: 1.7 }}>
                {connectState.msg}
              </div>
            </Panel>

            <Panel title="AI 总结" icon={<Sparkles size={18} />}>
              <Field label="总结模板">
                <select
                  value={session.aiTemplate}
                  onChange={(e) => setSession((prev) => ({ ...prev, aiTemplate: e.target.value }))}
                  style={inputStyle}
                >
                  {Object.entries(templates).map(([key, item]) => (
                    <option key={key} value={key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </Field>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                <ActionButton onClick={generateSummary} icon={<Sparkles size={16} />}>
                  {summaryState.loading ? "生成中..." : "生成 AI 总结"}
                </ActionButton>
                <ActionButton
                  subtle
                  onClick={() => navigator.clipboard.writeText(session.aiSummary || "")}
                  icon={<Copy size={16} />}
                >
                  复制总结
                </ActionButton>
              </div>

              <div
                style={{
                  minHeight: 220,
                  maxHeight: 320,
                  overflow: "auto",
                  borderRadius: 18,
                  border: `1px solid ${theme.border}`,
                  background: "rgba(255,255,255,0.68)",
                  padding: 14,
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.85,
                }}
              >
                {session.aiSummary || "尚未生成 AI 总结。"}
              </div>
              <div style={{ marginTop: 10, fontSize: 13, color: theme.sub }}>{summaryState.msg}</div>
            </Panel>

            <Panel title="报告导出" icon={<Download size={18} />}>
              <div style={{ display: "grid", gap: 10 }}>
                <ActionButton
                  full
                  onClick={() => downloadFile(`${session.title || "meeting"}_transcript.txt`, transcriptText || "暂无转写")}
                  icon={<Download size={16} />}
                >
                  导出转写 TXT
                </ActionButton>
                <ActionButton
                  full
                  subtle
                  onClick={() =>
                    downloadFile(
                      `${session.title || "meeting"}_transcript.md`,
                      buildTranscriptReport(session),
                      "text/markdown;charset=utf-8"
                    )
                  }
                  icon={<Download size={16} />}
                >
                  导出转写 Markdown
                </ActionButton>
                <ActionButton
                  full
                  subtle
                  onClick={() =>
                    downloadFile(
                      `${session.title || "meeting"}_summary.md`,
                      buildSummaryReport(session),
                      "text/markdown;charset=utf-8"
                    )
                  }
                  icon={<Download size={16} />}
                >
                  导出 AI 总结 Markdown
                </ActionButton>
              </div>
            </Panel>
          </div>
        </div>
      </div>

      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; }
        @media (max-width: 1200px) {
          .grid-root { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

function Panel({ title, icon, children }) {
  return (
    <section
      style={{
        borderRadius: 28,
        border: "1px solid rgba(15,23,42,0.08)",
        background: "rgba(255,255,255,0.82)",
        boxShadow: "0 10px 40px rgba(15,23,42,0.08)",
        padding: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 14,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#0f172a",
            color: "#fff",
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div style={{ fontWeight: 700, fontSize: 18 }}>{title}</div>
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ marginBottom: 8, fontSize: 13, color: "#475569", fontWeight: 600 }}>{label}</div>
      {children}
    </div>
  );
}

function ActionButton({ children, onClick, icon, full = false, subtle = false, danger = false, disabled = false }) {
  const bg = danger ? "#dc2626" : subtle ? "#ffffff" : "#0f172a";
  const color = danger ? "#ffffff" : subtle ? "#0f172a" : "#ffffff";
  const border = subtle ? "1px solid rgba(15,23,42,0.08)" : "1px solid transparent";
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        width: full ? "100%" : "auto",
        borderRadius: 16,
        border,
        background: disabled ? "#cbd5e1" : bg,
        color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        minHeight: 44,
        padding: "0 16px",
        cursor: disabled ? "not-allowed" : "pointer",
        fontWeight: 600,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

function InfoRow({ label, value }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        borderRadius: 14,
        background: "rgba(255,255,255,0.66)",
        border: "1px solid rgba(15,23,42,0.06)",
        padding: "10px 12px",
        fontSize: 14,
      }}
    >
      <span style={{ color: "#475569" }}>{label}</span>
      <span style={{ color: "#0f172a", fontWeight: 600, textAlign: "right" }}>{value}</span>
    </div>
  );
}

function EmptyState({ title, desc }) {
  return (
    <div style={{ padding: "40px 16px", textAlign: "center" }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>{title}</div>
      <div style={{ color: "#64748b", lineHeight: 1.8, fontSize: 14 }}>{desc}</div>
    </div>
  );
}

const inputStyle = {
  width: "100%",
  borderRadius: 14,
  border: "1px solid rgba(15,23,42,0.08)",
  background: "#fff",
  minHeight: 44,
  padding: "10px 12px",
  fontSize: 14,
  color: "#0f172a",
  outline: "none",
};

const selectorStyle = {
  width: "100%",
  minHeight: 46,
  borderRadius: 14,
  border: "1px solid rgba(15,23,42,0.08)",
  background: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 12px",
  cursor: "pointer",
  color: "#0f172a",
};

const segmentStyle = {
  borderRadius: 16,
  border: "1px solid rgba(15,23,42,0.08)",
  background: "#fff",
  padding: 12,
  marginBottom: 10,
};

function tinyPill(color, text) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 999,
        padding: "4px 8px",
        fontSize: 12,
        background: `${color}12`,
        border: `1px solid ${color}22`,
        color,
      }}
    >
      {text}
    </span>
  );
}

export default App;
