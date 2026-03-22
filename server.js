require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ===== 環境変数 =====
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// ===== OPS専用カスタムフィールド =====
const ACTION_FIELD_ID = "customfield_10118";

// ===== 認証 =====
function getJiraHeaders() {
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  return {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}

// ===== LINE返信 =====
async function replyLine(replyToken, message) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [
        {
          type: "text",
          text: message
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ===== ADF形式のdescription作成 =====
function buildDescriptionADF(text) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: text || ""
          }
        ]
      }
    ]
  };
}

// ===== メッセージ解析 =====
function parseMessage(text) {
  const parts = text.trim().split("|").map((p) => p.trim());

  if (parts.length < 6) {
    throw new Error("形式: プロジェクト | 種別 | 件名 | 期限 | 担当 | 詳細");
  }

  return {
    projectKey: parts[0],
    issueType: parts[1],
    summary: parts[2],
    dueDate: parts[3],
    assignee: parts[4],
    description: parts[5]
  };
}

// ===== 担当者取得（完全一致のみ）=====
async function resolveAssigneeAccountId(query) {
  if (!query) return null;

  const res = await axios.get(
    `${JIRA_BASE_URL}/rest/api/3/user/search`,
    {
      headers: getJiraHeaders(),
      params: { query }
    }
  );

  const users = res.data || [];

  const exactUser = users.find(
    (u) => (u.displayName || "").trim() === query.trim()
  );

  if (!exactUser) {
    throw new Error(`担当者が見つかりません: ${query}`);
  }

  return exactUser.accountId;
}

// ===== Jira作成 =====
async function createJira(task) {
  const fields = {
    project: { key: task.projectKey },
    summary: task.summary,
    issuetype: { name: task.issueType },
    duedate: task.dueDate
  };

  // OPSだけ「アクション内容」に入れる
  if (task.projectKey === "OPS") {
    fields[ACTION_FIELD_ID] = task.description || "";
  } else {
    // OPS以外は通常のdescriptionに入れる
    fields.description = buildDescriptionADF(task.description);
  }

  if (task.assignee) {
    const accountId = await resolveAssigneeAccountId(task.assignee);
    fields.assignee = { accountId };
  }

  console.log("JIRA CREATE FIELDS:", JSON.stringify(fields, null, 2));

  const res = await axios.post(
    `${JIRA_BASE_URL}/rest/api/3/issue`,
    { fields },
    { headers: getJiraHeaders() }
  );

  console.log("JIRA CREATE OK:", res.data);

  return res.data;
}

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];

  for (const e of events) {
    if (e.type !== "message") continue;
    if (!e.message || e.message.type !== "text") continue;

    try {
      console.log("RAW TEXT:", e.message.text);

      const task = parseMessage(e.message.text);
      const result = await createJira(task);

      await replyLine(e.replyToken, `作成成功: ${result.key}`);
    } catch (err) {
      console.error("ERROR MESSAGE:", err.message);
      console.error(
        "ERROR DATA:",
        JSON.stringify(err.response?.data, null, 2)
      );

      try {
        await replyLine(e.replyToken, `失敗: ${err.message}`);
      } catch (replyErr) {
        console.error("LINE REPLY ERROR:", replyErr.message);
        console.error(
          "LINE REPLY ERROR DATA:",
          JSON.stringify(replyErr.response?.data, null, 2)
        );
      }
    }
  }

  res.status(200).end();
});

// ===== 起動 =====
app.listen(PORT, () => {
  console.log("Server running:", PORT);
});
