/**
 * POST /api/name  —  流式生成起名方案，并把结果写入 Supabase
 * GET  /api/name  —  返回可用模型列表
 *
 * 环境变量：
 *   SILICONFLOW_API_KEY       硅基流动 API Key（必填）
 *   SILICONFLOW_BASE_URL      接口地址，默认 https://api.siliconflow.cn/v1
 *   SUPABASE_URL              Supabase 项目地址
 *   SUPABASE_SERVICE_ROLE_KEY Supabase service_role 密钥（仅服务端）
 */

const MODELS = {
  "qwen2.5-7b": {
    label: "Qwen2.5 7B · 稳定",
    model: "Qwen/Qwen2.5-7B-Instruct",
  },
  "qwen3-8b": {
    label: "Qwen3 8B · 文采",
    model: "Qwen/Qwen3-8B",
    extra: { enable_thinking: false },
  },
  "deepseek-v3": {
    label: "DeepSeek V3 · 深度",
    model: "deepseek-ai/DeepSeek-V3",
  },
};

const DEFAULT_MODEL_KEY = "qwen2.5-7b";
const SYSTEM_PROMPT =
  "你是一位精通汉语音韵、字义训诂与古典典故的中文起名专家。你的表达温润、克制、有文采，只谈起名。";

export const config = { maxDuration: 60 };

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function buildPrompt({ surname, gender, style, requirement }) {
  return [
    "请根据下面的需求，创作 3 组中文名字方案。",
    "",
    `【姓氏】${surname || "未指定，请给出 3 个「名」（不含姓），并说明适合搭配的姓氏类型"}`,
    `【性别倾向】${gender || "不限"}`,
    `【风格偏好】${style || "不限"}`,
    `【其他需求】${requirement}`,
    "",
    "输出要求：",
    "1. 恰好 3 组方案，按「方案一」「方案二」「方案三」分段。",
    "2. 每组包含四项：",
    "   - 名字（有姓氏时写完整姓名）",
    "   - 读音：拼音与声调，说明平仄搭配",
    "   - 寓意：结合字义、出处或典故，2-3 句",
    "   - 气质：适合的性格或使用场景",
    "3. 使用纯文本，不要使用 Markdown 表格、代码块、星号或井号。",
    "4. 避免生僻字与过度堆砌，语言自然流畅。",
    "5. 不要输出思考过程或与起名无关的内容。",
  ].join("\n");
}

async function saveRecord({ surname, gender, style, requirement, result, model }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return { saved: false, reason: "Supabase 环境变量未配置" };

  try {
    const resp = await fetch(`${url.replace(/\/$/, "")}/rest/v1/naming_records`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        surname: surname || null,
        gender: gender || null,
        style: style || null,
        requirement,
        result,
        model,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      console.error("Supabase insert failed:", resp.status, await resp.text());
      return { saved: false, reason: `Supabase 写入失败（${resp.status}）` };
    }

    const rows = await resp.json();
    return { saved: true, id: rows?.[0]?.id };
  } catch (err) {
    console.error("Supabase insert error:", err);
    return { saved: false, reason: "Supabase 写入异常" };
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return json(res, 200, {
      models: Object.entries(MODELS).map(([key, cfg]) => ({
        key,
        label: cfg.label,
        model: cfg.model,
      })),
      defaultModel: DEFAULT_MODEL_KEY,
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: "仅支持 GET 与 POST" });
  }

  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    return json(res, 500, { error: "服务端未配置 SILICONFLOW_API_KEY" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return json(res, 400, { error: "请求体不是合法的 JSON" });
    }
  }
  if (!body || typeof body !== "object") {
    return json(res, 400, { error: "缺少起名参数" });
  }

  const requirement = String(body.requirement || "").trim();
  const surname = String(body.surname || "").trim();
  const gender = String(body.gender || "").trim();
  const style = String(body.style || "").trim();
  const modelKey = String(body.model || "").trim() || DEFAULT_MODEL_KEY;

  if (!requirement) {
    return json(res, 400, { error: "请先填写起名需求" });
  }
  if (requirement.length > 500) {
    return json(res, 400, { error: "起名需求请控制在 500 字以内" });
  }
  if (surname.length > 4 || gender.length > 10 || style.length > 100) {
    return json(res, 400, { error: "参数长度超出限制" });
  }

  const modelConfig = MODELS[modelKey];
  if (!modelConfig) {
    return json(res, 400, { error: "未知的模型" });
  }

  const baseUrl = (process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  let upstream;
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelConfig.model,
        stream: true,
        temperature: 0.8,
        top_p: 0.9,
        max_tokens: 1600,
        ...modelConfig.extra,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildPrompt({ surname, gender, style, requirement }) },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const message = err?.name === "AbortError" ? "模型响应超时" : "无法连接模型服务";
    return json(res, 502, { error: message });
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timer);
    const detail = await upstream.text().catch(() => "");
    console.error("SiliconFlow error:", upstream.status, detail);
    return json(res, 502, {
      error: `模型调用失败（${upstream.status}）`,
      detail: detail.slice(0, 300),
    });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const send = (payload) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  let fullText = "";
  try {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          send({ type: "delta", text: delta });
        }
      }
    }

    if (!fullText.trim()) {
      send({ type: "error", message: "模型没有返回内容，请重试" });
      return res.end();
    }

    const saved = await saveRecord({
      surname,
      gender,
      style,
      requirement,
      result: fullText,
      model: modelConfig.model,
    });

    send({ type: "done", saved: saved.saved, recordId: saved.id || null, reason: saved.reason || null });
    res.end();
  } catch (err) {
    console.error("Stream error:", err);
    send({ type: "error", message: "生成过程中断，请重试" });
    res.end();
  } finally {
    clearTimeout(timer);
  }
}
