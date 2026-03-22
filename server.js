require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER_ID_DEFAULT = process.env.LINE_USER_ID_DEFAULT;

const LINE_USER_MAP = {
  "池田太晟": "Uba56ca108dd44ab8cd3b044670958c34",
  "池田 太晟": "Uba56ca108dd44ab8cd3b044670958c34",
  "金澤": "U743062d8c9d606c8a30c971bf1a650c5",
  "金澤将一": "U743062d8c9d606c8a30c971bf1a650c5",
  "金澤 将一": "U743062d8c9d606c8a30c971bf1a650c5"
};

function resolveUserId(name) {
  if (!name) return LINE_USER_ID_DEFAULT;

  const normalized = name.trim();

  if (LINE_USER_MAP[normalized]) {
    return LINE_USER_MAP[normalized];
  }

  if (normalized.includes("金澤")) {
    return LINE_USER_MAP["金澤将一"];
  }

  if (normalized.includes("池田")) {
    return LINE_USER_MAP["池田太晟"];
  }

  return LINE_USER_ID_DEFAULT;
}

async function pushLineMessage(to, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      to,
      messages: [
        {
          type: "text",
          text
        }
      ]
    })
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`LINE push failed: ${res.status} ${body}`);
  }
  return body;
}

app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

app.post("/line/webhook", (req, res) => {
  console.log("=== LINE WEBHOOK ===");
  console.log(JSON.stringify(req.body, null, 2));
  res.status(200).end();
});

app.post("/jira", async (req, res) => {
  try {
    const body = req.body || {};

    console.log("Jira webhook received:", body);

    const issueKey = body.issueKey || "NO-KEY";
    const summary = body.summary || "";
    const assignee = body.assignee || "";
    const priority = body.priority || "-";
    const status = body.status || "-";
    const dueDate = body.dueDate || "-";
    const url = body.url || "";

    const targetLineUserId = resolveUserId(assignee);

    console.log("assignee =", assignee);
    console.log("targetLineUserId =", targetLineUserId);

    const message = [
      "【Jira通知】",
      `${issueKey} ${summary}`,
      `担当: ${assignee || "未設定"}`,
      `優先度: ${priority}`,
      `状態: ${status}`,
      `期限: ${dueDate}`,
      "",
      url
    ].join("\n");

    await pushLineMessage(targetLineUserId, message);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Jira LINE bot listening on port ${PORT}`);
});
