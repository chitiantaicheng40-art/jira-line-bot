require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 環境変数 =====
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_USER_ID = process.env.LINE_USER_ID;

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// ===== Middleware =====
app.use("/webhook", express.json());
app.use("/callback", express.raw({ type: "*/*" }));

app.get("/", (req, res) => res.send("OK"));

// ===== LINE署名検証 =====
function validateLineSignature(body, signature) {
  const hash = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hash === signature;
}

// ===== 名前 → Jira accountId =====
const ASSIGNEE_MAP = {
  "池田太晟": "712020:49c2350d-16fc-457e-8b2b-159df43d77ad",
  "金澤将一": "6121089528ae75006afc73b3",
};

// ===== 名前 → LINE userId =====
const LINE_USER_MAP = {
  "池田太晟": "Uba56ca108dd44ab8cd3b044670958c34",
  "金澤将一": "U743062d8c9d606c8a30c971bf1a650c5",
};

// ===== LINE送信 =====
async function pushLineMessageTo(userId, text) {
  if (!userId) return;

  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: userId,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ===== LINE返信 =====
async function replyLineMessage(replyToken, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ===== Jira作成 =====
async function createJiraIssueFromText(rawText) {
  const parts = rawText.split("|");
  if (parts.length < 6) {
    throw new Error("形式エラー");
  }

  const [projectKey, issueType, summary, dueDate, assigneeName, description] = parts;

  const assigneeAccountId = ASSIGNEE_MAP[assigneeName];
  if (!assigneeAccountId) {
    throw new Error(`担当者が見つかりません: ${assigneeName}`);
  }

  const fields = {
    project: { key: projectKey },
    summary,
    issuetype: { name: issueType },
    duedate: dueDate,
    assignee: { accountId: assigneeAccountId },
  };

  if (projectKey === "OPS") {
    fields.customfield_10118 = description;
  }

  const res = await axios.post(
    `${JIRA_BASE_URL}/rest/api/3/issue`,
    { fields },
    {
      auth: {
        username: JIRA_EMAIL,
        password: JIRA_API_TOKEN,
      },
    }
  );

  return res.data;
}

// ===== LINE → Jira =====
app.post("/callback", async (req, res) => {
  const signature = req.headers["x-line-signature"];
  const rawBody = req.body;

  if (!validateLineSignature(rawBody, signature)) {
    return res.status(401).send("Invalid signature");
  }

  const body = JSON.parse(rawBody.toString("utf8"));

  for (const event of body.events) {
    if (event.type !== "message") continue;

    const text = event.message.text;

    try {
      const jira = await createJiraIssueFromText(text);
      await replyLineMessage(event.replyToken, `作成成功: ${jira.key}`);
    } catch (e) {
      await replyLineMessage(event.replyToken, `エラー: ${e.message}`);
    }
  }

  res.send("OK");
});

// ===== Jira → LINE通知 =====
app.post("/webhook", async (req, res) => {
  const { issueKey, summary, assignee, priority, status } = req.body;

  const message =
`【期限超過タスク⚠️】
キー: ${issueKey}
タイトル: ${summary}
担当者: ${assignee}
優先度: ${priority}
ステータス: ${status}`;

  const targets = new Set();

  // 固定通知
  if (LINE_USER_ID) targets.add(LINE_USER_ID);

  // 担当者通知
  const userId = LINE_USER_MAP[assignee];
  if (userId) targets.add(userId);

  for (const id of targets) {
    await pushLineMessageTo(id, message);
  }

  res.send("OK");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
