import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
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
  AudioLines,
  Bot,
  Save,
  Trash2,
  Copy,
} from "lucide-react";

const STORAGE_KEY = "meeting_transcription_mvp_v2";
const MODEL_KEY = "meeting_transcription_model_config_v1";

const templates = {
  concise: {
    label: "简洁纪要",
    prompt: `你是一个专业会议纪要助手。请基于转写内容输出简洁会议纪要，包含：
1. 会议主题概述
2. 核心讨论内容
3. 关键结论
4. 待办事项
5. 风险点/未决问题
6. 下一步建议
要求：语言简洁、条理清晰、避免冗余。`,
  },
  action: {
    label: "待办导向",
    prompt: `你是一个擅长提取行动项的会议助理。请基于转写内容重点输出：
1. 会议目标
2. 已达成共识
3. Action Items（事项/负责人/截止时间，若无法识别则标记“待确认”）
4. 风险点
5. 下一步推进建议
要求：偏执行导向。`,
  },
  detailed: {
    label: "详细会议纪要",
    prompt: `你是一个正式会议纪要撰写助手。请基于转写内容输出详细纪要，包含：
1. 会议主题
2. 参会内容概览
3. 分议题讨论过程
4. 关键结论
5. 行动项
6. 风险点/未决问题
7. 后续建议
要求：结构完整、表述专业。`,
  },
};

const initialSession = {
  title: "未命名会议",
  audioSource: "mic", // mic | system | mixed
  language: "zh", // zh | en
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
  return (
    `# 转写报告\n\n` +
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
      : "暂无个人笔记")
  );
}

function buildSummaryReport(session) {
  return (
    `# AI 总结报告\n\n` +
    `- 会议标题：${session.title}\n` +
    `- 模板：${templates[session.aiTemplate]?.label || "-"}\n\n` +
    (session.aiSummary || "暂无 AI 总结内容")
  );
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
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: color,
          display: "inline-block",
        }}
      />
      {text}
    </span>
  );
}

function App() {
  const [session, setSession] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return initialSession;
    try {
      const parsed = JSON.parse(saved);
      // 页面刷新后，如果上一次还在“录音中”，强制重置为已结束的空闲状态，避免残留状态混乱
      if (parsed.isRunning) {
        parsed.isRunning = false;
        parsed.isPaused = false;
        parsed.endedAt = parsed.endedAt || null;
      }
      return { ...initialSession, ...parsed };
    } catch {
      return initialSession;
    }
  });

  const [modelConfig, setModelConfig] = useState(() => {
    const saved = localStorage.getItem(MODEL_KEY);
    return saved
      ? JSON.parse(saved)
      : { baseUrl: "", apiKey: "", model: "", systemPrompt: "" };
  });

  const [newNote, setNewNote] = useState("");
  const [connectState, setConnectState] = useState({
    loading: false,
    ok: false,
    msg: "未校验",
  });
  const [summaryState, setSummaryState] = useState({
    loading: false,
    msg: "",
  });
  const [captureState, setCaptureState] = useState({
    mic: false,
    system: false,
    mode: "未开始",
  });
  const [liveDraft, setLiveDraft] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const timerRef = useRef(null);
  const segmentIdRef = useRef(1);
  const noteIdRef = useRef(1);

  const micStreamRef = useRef(null);
  const systemStreamRef = useRef(null);
  const mixedAudioContextRef = useRef(null);
  const mixedDestinationRef = useRef(null);
  // 使用 WebAudio 抓取 PCM 并按时间切片打包 WAV，避免 MediaRecorder/webm 分片无法被后端解码的问题
  const captureAudioContextRef = useRef(null);
  const captureSourceRef = useRef(null);
  const captureProcessorRef = useRef(null);
  const captureBufferRef = useRef([]); // Float32Array chunks
  const captureSampleRateRef = useRef(48000);
  const captureFlushTimerRef = useRef(null);
  const pausedRef = useRef(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }, [session]);

  useEffect(() => {
    localStorage.setItem(MODEL_KEY, JSON.stringify(modelConfig));
  }, [modelConfig]);

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

  const pushSegment = (text) => {
    if (!text?.trim()) return;
    const time = new Date().toLocaleTimeString();
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

  const stopAllTracks = () => {
    try {
      micStreamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch {}
    try {
      systemStreamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch {}
    try {
      mixedAudioContextRef.current?.close?.();
    } catch {}
    try {
      captureProcessorRef.current?.disconnect?.();
    } catch {}
    try {
      captureSourceRef.current?.disconnect?.();
    } catch {}
    try {
      captureAudioContextRef.current?.close?.();
    } catch {}
    try {
      if (captureFlushTimerRef.current) clearInterval(captureFlushTimerRef.current);
    } catch {}

    micStreamRef.current = null;
    systemStreamRef.current = null;
    mixedAudioContextRef.current = null;
    mixedDestinationRef.current = null;
    captureAudioContextRef.current = null;
    captureSourceRef.current = null;
    captureProcessorRef.current = null;
    captureBufferRef.current = [];
    pausedRef.current = false;
  };

  const downsampleBuffer = (buffer, inputSampleRate, outputSampleRate) => {
    if (outputSampleRate === inputSampleRate) return buffer;
    const sampleRateRatio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      // 简单平均降采样
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  };

  const floatTo16BitPCM = (output, offset, input) => {
    for (let i = 0; i < input.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, input[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      output.setInt16(offset, s, true);
    }
  };

  const writeString = (view, offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  const encodeWAV = (samples, sampleRate) => {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true); // PCM
    view.setUint16(20, 1, true); // linear PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate (sampleRate * blockAlign)
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeString(view, 36, "data");
    view.setUint32(40, samples.length * 2, true);

    floatTo16BitPCM(view, 44, samples);
    return new Blob([view], { type: "audio/wav" });
  };

  const buildMixedStream = async () => {
    let mic = false;
    let system = false;

    let micStream = null;
    let systemStream = null;

    if (session.audioSource === "mic" || session.audioSource === "mixed") {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic = true;
      micStreamRef.current = micStream;
    }

    if (session.audioSource === "system" || session.audioSource === "mixed") {
      systemStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      system = true;
      systemStreamRef.current = systemStream;
    }

    if (session.audioSource === "mic" && micStream) {
      setCaptureState({
        mic: true,
        system: false,
        mode: "录音中（麦克风）",
      });
      return micStream;
    }

    if (session.audioSource === "system" && systemStream) {
      setCaptureState({
        mic: false,
        system: true,
        mode: "录音中（系统音频）",
      });

      const onlyAudioTracks = systemStream.getAudioTracks();
      if (!onlyAudioTracks.length) {
        throw new Error("未捕获到系统音频，请确认共享时勾选了系统音频");
      }
      return new MediaStream(onlyAudioTracks);
    }

    if (session.audioSource === "mixed" && micStream && systemStream) {
      const audioContext = new AudioContext();
      mixedAudioContextRef.current = audioContext;

      const destination = audioContext.createMediaStreamDestination();
      mixedDestinationRef.current = destination;

      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(destination);

      const systemAudioTracks = systemStream.getAudioTracks();
      if (!systemAudioTracks.length) {
        throw new Error("未捕获到系统音频，请确认共享时勾选了系统音频");
      }

      const systemOnlyStream = new MediaStream(systemAudioTracks);
      const systemSource = audioContext.createMediaStreamSource(systemOnlyStream);
      systemSource.connect(destination);

      setCaptureState({
        mic: true,
        system: true,
        mode: "录音中（混合音频）",
      });

      return destination.stream;
    }

    throw new Error("音频流初始化失败，请检查设备权限或输入源设置");
  };

  /**
   * 将单个音频片段发送到后端进行转写，用于“准实时”分段转写。
   * @param {Blob} chunkBlob - 单次录制得到的音频片段（WAV）
   */
  const sendChunkToBackend = async (chunkBlob) => {
    try {
      if (!chunkBlob || !chunkBlob.size) return;

      setLiveDraft("正在上传当前音频片段并调用 Whisper 转写...");

      const formData = new FormData();
      formData.append("file", chunkBlob, "meeting_chunk.wav");
      formData.append("language", session.language || "zh");

      const res = await fetch("http://127.0.0.1:8000/transcribe", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`后端转写失败：${res.status} ${text}`);
      }

      const data = await res.json();
      setLiveDraft("");

      if (!data?.text?.trim()) {
        // 不插入无效文本，保持时间线整洁
        return;
      }

      pushSegment(data.text);
    } catch (err) {
      console.error("sendChunkToBackend error:", err);
      setLiveDraft("");
      setErrorMsg(err.message || "音频片段转写失败");
    }
  };

  const handleStart = async () => {
    setErrorMsg("");
    setLiveDraft("");

    // 如果当前不是在进行中的会话，但已经有上一场的转写/笔记/总结，则本次“开始”视为新会议，先清空内容
    if (
      !session.isRunning &&
      (session.transcriptSegments.length > 0 || session.notes.length > 0 || session.aiSummary)
    ) {
      setSession((prev) => ({
        ...initialSession,
        // 保留部分配置，方便连续开会
        title: prev.title,
        audioSource: prev.audioSource,
        language: prev.language,
        aiTemplate: prev.aiTemplate,
      }));
      // 重置段落/笔记 ID，避免 React key 重复
      segmentIdRef.current = 1;
      noteIdRef.current = 1;
    }

    try {
      if (!navigator.mediaDevices) {
        throw new Error("当前浏览器不支持媒体设备采集");
      }
      if (!window.MediaRecorder) {
        // 不再依赖 MediaRecorder，保留此检查不作为阻断
      }

      const stream = await buildMixedStream();

      // 使用 WebAudio 捕获 PCM -> 每 5 秒编码 WAV 发送到后端
      captureBufferRef.current = [];
      pausedRef.current = false;

      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      captureAudioContextRef.current = audioContext;
      captureSampleRateRef.current = audioContext.sampleRate || 48000;

      const source = audioContext.createMediaStreamSource(stream);
      captureSourceRef.current = source;

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      captureProcessorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (pausedRef.current) return;
        const channelData = e.inputBuffer.getChannelData(0);
        // 拷贝一份，避免后续 buffer 复用导致数据被覆盖
        captureBufferRef.current.push(new Float32Array(channelData));
      };

      source.connect(processor);
      // 连接到 destination 才会触发 onaudioprocess
      processor.connect(audioContext.destination);

      // 定时 flush：拼接 -> 降采样到 16k -> WAV -> 发送
      if (captureFlushTimerRef.current) clearInterval(captureFlushTimerRef.current);
      captureFlushTimerRef.current = setInterval(async () => {
        try {
          if (pausedRef.current) return;
          const chunks = captureBufferRef.current;
          if (!chunks.length) return;
          captureBufferRef.current = [];

          let total = 0;
          for (const c of chunks) total += c.length;
          const merged = new Float32Array(total);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
          }

          const targetRate = 16000;
          const down = downsampleBuffer(merged, captureSampleRateRef.current, targetRate);
          const wavBlob = encodeWAV(down, targetRate);
          await sendChunkToBackend(wavBlob);
        } catch (err) {
          console.error("flush chunk error:", err);
        }
      }, 5000);

      const startedAt = Date.now();
      setSession((prev) => ({
        ...prev,
        startedAt,
        endedAt: null,
        isRunning: true,
        isPaused: false,
        aiSummary: "",
      }));
    } catch (err) {
      console.error("handleStart error:", err);
      setErrorMsg(err.message || "启动录音失败");
      stopAllTracks();
      setCaptureState({ mic: false, system: false, mode: "启动失败" });
      setSession((prev) => ({
        ...prev,
        isRunning: false,
        isPaused: false,
      }));
    }
  };

  const handlePause = () => {
    setErrorMsg("");
    try {
      pausedRef.current = true;
      setSession((prev) => ({ ...prev, isPaused: true }));
      setCaptureState((prev) => ({ ...prev, mode: "已暂停" }));
    } catch (err) {
      console.error("handlePause error:", err);
      setErrorMsg("暂停失败");
    }
  };

  const handleResume = () => {
    setErrorMsg("");
    try {
      pausedRef.current = false;
      setSession((prev) => ({ ...prev, isPaused: false }));
      setCaptureState((prev) => ({ ...prev, mode: "录音中" }));
    } catch (err) {
      console.error("handleResume error:", err);
      setErrorMsg("继续失败");
    }
  };

  const handleStop = async () => {
    setErrorMsg("");

    try {
      setLiveDraft("录音结束。正在处理最后一段音频（如有）...");
      pausedRef.current = true;

      // 停止前做一次 flush，把缓冲区剩余音频发出去
      const chunks = captureBufferRef.current;
      captureBufferRef.current = [];
      if (chunks.length) {
        let total = 0;
        for (const c of chunks) total += c.length;
        const merged = new Float32Array(total);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }
        const targetRate = 16000;
        const down = downsampleBuffer(merged, captureSampleRateRef.current, targetRate);
        const wavBlob = encodeWAV(down, targetRate);
        await sendChunkToBackend(wavBlob);
      }

      setSession((prev) => ({
        ...prev,
        isRunning: false,
        isPaused: false,
        endedAt: Date.now(),
      }));

      setCaptureState((prev) => ({ ...prev, mode: "已结束" }));
      stopAllTracks();
      setLiveDraft("");
    } catch (err) {
      console.error("handleStop error:", err);
      setErrorMsg(err.message || "结束转写失败");
      setSession((prev) => ({
        ...prev,
        isRunning: false,
            isPaused: false,
            endedAt: Date.now(),
          }));
      setCaptureState((prev) => ({ ...prev, mode: "结束异常" }));
      stopAllTracks();
      setLiveDraft("");
    }
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
    stopAllTracks();
    localStorage.removeItem(STORAGE_KEY);
    setSession(initialSession);
    setLiveDraft("");
    setErrorMsg("");
    setCaptureState({ mic: false, system: false, mode: "未开始" });
    // 重置各种计数/缓冲
    segmentIdRef.current = 1;
    noteIdRef.current = 1;
    captureBufferRef.current = [];
    pausedRef.current = false;
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
      setConnectState({
        loading: false,
        ok: false,
        msg: `校验失败：${e.message}`,
      });
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
            {
              role: "system",
              content: modelConfig.systemPrompt || "你是一个专业会议总结助手。",
            },
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
      <div
        style={{
          width: "min(1440px, calc(100% - 32px))",
          margin: "0 auto",
          padding: "20px 0 32px",
        }}
      >
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
            <h1
              style={{
                margin: "14px 0 8px",
                fontSize: "clamp(28px, 4vw, 42px)",
                lineHeight: 1.15,
              }}
            >
              实时转写 · 笔记 · 双报告输出
            </h1>
            <p style={{ margin: 0, color: theme.sub, lineHeight: 1.8 }}>
              面向会议、课堂、访谈、线上通话的信息记录工具。当前版本重点验证核心 workflow：
              音频配置 → 录音采集 → Whisper 转写 → AI 总结 → 报告导出。
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {session.isRunning && !session.isPaused && statusPill("#16a34a", "录音中")}
            {session.isRunning && session.isPaused && statusPill("#d97706", "已暂停")}
            {!session.isRunning && statusPill("#64748b", "空闲")}
          </div>
        </header>

        {errorMsg && (
          <div
            style={{
              marginBottom: 16,
              borderRadius: 16,
              border: "1px solid rgba(220,38,38,0.16)",
              background: "rgba(220,38,38,0.08)",
              color: "#b91c1c",
              padding: "12px 14px",
              lineHeight: 1.7,
              fontSize: 14,
            }}
          >
            {errorMsg}
          </div>
        )}

        <div
          className="grid-root"
          style={{
            display: "grid",
            gridTemplateColumns: "360px 1fr 360px",
            gap: 18,
          }}
        >
          <Panel title="会话配置" icon={<Settings size={18} />}>
            <Field label="会议标题">
              <input
                value={session.title}
                onChange={(e) =>
                  setSession((prev) => ({ ...prev, title: e.target.value }))
                }
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
                    onClick={() =>
                      setSession((prev) => ({ ...prev, audioSource: item.key }))
                    }
                    style={{
                      ...selectorStyle,
                      borderColor:
                        session.audioSource === item.key
                          ? "#0f172a"
                          : "rgba(15,23,42,0.08)",
                      background:
                        session.audioSource === item.key
                          ? "rgba(15,23,42,0.05)"
                          : "#fff",
                    }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {item.icon} {item.label}
                    </span>
                  </button>
                ))}
              </div>
            </Field>

            <Field label="转写语言">
              <select
                value={session.language}
                onChange={(e) =>
                  setSession((prev) => ({ ...prev, language: e.target.value }))
                }
                style={inputStyle}
              >
                <option value="zh">中文</option>
                <option value="en">英文</option>
              </select>
            </Field>

            <Field label="当前采集状态">
              <div style={{ display: "grid", gap: 8 }}>
                <InfoRow label="模式" value={captureState.mode} />
                <InfoRow label="麦克风" value={captureState.mic ? "已连接" : "未连接 / 未启用"} />
                <InfoRow label="系统音频" value={captureState.system ? "已连接" : "未连接 / 未启用"} />
                <InfoRow
                  label="转写方式"
                  value="每约 5 秒打包一次音频片段（WAV），实时发送到 FastAPI + Whisper 转写"
                />
              </div>
            </Field>

            <Field label="控制区">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
                <ActionButton
                  disabled={session.isRunning}
                  onClick={handleStart}
                  icon={<Play size={16} />}
                >
                  开始
                </ActionButton>
                <ActionButton
                  disabled={!session.isRunning || session.isPaused}
                  onClick={handlePause}
                  icon={<Pause size={16} />}
                >
                  暂停
                </ActionButton>
                <ActionButton
                  disabled={!session.isRunning || !session.isPaused}
                  onClick={handleResume}
                  icon={<Play size={16} />}
                >
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
                    desc="开始后会录制音频，结束时自动发送给后端 Whisper 转写。"
                  />
                )}

                {session.transcriptSegments.map((seg) => (
                  <div key={seg.id} style={segmentStyle}>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                      {tinyPill("#334155", seg.time)}
                      {tinyPill("#0369a1", seg.speaker || "说话人")}
                    </div>
                    <div style={{ lineHeight: 1.85, color: theme.text }}>{seg.text}</div>
                  </div>
                ))}

                {liveDraft && (
                  <motion.div
                    initial={{ opacity: 0.5 }}
                    animate={{ opacity: 1 }}
                    style={{ ...segmentStyle, borderStyle: "dashed" }}
                  >
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                      {tinyPill("#d97706", "处理中")}
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
                  <ActionButton onClick={addNote} icon={<Save size={16} />}>
                    保存笔记
                  </ActionButton>
                </div>
              </div>

              <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
                {session.notes.length === 0 ? (
                  <EmptyState
                    title="暂无个人笔记"
                    desc="会议过程中可随时记录个人想法，笔记不会污染原始转写。"
                  />
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
                  onChange={(e) =>
                    setModelConfig((prev) => ({ ...prev, baseUrl: e.target.value }))
                  }
                  style={inputStyle}
                  placeholder="例如：https://api.openai.com/v1"
                />
              </Field>
              <Field label="API Key">
                <input
                  type="password"
                  value={modelConfig.apiKey}
                  onChange={(e) =>
                    setModelConfig((prev) => ({ ...prev, apiKey: e.target.value }))
                  }
                  style={inputStyle}
                  placeholder="输入你的 API Key"
                />
              </Field>
              <Field label="模型名称">
                <input
                  value={modelConfig.model}
                  onChange={(e) =>
                    setModelConfig((prev) => ({ ...prev, model: e.target.value }))
                  }
                  style={inputStyle}
                  placeholder="例如：gpt-4o-mini / deepseek-chat"
                />
              </Field>
              <Field label="系统提示词（可选）">
                <textarea
                  rows={3}
                  value={modelConfig.systemPrompt}
                  onChange={(e) =>
                    setModelConfig((prev) => ({
                      ...prev,
                      systemPrompt: e.target.value,
                    }))
                  }
                  style={{ ...inputStyle, resize: "vertical" }}
                  placeholder="例如：你是一个专业会议总结助手。"
                />
              </Field>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <ActionButton onClick={testConnection} icon={<CheckCircle2 size={16} />}>
                  {connectState.loading ? "校验中..." : "连通性校验"}
                </ActionButton>
              </div>
              <div
                style={{
                  marginTop: 12,
                  color: connectState.ok ? "#15803d" : "#64748b",
                  fontSize: 13,
                  lineHeight: 1.7,
                }}
              >
                {connectState.msg}
              </div>
            </Panel>

            <Panel title="AI 总结" icon={<Sparkles size={18} />}>
              <Field label="总结模板">
                <select
                  value={session.aiTemplate}
                  onChange={(e) =>
                    setSession((prev) => ({ ...prev, aiTemplate: e.target.value }))
                  }
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
              <div style={{ marginTop: 10, fontSize: 13, color: theme.sub }}>
                {summaryState.msg}
              </div>
            </Panel>

            <Panel title="报告导出" icon={<Download size={18} />}>
              <div style={{ display: "grid", gap: 10 }}>
                <ActionButton
                  full
                  onClick={() =>
                    downloadFile(
                      `${session.title || "meeting"}_transcript.txt`,
                      transcriptText || "暂无转写"
                    )
                  }
                  icon={<Download size={16} />}
                >
                  导出转写 TXT（仅内容）
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
                  导出转写 Markdown 报告
                </ActionButton>
                <ActionButton
                  full
                  subtle
                  onClick={() =>
                    downloadFile(
                      `${session.title || "meeting"}_summary.txt`,
                      buildSummaryReport(session),
                      "text/plain;charset=utf-8"
                    )
                  }
                  icon={<Download size={16} />}
                >
                  导出 AI 总结 TXT
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
      <div style={{ marginBottom: 8, fontSize: 13, color: "#475569", fontWeight: 600 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  icon,
  full = false,
  subtle = false,
  danger = false,
  disabled = false,
}) {
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