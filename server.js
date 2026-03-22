require("dotenv").config();
const express = require("express");
const crypto = require("crypto");

const app = express();

// raw body for LINE signature
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const PORT = process.env.PORT || 10000;

// ===== ENV =====
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || "").trim().replace(/\/+$/, "");
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// ===== MAP =====
const PROJECT_MAP = {
  OPS: "OPS",
  PRODUCT: "PRODUCT",
  SALES: "SALES",
  契約状況: "契約状況",
};

// 担当は一旦なしでもOK
const JIRA_USER_MAP = {};

// ===== LINE署名 =====
function verifyLineSignature(req) {
  const signature = req.headers["x-line-signature"];
  if (!signature) return false;

  const hash = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(req.rawBody)
    .digest("base64");

  return signature === hash;
}

// ===== LINE返信 =====
async function replyLine(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

// ===== パース =====
function parseMessage(text) {
  const parts = text.split("｜");

  if (parts.length < 6) {
    throw new Error("形式: プロジェクト｜種別｜件名｜期限｜担当｜詳細");
  }

  return {
    projectKey: PROJECT_MAP[parts[0]] || parts[0],
    issueType: parts[1],
    summary: parts[2],
    dueDate: parts[3],
    description: parts.slice(5).join("｜"),
  };
}

// ===== Jira作成 =====
async function createJira(task) {
  const url = `${JIRA_BASE_URL}/rest/api/3/issue`;

  console.log("JIRA URL =", url);

  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      fields: {
        project: { key: task.projectKey },
        summary: task.summary,
        issuetype: { name: task.issueType },
        duedate: task.dueDate,
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: task.description }],
            },
          ],
        },
      },
    }),
  });

  const text = await res.text();
  console.log("Jira status =", res.status);
  console.log("Jira body =", text);

  if (!res.ok) {
    throw new Error(text);
  }

  return JSON.parse(text);
}

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  try {
    console.log("=== LINE WEBHOOK ===");

    if (!verifyLineSignature(req)) {
      return res.status(401).send("invalid");
    }

    const events = req.body.events || [];

    for (const e of events) {
      if (e.type !== "message") continue;

      try {
        const task = parseMessage(e.message.text);
        const result = await createJira(task);

        await replyLine(e.replyToken, `作成成功: ${result.key}`);
      } catch (err) {
        console.error(err.message);
        await replyLine(e.replyToken, `失敗: ${err.message}`);
      }
    }

    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log("Server running:", PORT);
});
