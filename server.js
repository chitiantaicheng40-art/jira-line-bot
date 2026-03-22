require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ===== LINE設定 =====
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// ===== Jira設定 =====
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;

// ===== LINE署名検証 =====
function validateSignature(req) {
  const signature = req.headers["x-line-signature"];
  const body = JSON.stringify(req.body);

  const hash = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(body)
    .digest("base64");

  return hash === signature;
}

// ===== LINE返信 =====
async function replyLine(replyToken, message) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [{ type: "text", text: message }],
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ===== メッセージ解析（超重要：修正版）=====
function parseMessage(text) {
  // 👇 ここが今回の核心修正
  const cleaned = text.replace(/\n/g, "").trim();
  const parts = cleaned.split("|").map((p) => p.trim());

  if (parts.length !== 6) {
    throw new Error("形式: プロジェクト | 種別 | 件名 | 期限 | 担当 | 詳細");
  }

  return {
    projectKey: parts[0],
    issueType: parts[1],
    summary: parts[2],
    dueDate: parts[3],
    assignee: parts[4],
    description: parts[5],
  };
}

// ===== Jira作成 =====
async function createJira(task) {
  const auth = Buffer.from(
    `${JIRA_EMAIL}:${JIRA_API_TOKEN}`
  ).toString("base64");

  const response = await axios.post(
    `${JIRA_BASE_URL}/rest/api/3/issue`,
    {
      fields: {
        project: { key: task.projectKey },
        summary: task.summary,
        description: task.description,
        issuetype: { name: task.issueType },
      },
    },
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data;
}

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  try {
    if (!validateSignature(req)) {
      return res.status(401).send("Invalid signature");
    }

    const events = req.body.events;

    for (const e of events) {
      if (e.type !== "message") continue;

      // 👇 デバッグ（今回の原因特定用）
      console.log("RAW TEXT:", JSON.stringify(e.message.text));

      try {
        const task = parseMessage(e.message.text);
        const result = await createJira(task);

        console.log("Created Jira issue:", result.key);

        await replyLine(e.replyToken, `作成成功: ${result.key}`);
      } catch (err) {
        console.error("ERROR:", err.message);
        await replyLine(e.replyToken, `失敗: ${err.message}`);
      }
    }

    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// ===== 起動 =====
app.listen(PORT, () => {
  console.log("Server running:", PORT);
});
